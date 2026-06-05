import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import fsSync, { createWriteStream } from "fs";
import fs from "fs/promises";
import path from "path";
import type { Express } from "express";
import { Types } from "mongoose";
import { ProjectModel } from "../models/Project";
import { RunModel } from "../models/Run";
import { WorkflowModel } from "../models/Workflow";
import type { RunStep, StoredFile, WorkflowEdge, WorkflowNode, WorkflowOutputDefinition } from "../types/domain";
import { HttpError } from "../utils/httpError";
import { previewTypeForPath } from "../utils/preview";
import { workflowGraphSchema } from "../utils/validation";
import { repairWorkflowGraphHandles } from "../utils/workflowHandles";
import { fileStorageService, sanitizeFileName } from "./fileStorage.service";
import { socketService } from "./socket.service";

interface StartRunInput {
  userId: string;
  workflowId: string;
  selectedInputs: Record<string, string>;
  uploadedFiles: Express.Multer.File[];
  params: Record<string, string | number | boolean>;
}

interface RunDirs {
  runDir: string;
  inputDir: string;
  outputDir: string;
  tempDir: string;
  logsDir: string;
}

class CancelledRunError extends Error {
  constructor() {
    super("Run cancelled");
  }
}

class CommandFailedError extends Error {
  constructor(
    message: string,
    public exitCode?: number | null
  ) {
    super(message);
  }
}

class WorkflowRunnerService {
  private activeChildren = new Map<string, ChildProcessWithoutNullStreams>();
  private cancelledRuns = new Set<string>();

  async startRun(input: StartRunInput) {
    const workflow = await WorkflowModel.findOne({ _id: input.workflowId, userId: input.userId }).lean();
    if (!workflow) {
      throw new HttpError(404, "Workflow not found");
    }

    const project = await ProjectModel.findOne({ _id: workflow.projectId, userId: input.userId }).select("_id").lean();
    if (!project) {
      throw new HttpError(404, "Project not found");
    }

    const parsedGraph = repairWorkflowGraphHandles(workflowGraphSchema.parse({ nodes: workflow.nodes, edges: workflow.edges }));
    const executionOrder = this.resolveExecutionOrder(parsedGraph.nodes, parsedGraph.edges);
    const steps: RunStep[] = executionOrder.map((node) => ({
      nodeId: node.id,
      label: node.label,
      status: "waiting"
    }));

    const run = await RunModel.create({
      userId: new Types.ObjectId(input.userId),
      projectId: workflow.projectId,
      workflowId: workflow._id,
      status: "pending",
      inputFiles: [],
      outputFiles: [],
      steps,
      params: input.params
    });

    const runId = String(run._id);
    socketService.emitToRun(runId, "run:created", { runId, status: "pending" });

    const dirs = await fileStorageService.createRunDirs(input.userId, String(workflow.projectId), runId);
    const inputFiles = await this.prepareInputFiles(input.userId, dirs.inputDir, input.selectedInputs, input.uploadedFiles);

    await RunModel.updateOne(
      { _id: runId, userId: input.userId },
      {
        $set: {
          status: "running",
          startedAt: new Date(),
          workingDir: fileStorageService.relativeFromAbsolute(dirs.runDir),
          inputFiles
        }
      }
    );

    socketService.emitToRun(runId, "run:status", { runId, status: "running", startedAt: new Date() });
    void this.executeRun({
      runId,
      userId: input.userId,
      nodes: parsedGraph.nodes,
      edges: parsedGraph.edges,
      executionOrder,
      inputFiles,
      dirs,
      params: input.params
    });

    return RunModel.findOne({ _id: runId, userId: input.userId }).lean();
  }

  async cancelRun(userId: string, runId: string) {
    const run = await RunModel.findOne({ _id: runId, userId }).lean();
    if (!run) {
      throw new HttpError(404, "Run not found");
    }

    this.cancelledRuns.add(runId);
    const child = this.activeChildren.get(runId);
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }

    const steps = (run.steps || []).map((step) =>
      ["waiting", "running"].includes(step.status)
        ? { ...step, status: "cancelled", finishedAt: new Date(), errorMessage: "Run cancelled" }
        : step
    );

    await RunModel.updateOne(
      { _id: runId, userId },
      { $set: { status: "cancelled", finishedAt: new Date(), steps, errorMessage: "Run cancelled" } }
    );
    socketService.emitToRun(runId, "run:finished", { runId, status: "cancelled" });
    return RunModel.findOne({ _id: runId, userId }).lean();
  }

  private async prepareInputFiles(
    userId: string,
    inputDir: string,
    selectedInputs: Record<string, string>,
    uploadedFiles: Express.Multer.File[]
  ): Promise<StoredFile[]> {
    const inputFiles: StoredFile[] = [];

    for (const [inputName, relativePath] of Object.entries(selectedInputs)) {
      if (relativePath) {
        inputFiles.push(await fileStorageService.copySelectedInput(userId, relativePath, inputDir, inputName));
      }
    }

    for (const file of uploadedFiles) {
      const inputName = file.fieldname === "files" ? path.parse(file.originalname).name : file.fieldname;
      inputFiles.push(await fileStorageService.saveRunUpload(inputDir, inputName, file));
    }

    return inputFiles;
  }

  private async executeRun(input: {
    runId: string;
    userId: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    executionOrder: WorkflowNode[];
    inputFiles: StoredFile[];
    dirs: RunDirs;
    params: Record<string, string | number | boolean>;
  }) {
    const nodeOutputs = new Map<string, Record<string, string>>();
    const nodeOutputFiles = new Map<string, StoredFile[]>();
    const initialInputs = new Map(input.inputFiles.map((file) => [file.name, file.relativePath]));
    const runOutputFiles: StoredFile[] = [];

    try {
      for (const node of input.executionOrder) {
        await this.throwIfCancelled(input.runId);
        const stepIndex = input.executionOrder.findIndex((candidate) => candidate.id === node.id);
        if (node.type === "fileInput") {
          let fileInputOutputs: Record<string, string>;
          try {
            fileInputOutputs = this.resolveFileInputNode(node, initialInputs);
          } catch (error) {
            await this.updateStep(input.runId, input.userId, stepIndex, {
              status: "failed",
              startedAt: new Date(),
              finishedAt: new Date(),
              errorMessage: error instanceof Error ? error.message : "Input module failed"
            });
            socketService.emitToRun(input.runId, "step:status", {
              runId: input.runId,
              nodeId: node.id,
              status: "failed",
              errorMessage: error instanceof Error ? error.message : "Input module failed"
            });
            throw error;
          }
          await this.updateStep(input.runId, input.userId, stepIndex, {
            status: "success",
            startedAt: new Date(),
            finishedAt: new Date(),
            outputs: fileInputOutputs
          });
          nodeOutputs.set(node.id, fileInputOutputs);
          socketService.emitToRun(input.runId, "step:status", {
            runId: input.runId,
            nodeId: node.id,
            status: "success"
          });
          continue;
        }
        let resolvedInputs: Record<string, string>;
        try {
          resolvedInputs = this.resolveNodeInputs(node, input.edges, nodeOutputs, initialInputs);
        } catch (error) {
          await this.updateStep(input.runId, input.userId, stepIndex, {
            status: "failed",
            startedAt: new Date(),
            finishedAt: new Date(),
            errorMessage: error instanceof Error ? error.message : "Input resolution failed"
          });
          socketService.emitToRun(input.runId, "step:status", {
            runId: input.runId,
            nodeId: node.id,
            status: "failed",
            errorMessage: error instanceof Error ? error.message : "Input resolution failed"
          });
          throw error;
        }
        const resolvedOutputs = this.buildNodeOutputs(node, input.dirs.outputDir);
        await this.runNode({
          runId: input.runId,
          userId: input.userId,
          node,
          stepIndex,
          dirs: input.dirs,
          resolvedInputs,
          resolvedOutputs,
          params: { ...(node.defaultParams || {}), ...input.params }
        });

        nodeOutputs.set(node.id, resolvedOutputs.relativeByName);
        const outputFiles = this.outputFilesForNode(node, resolvedOutputs.relativeByName);
        nodeOutputFiles.set(node.id, outputFiles);
        runOutputFiles.push(...outputFiles);

        await RunModel.updateOne(
          { _id: input.runId, userId: input.userId },
          { $set: { outputFiles: runOutputFiles } }
        );
        for (const file of outputFiles) {
          socketService.emitToRun(input.runId, "step:output", { runId: input.runId, nodeId: node.id, file });
        }
      }

      await RunModel.updateOne(
        { _id: input.runId, userId: input.userId },
        { $set: { status: "success", finishedAt: new Date(), outputFiles: runOutputFiles } }
      );
      await this.writeManifest(input.runId, input.dirs.runDir);
      socketService.emitToRun(input.runId, "run:finished", { runId: input.runId, status: "success" });
    } catch (error) {
      const status = error instanceof CancelledRunError ? "cancelled" : "failed";
      await RunModel.updateOne(
        { _id: input.runId, userId: input.userId },
        {
          $set: {
            status,
            finishedAt: new Date(),
            errorMessage: error instanceof Error ? error.message : "Workflow run failed"
          }
        }
      );
      await this.writeManifest(input.runId, input.dirs.runDir).catch(() => undefined);
      socketService.emitToRun(input.runId, "run:error", {
        runId: input.runId,
        status,
        message: error instanceof Error ? error.message : "Workflow run failed"
      });
      socketService.emitToRun(input.runId, "run:finished", { runId: input.runId, status });
    } finally {
      this.activeChildren.delete(input.runId);
      this.cancelledRuns.delete(input.runId);
    }
  }

  private async runNode(input: {
    runId: string;
    userId: string;
    node: WorkflowNode;
    stepIndex: number;
    dirs: RunDirs;
    resolvedInputs: Record<string, string>;
    resolvedOutputs: {
      absoluteByName: Record<string, string>;
      relativeByName: Record<string, string>;
    };
    params: Record<string, string | number | boolean>;
  }) {
    const logFileName = `${sanitizeFileName(input.node.id || input.node.label)}.log`;
    const logPath = path.join(input.dirs.logsDir, logFileName);
    const relativeLogPath = fileStorageService.relativeFromAbsolute(logPath);
    const templateScope = {
      inputs: this.absoluteMap(input.resolvedInputs),
      outputs: input.resolvedOutputs.absoluteByName,
      params: input.params,
      runDir: input.dirs.runDir,
      inputDir: input.dirs.inputDir,
      outputDir: input.dirs.outputDir,
      tempDir: input.dirs.tempDir
    };

    await this.updateStep(input.runId, input.userId, input.stepIndex, {
      status: "running",
      startedAt: new Date(),
      inputs: input.resolvedInputs,
      outputs: input.resolvedOutputs.relativeByName,
      logPath: relativeLogPath
    });
    socketService.emitToRun(input.runId, "step:status", {
      runId: input.runId,
      nodeId: input.node.id,
      status: "running"
    });

    try {
      const bin = this.resolveTemplate(input.node.toolConfig.bin, templateScope, `node "${input.node.label}" command`);
      const args = (input.node.toolConfig.args || []).map((arg) =>
        this.resolveTemplate(arg, templateScope, `node "${input.node.label}" argument "${arg}"`)
      );
      const commandEnv = Object.fromEntries(
        Object.entries(input.node.toolConfig.env || {}).map(([key, value]) => [
          key,
          this.resolveTemplate(String(value), templateScope, `node "${input.node.label}" env "${key}"`)
        ])
      );
      const cwdTemplate = input.node.toolConfig.workingDir
        ? this.resolveTemplate(input.node.toolConfig.workingDir, templateScope, `node "${input.node.label}" working directory`)
        : process.cwd();
      const cwd = path.isAbsolute(cwdTemplate) ? cwdTemplate : path.resolve(process.cwd(), cwdTemplate);

      await this.updateStep(input.runId, input.userId, input.stepIndex, {
        command: bin,
        args
      });
      socketService.emitToRun(input.runId, "step:status", {
        runId: input.runId,
        nodeId: input.node.id,
        status: "running",
        command: bin,
        args
      });

      await this.spawnAndStream({
        runId: input.runId,
        nodeId: input.node.id,
        bin,
        args,
        cwd,
        env: commandEnv,
        timeoutSeconds: input.node.toolConfig.timeoutSeconds,
        logPath
      });

      await Promise.all(
        Object.values(input.resolvedOutputs.absoluteByName).map(async (absolutePath) => {
          try {
            await fs.access(absolutePath, fsSync.constants.F_OK);
          } catch {
            throw new Error(`Declared output file was not created: ${absolutePath}`);
          }
        })
      );

      await this.updateStep(input.runId, input.userId, input.stepIndex, {
        status: "success",
        finishedAt: new Date(),
        exitCode: 0
      });
      socketService.emitToRun(input.runId, "step:status", {
        runId: input.runId,
        nodeId: input.node.id,
        status: "success"
      });
    } catch (error) {
      const status = error instanceof CancelledRunError ? "cancelled" : "failed";
      const exitCode = error instanceof CommandFailedError ? error.exitCode : undefined;
      const message = `[runner] step failed: ${error instanceof Error ? error.message : "Step failed"}\n`;
      await fs.appendFile(logPath, message).catch(() => undefined);
      socketService.emitToRun(input.runId, "step:log", {
        runId: input.runId,
        nodeId: input.node.id,
        stream: "stderr",
        message,
        timestamp: new Date().toISOString()
      });
      await this.updateStep(input.runId, input.userId, input.stepIndex, {
        status,
        finishedAt: new Date(),
        exitCode,
        errorMessage: error instanceof Error ? error.message : "Step failed"
      });
      socketService.emitToRun(input.runId, "step:status", {
        runId: input.runId,
        nodeId: input.node.id,
        status,
        errorMessage: error instanceof Error ? error.message : "Step failed"
      });
      throw error;
    }
  }

  private spawnAndStream(input: {
    runId: string;
    nodeId: string;
    bin: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    timeoutSeconds?: number;
    logPath: string;
  }) {
    return new Promise<void>((resolve, reject) => {
      const logStream = createWriteStream(input.logPath, { flags: "a" });
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;

      const emitRunnerLog = (stream: "stdout" | "stderr", message: string) => {
        logStream.write(message);
        socketService.emitToRun(input.runId, "step:log", {
          runId: input.runId,
          nodeId: input.nodeId,
          stream,
          message,
          timestamp: new Date().toISOString()
        });
      };

      emitRunnerLog("stdout", `[runner] cwd: ${input.cwd}\n`);
      emitRunnerLog("stdout", `[runner] command: ${JSON.stringify([input.bin, ...input.args])}\n`);

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(input.bin, input.args, {
          cwd: input.cwd,
          shell: false,
          env: {
            ...process.env,
            ...input.env
          }
        });
      } catch (error) {
        const message = `[runner] spawn error: ${error instanceof Error ? error.message : "Unable to start command"}\n`;
        emitRunnerLog("stderr", message);
        logStream.end();
        reject(error);
        return;
      }

      this.activeChildren.set(input.runId, child);

      const onChunk = (stream: "stdout" | "stderr", chunk: Buffer) => {
        emitRunnerLog(stream, chunk.toString());
      };

      child.stdout.on("data", (chunk: Buffer) => onChunk("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => onChunk("stderr", chunk));

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        emitRunnerLog("stderr", `[runner] spawn error: ${error.message}\n`);
        logStream.end();
        this.activeChildren.delete(input.runId);
        reject(error);
      });

      child.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        this.activeChildren.delete(input.runId);

        if (this.cancelledRuns.has(input.runId)) {
          emitRunnerLog("stderr", "[runner] command cancelled\n");
          logStream.end();
          reject(new CancelledRunError());
          return;
        }

        if (exitCode === 0) {
          emitRunnerLog("stdout", "[runner] command finished successfully\n");
          logStream.end();
          resolve();
          return;
        }
        emitRunnerLog("stderr", `[runner] command exited with code ${exitCode ?? "unknown"}\n`);
        logStream.end();
        reject(new CommandFailedError(`Command exited with code ${exitCode ?? "unknown"}`, exitCode));
      });

      if (input.timeoutSeconds) {
        timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGTERM");
          emitRunnerLog("stderr", `[runner] command timed out after ${input.timeoutSeconds} seconds\n`);
          logStream.end();
          this.activeChildren.delete(input.runId);
          reject(new Error(`Command timed out after ${input.timeoutSeconds} seconds`));
        }, input.timeoutSeconds * 1000);
      }
    });
  }

  private resolveNodeInputs(
    node: WorkflowNode,
    edges: WorkflowEdge[],
    nodeOutputs: Map<string, Record<string, string>>,
    initialInputs: Map<string, string>
  ) {
    const inputs: Record<string, string> = {};

    for (const inputDefinition of node.inputs || []) {
      const incoming = edges.find(
        (edge) => edge.target === node.id && (!edge.targetHandle || edge.targetHandle === inputDefinition.name)
      );
      if (incoming) {
        const upstreamOutputs = nodeOutputs.get(incoming.source) || {};
        const outputName = incoming.sourceHandle || Object.keys(upstreamOutputs)[0];
        if (outputName && upstreamOutputs[outputName]) {
          inputs[inputDefinition.name] = upstreamOutputs[outputName];
          continue;
        }
      }

      const initialInput = initialInputs.get(inputDefinition.name);
      if (initialInput) {
        inputs[inputDefinition.name] = initialInput;
        continue;
      }

      if (inputDefinition.required) {
        throw new Error(`Missing required input "${inputDefinition.name}" for node "${node.label}"`);
      }
    }

    return inputs;
  }

  private resolveFileInputNode(node: WorkflowNode, initialInputs: Map<string, string>) {
    const outputs: Record<string, string> = {};
    for (const output of node.outputs || []) {
      const selectedFile = initialInputs.get(output.name);
      if (!selectedFile) {
        throw new Error(`Missing selected file for input module "${output.name}"`);
      }
      outputs[output.name] = selectedFile;
    }
    return outputs;
  }

  private buildNodeOutputs(node: WorkflowNode, outputDir: string) {
    const absoluteByName: Record<string, string> = {};
    const relativeByName: Record<string, string> = {};

    for (const output of node.outputs || []) {
      const extension = output.extension?.replace(/^\./, "") || "out";
      const fileName = `${sanitizeFileName(node.id)}_${sanitizeFileName(output.name)}.${extension}`;
      const absolutePath = path.join(outputDir, fileName);
      absoluteByName[output.name] = absolutePath;
      relativeByName[output.name] = fileStorageService.relativeFromAbsolute(absolutePath);
    }

    return { absoluteByName, relativeByName };
  }

  private outputFilesForNode(node: WorkflowNode, outputs: Record<string, string>): StoredFile[] {
    return Object.entries(outputs).map(([name, relativePath]) => {
      const definition = node.outputs.find((output) => output.name === name) as WorkflowOutputDefinition | undefined;
      return {
        name,
        relativePath,
        preview: definition?.preview || previewTypeForPath(relativePath)
      };
    });
  }

  private absoluteMap(relativeByName: Record<string, string>) {
    return Object.fromEntries(
      Object.entries(relativeByName).map(([name, relativePath]) => [name, fileStorageService.resolveRelativePath(relativePath)])
    );
  }

  private resolveTemplate(value: string, scope: Record<string, unknown>, context: string) {
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, keyPath: string) => {
      const parts = keyPath
        .trim()
        .split(".")
        .map((part) => part.trim())
        .filter(Boolean);
      let current: unknown = scope;
      for (const part of parts) {
        if (current && typeof current === "object" && part in current) {
          current = (current as Record<string, unknown>)[part];
        } else {
          throw new Error(`Unresolved template "{{${keyPath.trim()}}}" in ${context}. ${this.availableTemplateKeys(scope, parts[0])}`);
        }
      }
      return String(current ?? "");
    });
  }

  private availableTemplateKeys(scope: Record<string, unknown>, scopeName?: string) {
    if (!scopeName || !(scopeName in scope)) {
      return `Available scopes: ${Object.keys(scope).join(", ") || "none"}.`;
    }
    const value = scope[scopeName];
    if (!value || typeof value !== "object") {
      return `Scope "${scopeName}" is not an object.`;
    }
    const keys = Object.keys(value as Record<string, unknown>);
    return `Available ${scopeName} keys: ${keys.length ? keys.join(", ") : "none"}.`;
  }

  private resolveExecutionOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    const outgoing = new Map<string, WorkflowEdge[]>();

    for (const edge of edges) {
      if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) {
        throw new HttpError(400, `Edge ${edge.id} references a missing node`);
      }
      indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
      outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge]);
    }

    const queue = nodes.filter((node) => (indegree.get(node.id) || 0) === 0);
    const ordered: WorkflowNode[] = [];

    while (queue.length > 0) {
      const node = queue.shift() as WorkflowNode;
      ordered.push(node);
      for (const edge of outgoing.get(node.id) || []) {
        const nextValue = (indegree.get(edge.target) || 0) - 1;
        indegree.set(edge.target, nextValue);
        if (nextValue === 0) {
          const nextNode = nodeById.get(edge.target);
          if (nextNode) {
            queue.push(nextNode);
          }
        }
      }
    }

    if (ordered.length !== nodes.length) {
      throw new HttpError(400, "Workflow graph must be acyclic");
    }

    return ordered;
  }

  private async updateStep(runId: string, userId: string, stepIndex: number, partial: Partial<RunStep>) {
    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) {
        updates[`steps.${stepIndex}.${key}`] = value;
      }
    }

    if (Object.keys(updates).length === 0) {
      return;
    }

    const result = await RunModel.updateOne(
      { _id: runId, userId, [`steps.${stepIndex}`]: { $exists: true } },
      { $set: updates }
    );

    if (result.matchedCount === 0) {
      throw new HttpError(404, "Run not found");
    }
  }

  private async throwIfCancelled(runId: string) {
    if (this.cancelledRuns.has(runId)) {
      throw new CancelledRunError();
    }
    const run = await RunModel.findById(runId).select("status").lean();
    if (run?.status === "cancelled") {
      throw new CancelledRunError();
    }
  }

  private async writeManifest(runId: string, runDir: string) {
    const run = await RunModel.findById(runId).lean();
    if (run) {
      await fileStorageService.writeManifest(runDir, run);
    }
  }
}

export const workflowRunnerService = new WorkflowRunnerService();
