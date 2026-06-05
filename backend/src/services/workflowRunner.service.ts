import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import fsSync, { createWriteStream } from "fs";
import fs from "fs/promises";
import path from "path";
import type { Express } from "express";
import { Types } from "mongoose";
import { ProjectModel } from "../models/Project";
import { RunModel } from "../models/Run";
import { WorkflowModel } from "../models/Workflow";
import type { RunInputValue, RunItem, RunStep, StoredFile, WorkflowEdge, WorkflowNode, WorkflowOutputDefinition } from "../types/domain";
import { HttpError } from "../utils/httpError";
import { previewTypeForPath } from "../utils/preview";
import { workflowGraphSchema } from "../utils/validation";
import { repairWorkflowGraphHandles } from "../utils/workflowHandles";
import { fileStorageService, sanitizeFileName } from "./fileStorage.service";
import { socketService } from "./socket.service";

interface StartRunInput {
  userId: string;
  workflowId: string;
  selectedInputs: Record<string, string | string[]>;
  textInputs: Record<string, string[]>;
  exportDirs: Record<string, string[]>;
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

interface PreparedRunItem {
  itemId: string;
  index: number;
  label: string;
  dirs: RunDirs;
  inputFiles: StoredFile[];
  inputValues: RunInputValue[];
  exportDir?: string;
}

interface ResolvedValues {
  stepByName: Record<string, string>;
  templateByName: Record<string, string>;
}

interface NodeOutputValues extends ResolvedValues {}

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

class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

class WorkflowRunnerService {
  private activeChildren = new Map<string, Set<ChildProcessWithoutNullStreams>>();
  private activeExecutions = new Set<string>();
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
    const items = await this.prepareRunItems({
      userId: input.userId,
      runDir: dirs.runDir,
      selectedInputs: input.selectedInputs,
      textInputs: input.textInputs,
      exportDirs: input.exportDirs,
      uploadedFiles: input.uploadedFiles,
      steps
    });
    const inputFiles = items.flatMap((item) => item.inputFiles);
    const runItems: RunItem[] = items.map((item) => ({
      itemId: item.itemId,
      index: item.index,
      label: item.label,
      status: "pending",
      workingDir: fileStorageService.relativeFromAbsolute(item.dirs.runDir),
      exportDir: item.exportDir,
      inputFiles: item.inputFiles,
      inputValues: item.inputValues,
      outputFiles: [],
      steps: steps.map((step) => ({ ...step }))
    }));

    await RunModel.updateOne(
      { _id: runId, userId: input.userId },
      {
        $set: {
          status: "running",
          startedAt: new Date(),
          workingDir: fileStorageService.relativeFromAbsolute(dirs.runDir),
          inputFiles,
          items: runItems
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
      items,
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
    this.requestStopActiveChildren(runId);

    const steps = (run.steps || []).map((step) =>
      ["waiting", "running"].includes(step.status)
        ? { ...step, status: "cancelled", finishedAt: new Date(), errorMessage: "Run cancelled" }
        : step
    );
    const items = (run.items || []).map((item) => ({
      ...item,
      status: ["pending", "running"].includes(item.status) ? "cancelled" : item.status,
      finishedAt: item.finishedAt || new Date(),
      errorMessage: item.errorMessage || "Run cancelled",
      steps: (item.steps || []).map((step) =>
        ["waiting", "running"].includes(step.status)
          ? { ...step, status: "cancelled", finishedAt: new Date(), errorMessage: "Run cancelled" }
          : step
      )
    }));

    await RunModel.updateOne(
      { _id: runId, userId },
      { $set: { status: "cancelled", finishedAt: new Date(), steps, items, errorMessage: "Run cancelled" } }
    );
    socketService.emitToRun(runId, "run:finished", { runId, status: "cancelled" });
    return RunModel.findOne({ _id: runId, userId }).lean();
  }

  async rerunFromNode(userId: string, runId: string, nodeId: string, itemId?: string) {
    const run = await RunModel.findOne({ _id: runId, userId }).lean();
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    if (run.status === "running" || run.status === "pending") {
      throw new HttpError(409, "Cannot rerun while the workflow run is active");
    }
    if (run.status === "cancelled") {
      this.requestStopActiveChildren(runId);
      await this.waitForRunIdle(runId, 5000);
    }
    if (this.activeExecutions.has(runId) || (this.activeChildren.get(runId)?.size || 0) > 0) {
      throw new HttpError(409, "Wait for the cancelled process to finish before rerunning");
    }
    if (!run.items?.length) {
      throw new HttpError(400, "Rerun from step is available for batch runs only");
    }

    const workflow = await WorkflowModel.findOne({ _id: run.workflowId, userId }).lean();
    if (!workflow) {
      throw new HttpError(404, "Workflow not found");
    }

    const parsedGraph = repairWorkflowGraphHandles(workflowGraphSchema.parse({ nodes: workflow.nodes, edges: workflow.edges }));
    const executionOrder = this.resolveExecutionOrder(parsedGraph.nodes, parsedGraph.edges);
    const startIndex = executionOrder.findIndex((node) => node.id === nodeId);
    if (startIndex === -1) {
      throw new HttpError(400, "Selected node is not in the workflow");
    }

    const itemIndex = itemId
      ? run.items.findIndex((item) => item.itemId === itemId)
      : run.items.length === 1
        ? 0
        : -1;
    if (itemIndex === -1) {
      throw new HttpError(400, "Batch item is required for rerun");
    }

    const runItem = run.items[itemIndex];
    if (!runItem.workingDir) {
      throw new HttpError(400, "Batch item does not have a working directory");
    }
    const runItemSteps = (runItem.steps?.length ? runItem.steps : run.steps || []).map((step) => this.normalizeRunStep(step));
    const stepsByNodeId = new Map(runItemSteps.map((step) => [step.nodeId, step]));
    const firstBlockedIndex = executionOrder.findIndex((node) => {
      const status = stepsByNodeId.get(node.id)?.status;
      return status === "failed" || status === "cancelled";
    });
    if (firstBlockedIndex !== -1 && startIndex > firstBlockedIndex) {
      throw new HttpError(400, "Rerun from the first failed or cancelled step first");
    }

    const itemRoot = fileStorageService.resolveRelativePath(runItem.workingDir);
    const item: PreparedRunItem = {
      itemId: runItem.itemId,
      index: runItem.index,
      label: runItem.label,
      dirs: {
        runDir: itemRoot,
        inputDir: path.join(itemRoot, "input"),
        outputDir: path.join(itemRoot, "output"),
        tempDir: path.join(itemRoot, "temp"),
        logsDir: path.join(itemRoot, "logs")
      },
      inputFiles: (runItem.inputFiles || []).map((file) => this.normalizeStoredFile(file)),
      inputValues: (runItem.inputValues || []).map((value) => ({
        name: String(value.name),
        type: "text",
        value: String(value.value)
      })),
      exportDir: runItem.exportDir || undefined
    };

    const existingItemOutputs = (runItem.outputFiles || []).map((file) => this.normalizeStoredFile(file));
    const existingRunOutputs = (run.outputFiles || []).map((file) => this.normalizeStoredFile(file));
    const nextSteps = this.stepsForRerun(executionOrder, runItemSteps, startIndex);
    this.cancelledRuns.delete(runId);

    await RunModel.updateOne(
      { _id: runId, userId, [`items.${itemIndex}`]: { $exists: true } },
      {
        $set: {
          status: "running",
          outputFiles: existingRunOutputs,
          [`items.${itemIndex}.status`]: "running",
          [`items.${itemIndex}.startedAt`]: new Date(),
          [`items.${itemIndex}.outputFiles`]: existingItemOutputs,
          [`items.${itemIndex}.steps`]: nextSteps
        },
        $unset: {
          finishedAt: "",
          errorMessage: "",
          [`items.${itemIndex}.finishedAt`]: "",
          [`items.${itemIndex}.errorMessage`]: ""
        }
      }
    );

    socketService.emitToRun(runId, "run:status", { runId, itemId: item.itemId, status: "running" });

    void this.executeRerunItem({
      runId,
      userId,
      workflowRunDir: run.workingDir ? fileStorageService.resolveRelativePath(run.workingDir) : path.dirname(item.dirs.runDir),
      nodes: parsedGraph.nodes,
      edges: parsedGraph.edges,
      executionOrder,
      item,
      startIndex,
      existingOutputFiles: existingItemOutputs,
      params: (run.params || {}) as Record<string, string | number | boolean>
    });

    return RunModel.findOne({ _id: runId, userId }).lean();
  }

  private async prepareRunItems(input: {
    userId: string;
    runDir: string;
    selectedInputs: Record<string, string | string[]>;
    textInputs: Record<string, string[]>;
    exportDirs: Record<string, string[]>;
    uploadedFiles: Express.Multer.File[];
    steps: RunStep[];
  }): Promise<PreparedRunItem[]> {
    type BatchValue =
      | { kind: "upload"; inputName: string; file: Express.Multer.File; exportDir?: string }
      | { kind: "selected"; inputName: string; relativePath: string; exportDir?: string }
      | { kind: "text"; inputName: string; value: string; exportDir?: string };

    const valuesByInput = new Map<string, BatchValue[]>();
    const appendValue = (inputName: string, value: BatchValue) => {
      valuesByInput.set(inputName, [...(valuesByInput.get(inputName) || []), value]);
    };

    const uploadIndexes = new Map<string, number>();
    for (const file of input.uploadedFiles) {
      const inputName = file.fieldname === "files" ? path.parse(file.originalname).name : file.fieldname;
      const valueIndex = uploadIndexes.get(inputName) || 0;
      uploadIndexes.set(inputName, valueIndex + 1);
      appendValue(inputName, { kind: "upload", inputName, file, exportDir: input.exportDirs[inputName]?.[valueIndex] });
    }

    for (const [inputName, selectedValue] of Object.entries(input.selectedInputs || {})) {
      const selectedPaths = (Array.isArray(selectedValue) ? selectedValue : [selectedValue]).filter(Boolean);
      for (const [valueIndex, relativePath] of selectedPaths.entries()) {
        appendValue(inputName, { kind: "selected", inputName, relativePath, exportDir: input.exportDirs[inputName]?.[valueIndex] });
      }
    }

    for (const [inputName, textValues] of Object.entries(input.textInputs || {})) {
      const normalizedValues = (Array.isArray(textValues) ? textValues : [textValues]).map((item) => String(item).trim());
      for (const [valueIndex, value] of normalizedValues.entries()) {
        if (!value) continue;
        appendValue(inputName, { kind: "text", inputName, value, exportDir: input.exportDirs[inputName]?.[valueIndex] });
      }
    }

    const batchSize = Math.max(1, ...Array.from(valuesByInput.values()).map((values) => values.length));
    for (const [inputName, values] of valuesByInput.entries()) {
      if (values.length !== 1 && values.length !== batchSize) {
        throw new HttpError(400, `Input "${inputName}" has ${values.length} values, but this batch needs 1 or ${batchSize}`);
      }
    }

    const items: PreparedRunItem[] = [];
    for (let index = 0; index < batchSize; index += 1) {
      const itemId = `item_${String(index + 1).padStart(3, "0")}`;
      const itemRoot = path.join(input.runDir, "items", itemId);
      const dirs: RunDirs = {
        runDir: itemRoot,
        inputDir: path.join(itemRoot, "input"),
        outputDir: path.join(itemRoot, "output"),
        tempDir: path.join(itemRoot, "temp"),
        logsDir: path.join(itemRoot, "logs")
      };
      await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })));

      const inputFiles: StoredFile[] = [];
      const inputValues: RunInputValue[] = [];
      const labels: string[] = [];
      const exportDirs: string[] = [];

      for (const values of valuesByInput.values()) {
        const value = values[values.length === 1 ? 0 : index];
        if (!value) continue;
        if (value.exportDir?.trim()) {
          exportDirs.push(value.exportDir.trim());
        }

        if (value.kind === "upload") {
          const storedFile = await fileStorageService.saveRunUpload(dirs.inputDir, value.inputName, value.file);
          inputFiles.push({ ...storedFile, itemId });
          labels.push(value.file.originalname);
          continue;
        }

        if (value.kind === "selected") {
          const storedFile = await fileStorageService.copySelectedInput(input.userId, value.relativePath, dirs.inputDir, value.inputName);
          inputFiles.push({ ...storedFile, itemId });
          labels.push(path.basename(value.relativePath));
          continue;
        }

        inputValues.push({ name: value.inputName, type: "text", value: value.value });
        labels.push(value.value.length > 42 ? `${value.value.slice(0, 42)}...` : value.value);
      }

      items.push({
        itemId,
        index,
        label: labels.filter(Boolean).join(", ") || `Item ${index + 1}`,
        dirs,
        inputFiles,
        inputValues,
        exportDir: exportDirs[0]
      });
    }

    return items;
  }

  private async executeRun(input: {
    runId: string;
    userId: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    executionOrder: WorkflowNode[];
    items: PreparedRunItem[];
    dirs: RunDirs;
    params: Record<string, string | number | boolean>;
  }) {
    this.activeExecutions.add(input.runId);
    const semaphores = new Map(
      input.executionOrder.map((node) => [node.id, new Semaphore(Math.max(1, node.toolConfig.maxConcurrent || 1))])
    );

    try {
      const results = await Promise.all(
        input.items.map((item) =>
          this.executeRunItem({
            ...input,
            item,
            semaphores
          })
        )
      );
      const outputFiles = results.flatMap((result) => result.outputFiles);
      const failedItems = results.filter((result) => result.status === "failed");
      const cancelledItems = results.filter((result) => result.status === "cancelled");
      const status = cancelledItems.length > 0 ? "cancelled" : failedItems.length > 0 ? "failed" : "success";
      const errorMessage = failedItems.length > 0 ? `${failedItems.length} batch item(s) failed` : undefined;

      await RunModel.updateOne(
        { _id: input.runId, userId: input.userId },
        { $set: { status, finishedAt: new Date(), outputFiles, ...(errorMessage ? { errorMessage } : {}) } }
      );
      await this.writeManifest(input.runId, input.dirs.runDir);
      if (status !== "success") {
        socketService.emitToRun(input.runId, "run:error", {
          runId: input.runId,
          status,
          message: errorMessage
        });
      }
      socketService.emitToRun(input.runId, "run:finished", { runId: input.runId, status });
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
      this.activeExecutions.delete(input.runId);
      this.cancelledRuns.delete(input.runId);
    }
  }

  private async executeRerunItem(input: {
    runId: string;
    userId: string;
    workflowRunDir: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    executionOrder: WorkflowNode[];
    item: PreparedRunItem;
    startIndex: number;
    existingOutputFiles: StoredFile[];
    params: Record<string, string | number | boolean>;
  }) {
    this.activeExecutions.add(input.runId);
    const semaphores = new Map(
      input.executionOrder.map((node) => [node.id, new Semaphore(Math.max(1, node.toolConfig.maxConcurrent || 1))])
    );

    try {
      const initialNodeOutputs = this.reconstructNodeOutputs(input.executionOrder, input.item, input.startIndex);
      await this.executeRunItem({
        runId: input.runId,
        userId: input.userId,
        nodes: input.nodes,
        edges: input.edges,
        executionOrder: input.executionOrder,
        item: input.item,
        dirs: {
          runDir: input.workflowRunDir,
          inputDir: path.join(input.workflowRunDir, "input"),
          outputDir: path.join(input.workflowRunDir, "output"),
          tempDir: path.join(input.workflowRunDir, "temp"),
          logsDir: path.join(input.workflowRunDir, "logs")
        },
        semaphores,
        params: input.params,
        startIndex: input.startIndex,
        initialNodeOutputs,
        existingOutputFiles: input.existingOutputFiles
      });
      await this.finalizeRunAfterRerun(input.runId, input.userId, input.workflowRunDir);
    } catch (error) {
      await this.updateItem(input.runId, input.userId, input.item.index, {
        status: error instanceof CancelledRunError ? "cancelled" : "failed",
        finishedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : "Rerun failed"
      });
      await this.finalizeRunAfterRerun(input.runId, input.userId, input.workflowRunDir);
    } finally {
      this.activeChildren.delete(input.runId);
      this.activeExecutions.delete(input.runId);
      this.cancelledRuns.delete(input.runId);
    }
  }

  private stepsForRerun(executionOrder: WorkflowNode[], currentSteps: RunStep[], startIndex: number) {
    return executionOrder.map((node, index): RunStep => {
      const currentStep = currentSteps[index];
      if (index < startIndex && currentStep) {
        return currentStep;
      }
      return {
        nodeId: node.id,
        label: node.label,
        status: "waiting"
      };
    });
  }

  private reconstructNodeOutputs(executionOrder: WorkflowNode[], item: PreparedRunItem, startIndex: number) {
    const nodeOutputs = new Map<string, NodeOutputValues>();
    const initialFiles = new Map(item.inputFiles.map((file) => [file.name, file.relativePath]));
    const initialTexts = new Map(item.inputValues.map((value) => [value.name, value.value]));

    for (let index = 0; index < startIndex; index += 1) {
      const node = executionOrder[index];
      if (node.type === "fileInput") {
        nodeOutputs.set(node.id, this.resolveInputNode(node, initialFiles, initialTexts));
        continue;
      }

      const outputs = this.buildNodeOutputs(node, item.dirs.outputDir);
      nodeOutputs.set(node.id, {
        stepByName: outputs.relativeByName,
        templateByName: outputs.absoluteByName
      });
    }

    return nodeOutputs;
  }

  private async finalizeRunAfterRerun(runId: string, userId: string, workflowRunDir: string) {
    const run = await RunModel.findOne({ _id: runId, userId }).lean();
    if (!run) {
      return;
    }

    const items = run.items || [];
    const outputFiles = items.flatMap((item) => item.outputFiles || []);
    const status = items.some((item) => item.status === "running" || item.status === "pending")
      ? "running"
      : items.some((item) => item.status === "cancelled")
        ? "cancelled"
        : items.some((item) => item.status === "failed")
          ? "failed"
          : "success";
    const finished = status !== "running";
    const errorMessage = status === "failed" ? `${items.filter((item) => item.status === "failed").length} batch item(s) failed` : undefined;

    await RunModel.updateOne(
      { _id: runId, userId },
      {
        $set: {
          status,
          outputFiles,
          ...(finished ? { finishedAt: new Date() } : {}),
          ...(errorMessage ? { errorMessage } : {})
        },
        ...(errorMessage ? {} : { $unset: { errorMessage: "" } })
      }
    );
    await this.writeManifest(runId, workflowRunDir).catch(() => undefined);
    if (finished) {
      if (status !== "success") {
        socketService.emitToRun(runId, "run:error", { runId, status, message: errorMessage });
      }
      socketService.emitToRun(runId, "run:finished", { runId, status });
    } else {
      socketService.emitToRun(runId, "run:status", { runId, status });
    }
  }

  private async executeRunItem(input: {
    runId: string;
    userId: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    executionOrder: WorkflowNode[];
    item: PreparedRunItem;
    dirs: RunDirs;
    semaphores: Map<string, Semaphore>;
    params: Record<string, string | number | boolean>;
    startIndex?: number;
    initialNodeOutputs?: Map<string, NodeOutputValues>;
    existingOutputFiles?: StoredFile[];
  }): Promise<{ status: "success" | "failed" | "cancelled"; outputFiles: StoredFile[] }> {
    const startIndex = input.startIndex || 0;
    const nodeOutputs = new Map<string, NodeOutputValues>(input.initialNodeOutputs || []);
    const initialFiles = new Map(input.item.inputFiles.map((file) => [file.name, file.relativePath]));
    const initialTexts = new Map(input.item.inputValues.map((value) => [value.name, value.value]));
    const runOutputFiles: StoredFile[] = [...(input.existingOutputFiles || [])];

    await this.updateItem(input.runId, input.userId, input.item.index, {
      status: "running",
      startedAt: new Date()
    });

    try {
      for (let orderIndex = startIndex; orderIndex < input.executionOrder.length; orderIndex += 1) {
        const node = input.executionOrder[orderIndex];
        await this.throwIfCancelled(input.runId);
        const stepIndex = orderIndex;

        if (node.type === "fileInput") {
          const fileInputOutputs = this.resolveInputNode(node, initialFiles, initialTexts);
          await this.copyAutoDownloadFiles({
            runId: input.runId,
            userId: input.userId,
            itemId: input.item.itemId,
            node,
            exportDir: input.item.exportDir,
            resolvedInputs: { stepByName: {}, templateByName: {} },
            resolvedOutputs: {
              relativeByName: fileInputOutputs.stepByName,
              absoluteByName: fileInputOutputs.templateByName
            }
          });
          await this.updateItemStep(input.runId, input.userId, input.item.index, stepIndex, {
            status: "success",
            startedAt: new Date(),
            finishedAt: new Date(),
            outputs: fileInputOutputs.stepByName
          });
          await this.syncAggregateStep(input.runId, input.userId, stepIndex);
          nodeOutputs.set(node.id, fileInputOutputs);
          socketService.emitToRun(input.runId, "step:status", {
            runId: input.runId,
            itemId: input.item.itemId,
            nodeId: node.id,
            status: "success"
          });
          continue;
        }

        const resolvedInputs = this.resolveNodeInputs(node, input.edges, nodeOutputs, initialFiles, initialTexts);
        const resolvedOutputs = this.buildNodeOutputs(node, input.item.dirs.outputDir);
        const semaphore = input.semaphores.get(node.id);
        await semaphore?.acquire();
        try {
          await this.throwIfCancelled(input.runId);
          await this.runNode({
            runId: input.runId,
            userId: input.userId,
            itemId: input.item.itemId,
            itemIndex: input.item.index,
            node,
            stepIndex,
            dirs: input.item.dirs,
            exportDir: input.item.exportDir,
            resolvedInputs,
            resolvedOutputs,
            params: { ...(node.defaultParams || {}), ...input.params }
          });
        } finally {
          semaphore?.release();
        }

        nodeOutputs.set(node.id, {
          stepByName: resolvedOutputs.relativeByName,
          templateByName: resolvedOutputs.absoluteByName
        });
        const outputFiles = this.outputFilesForNode(node, resolvedOutputs.relativeByName, input.item.itemId);
        const newOutputFiles = outputFiles.filter((file) => {
          const isDuplicate = runOutputFiles.some(
            (existingFile) => existingFile.itemId === file.itemId && existingFile.relativePath === file.relativePath
          );
          return !isDuplicate;
        });
        runOutputFiles.push(...newOutputFiles);

        const update: Record<string, unknown> = { $set: { [`items.${input.item.index}.outputFiles`]: runOutputFiles } };
        if (newOutputFiles.length > 0) {
          update.$push = { outputFiles: { $each: newOutputFiles } };
        }
        await RunModel.updateOne({ _id: input.runId, userId: input.userId, [`items.${input.item.index}`]: { $exists: true } }, update);
        for (const file of outputFiles) {
          socketService.emitToRun(input.runId, "step:output", { runId: input.runId, itemId: input.item.itemId, nodeId: node.id, file });
        }
      }

      await this.updateItem(input.runId, input.userId, input.item.index, {
        status: "success",
        finishedAt: new Date(),
        outputFiles: runOutputFiles
      });
      return { status: "success", outputFiles: runOutputFiles };
    } catch (error) {
      const status = error instanceof CancelledRunError ? "cancelled" : "failed";
      const message = error instanceof Error ? error.message : "Batch item failed";
      await this.updateItem(input.runId, input.userId, input.item.index, {
        status,
        finishedAt: new Date(),
        errorMessage: message,
        outputFiles: runOutputFiles
      });
      socketService.emitToRun(input.runId, "run:status", {
        runId: input.runId,
        itemId: input.item.itemId,
        status,
        errorMessage: message
      });
      return { status, outputFiles: runOutputFiles };
    }
  }

  private async runNode(input: {
    runId: string;
    userId: string;
    itemId: string;
    itemIndex: number;
    node: WorkflowNode;
    stepIndex: number;
    dirs: RunDirs;
    exportDir?: string;
    resolvedInputs: ResolvedValues;
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
      inputs: input.resolvedInputs.templateByName,
      outputs: input.resolvedOutputs.absoluteByName,
      params: input.params,
      runDir: input.dirs.runDir,
      inputDir: input.dirs.inputDir,
      outputDir: input.dirs.outputDir,
      tempDir: input.dirs.tempDir
    };

    await this.updateItemStep(input.runId, input.userId, input.itemIndex, input.stepIndex, {
      status: "running",
      startedAt: new Date(),
      inputs: input.resolvedInputs.stepByName,
      outputs: input.resolvedOutputs.relativeByName,
      logPath: relativeLogPath
    });
    await this.syncAggregateStep(input.runId, input.userId, input.stepIndex);
    socketService.emitToRun(input.runId, "step:status", {
      runId: input.runId,
      itemId: input.itemId,
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

      await this.updateItemStep(input.runId, input.userId, input.itemIndex, input.stepIndex, {
        command: bin,
        args
      });
      await this.syncAggregateStep(input.runId, input.userId, input.stepIndex);
      socketService.emitToRun(input.runId, "step:status", {
        runId: input.runId,
        itemId: input.itemId,
        nodeId: input.node.id,
        status: "running",
        command: bin,
        args
      });

      await this.spawnAndStream({
        runId: input.runId,
        itemId: input.itemId,
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

      await this.copyAutoDownloadFiles({
        runId: input.runId,
        userId: input.userId,
        itemId: input.itemId,
        node: input.node,
        exportDir: input.exportDir,
        resolvedInputs: input.resolvedInputs,
        resolvedOutputs: input.resolvedOutputs,
        logPath
      });

      await this.updateItemStep(input.runId, input.userId, input.itemIndex, input.stepIndex, {
        status: "success",
        finishedAt: new Date(),
        exitCode: 0
      });
      await this.syncAggregateStep(input.runId, input.userId, input.stepIndex);
      socketService.emitToRun(input.runId, "step:status", {
        runId: input.runId,
        itemId: input.itemId,
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
        itemId: input.itemId,
        nodeId: input.node.id,
        stream: "stderr",
        message,
        timestamp: new Date().toISOString()
      });
      await this.updateItemStep(input.runId, input.userId, input.itemIndex, input.stepIndex, {
        status,
        finishedAt: new Date(),
        exitCode,
        errorMessage: error instanceof Error ? error.message : "Step failed"
      });
      await this.syncAggregateStep(input.runId, input.userId, input.stepIndex);
      socketService.emitToRun(input.runId, "step:status", {
        runId: input.runId,
        itemId: input.itemId,
        nodeId: input.node.id,
        status,
        errorMessage: error instanceof Error ? error.message : "Step failed"
      });
      throw error;
    }
  }

  private spawnAndStream(input: {
    runId: string;
    itemId: string;
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
          itemId: input.itemId,
          nodeId: input.nodeId,
          stream,
          message,
          timestamp: new Date().toISOString()
        });
      };

      emitRunnerLog("stdout", `[runner] cwd: ${input.cwd}\n`);
      emitRunnerLog("stdout", `[runner] command: ${JSON.stringify([input.bin, ...input.args])}\n`);

      if (this.cancelledRuns.has(input.runId)) {
        emitRunnerLog("stderr", "[runner] command cancelled before start\n");
        logStream.end();
        reject(new CancelledRunError());
        return;
      }

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(input.bin, input.args, {
          cwd: input.cwd,
          detached: process.platform !== "win32",
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

      const activeChildren = this.activeChildren.get(input.runId) || new Set<ChildProcessWithoutNullStreams>();
      activeChildren.add(child);
      this.activeChildren.set(input.runId, activeChildren);

      const onChunk = (stream: "stdout" | "stderr", chunk: Buffer) => {
        if (settled) {
          return;
        }
        emitRunnerLog(stream, chunk.toString());
      };

      child.stdout.on("data", (chunk: Buffer) => onChunk("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => onChunk("stderr", chunk));

      child.on("error", (error) => {
        this.activeChildren.get(input.runId)?.delete(child);
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        emitRunnerLog("stderr", `[runner] spawn error: ${error.message}\n`);
        logStream.end();
        reject(error);
      });

      child.on("close", (exitCode) => {
        if (timeout) clearTimeout(timeout);
        this.activeChildren.get(input.runId)?.delete(child);
        if (settled) return;
        settled = true;

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
          this.signalChildProcess(child, "SIGTERM");
          const forceKillTimer = setTimeout(() => this.signalChildProcess(child, "SIGKILL"), 2500);
          forceKillTimer.unref();
          emitRunnerLog("stderr", `[runner] command timed out after ${input.timeoutSeconds} seconds\n`);
          logStream.end();
          reject(new Error(`Command timed out after ${input.timeoutSeconds} seconds`));
        }, input.timeoutSeconds * 1000);
      }
    });
  }

  private requestStopActiveChildren(runId: string) {
    for (const child of this.activeChildren.get(runId) || []) {
      if (child.exitCode !== null || child.signalCode !== null) {
        continue;
      }

      this.signalChildProcess(child, "SIGTERM");

      const forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          this.signalChildProcess(child, "SIGKILL");
        }
      }, 2500);
      forceKillTimer.unref();
    }
  }

  private signalChildProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    if (process.platform !== "win32" && child.pid) {
      const descendantPids = this.descendantPids(child.pid);
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          // Fall back to direct PID signalling below.
        }
      }

      for (const pid of descendantPids) {
        try {
          process.kill(pid, signal);
        } catch {
          // The process may already be gone after the process-group signal.
        }
      }
    }

    if (!child.killed || signal === "SIGKILL") {
      child.kill(signal);
    }
  }

  private descendantPids(pid: number): number[] {
    if (process.platform !== "linux") {
      return [];
    }

    try {
      const children = fsSync
        .readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0);
      return children.flatMap((childPid) => [...this.descendantPids(childPid), childPid]);
    } catch {
      return [];
    }
  }

  private async waitForRunIdle(runId: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (this.activeExecutions.has(runId) || (this.activeChildren.get(runId)?.size || 0) > 0) {
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return true;
  }

  private resolveNodeInputs(
    node: WorkflowNode,
    edges: WorkflowEdge[],
    nodeOutputs: Map<string, NodeOutputValues>,
    initialFiles: Map<string, string>,
    initialTexts: Map<string, string>
  ) {
    const inputs: ResolvedValues = { stepByName: {}, templateByName: {} };

    for (const inputDefinition of node.inputs || []) {
      const incoming = edges.find(
        (edge) => edge.target === node.id && (!edge.targetHandle || edge.targetHandle === inputDefinition.name)
      );
      if (incoming) {
        const upstreamOutputs = nodeOutputs.get(incoming.source);
        const outputName = incoming.sourceHandle || Object.keys(upstreamOutputs?.stepByName || {})[0];
        if (upstreamOutputs && outputName && upstreamOutputs.stepByName[outputName] !== undefined) {
          inputs.stepByName[inputDefinition.name] = upstreamOutputs.stepByName[outputName];
          inputs.templateByName[inputDefinition.name] = upstreamOutputs.templateByName[outputName];
          continue;
        }
      }

      const initialFile = initialFiles.get(inputDefinition.name);
      if (initialFile) {
        inputs.stepByName[inputDefinition.name] = initialFile;
        inputs.templateByName[inputDefinition.name] = fileStorageService.resolveRelativePath(initialFile);
        continue;
      }

      const initialText = initialTexts.get(inputDefinition.name);
      if (initialText !== undefined) {
        inputs.stepByName[inputDefinition.name] = initialText;
        inputs.templateByName[inputDefinition.name] = initialText;
        continue;
      }

      if (inputDefinition.required) {
        throw new Error(`Missing required input "${inputDefinition.name}" for node "${node.label}"`);
      }
    }

    return inputs;
  }

  private resolveInputNode(node: WorkflowNode, initialFiles: Map<string, string>, initialTexts: Map<string, string>): NodeOutputValues {
    const outputs: NodeOutputValues = { stepByName: {}, templateByName: {} };
    for (const output of node.outputs || []) {
      if (output.type === "text") {
        const textValue = initialTexts.get(output.name);
        if (textValue === undefined) {
          throw new Error(`Missing text value for input "${output.name}"`);
        }
        outputs.stepByName[output.name] = textValue;
        outputs.templateByName[output.name] = textValue;
        continue;
      }

      const selectedFile = initialFiles.get(output.name);
      if (!selectedFile) {
        throw new Error(`Missing selected file for input "${output.name}"`);
      }
      outputs.stepByName[output.name] = selectedFile;
      outputs.templateByName[output.name] = fileStorageService.resolveRelativePath(selectedFile);
    }
    return outputs;
  }

  private buildNodeOutputs(node: WorkflowNode, outputDir: string) {
    const absoluteByName: Record<string, string> = {};
    const relativeByName: Record<string, string> = {};

    for (const output of node.outputs || []) {
      if (output.type !== "file") {
        continue;
      }
      const extension = output.extension?.replace(/^\./, "") || "out";
      const fileName = `${sanitizeFileName(node.id)}_${sanitizeFileName(output.name)}.${extension}`;
      const absolutePath = path.join(outputDir, fileName);
      absoluteByName[output.name] = absolutePath;
      relativeByName[output.name] = fileStorageService.relativeFromAbsolute(absolutePath);
    }

    return { absoluteByName, relativeByName };
  }

  private outputFilesForNode(node: WorkflowNode, outputs: Record<string, string>, itemId?: string): StoredFile[] {
    return Object.entries(outputs).map(([name, relativePath]) => {
      const definition = node.outputs.find((output) => output.name === name) as WorkflowOutputDefinition | undefined;
      return {
        name,
        relativePath,
        preview: definition?.preview || previewTypeForPath(relativePath),
        itemId
      };
    });
  }

  private async copyAutoDownloadFiles(input: {
    runId: string;
    userId: string;
    itemId: string;
    node: WorkflowNode;
    exportDir?: string;
    resolvedInputs: ResolvedValues;
    resolvedOutputs: {
      absoluteByName: Record<string, string>;
      relativeByName: Record<string, string>;
    };
    logPath?: string;
  }) {
    const exportDir = input.exportDir?.trim();
    if (!exportDir) {
      return;
    }

    const candidates: Array<{ label: string; relativePath: string }> = [];
    for (const definition of input.node.inputs || []) {
      if (definition.autoDownload && definition.type === "file") {
        const relativePath = input.resolvedInputs.stepByName[definition.name];
        if (relativePath) {
          candidates.push({ label: `input:${definition.name}`, relativePath });
        }
      }
    }
    for (const definition of input.node.outputs || []) {
      if (definition.autoDownload && definition.type === "file") {
        const relativePath = input.resolvedOutputs.relativeByName[definition.name];
        if (relativePath) {
          candidates.push({ label: `output:${definition.name}`, relativePath });
        }
      }
    }

    if (candidates.length === 0) {
      return;
    }

    if (!path.isAbsolute(exportDir)) {
      throw new Error(`Auto download folder must be an absolute path: ${exportDir}`);
    }

    const targetDir = path.resolve(exportDir);
    await fs.mkdir(targetDir, { recursive: true });

    for (const candidate of candidates) {
      if (path.isAbsolute(candidate.relativePath)) {
        throw new Error(`Auto download source must be a stored relative path: ${candidate.relativePath}`);
      }
      fileStorageService.assertUserOwnsPath(input.userId, candidate.relativePath);
      const sourcePath = fileStorageService.resolveRelativePath(candidate.relativePath);
      const sourceStat = await fs.stat(sourcePath);
      if (!sourceStat.isFile()) {
        continue;
      }
      const destinationPath = await this.nextAvailableExportPath(targetDir, path.basename(sourcePath));
      await fs.copyFile(sourcePath, destinationPath);
      await this.emitStepLog({
        runId: input.runId,
        itemId: input.itemId,
        nodeId: input.node.id,
        logPath: input.logPath,
        stream: "stdout",
        message: `[runner] auto-downloaded ${candidate.label}: ${destinationPath}\n`
      });
    }
  }

  private async nextAvailableExportPath(targetDir: string, fileName: string) {
    const safeName = sanitizeFileName(fileName);
    const parsed = path.parse(safeName);
    for (let index = 0; index < 10_000; index += 1) {
      const candidateName = index === 0 ? safeName : `${parsed.name}_${index + 1}${parsed.ext}`;
      const candidatePath = path.join(targetDir, candidateName);
      try {
        await fs.access(candidatePath, fsSync.constants.F_OK);
      } catch {
        return candidatePath;
      }
    }
    throw new Error(`Unable to find available export file name for ${safeName}`);
  }

  private async emitStepLog(input: {
    runId: string;
    itemId: string;
    nodeId: string;
    logPath?: string;
    stream: "stdout" | "stderr";
    message: string;
  }) {
    if (input.logPath) {
      await fs.appendFile(input.logPath, input.message).catch(() => undefined);
    }
    socketService.emitToRun(input.runId, "step:log", {
      runId: input.runId,
      itemId: input.itemId,
      nodeId: input.nodeId,
      stream: input.stream,
      message: input.message,
      timestamp: new Date().toISOString()
    });
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

  private normalizeStoredFile(value: unknown): StoredFile {
    const file = (value || {}) as Partial<StoredFile> & { preview?: unknown };
    return {
      name: String(file.name || path.basename(String(file.relativePath || "file"))),
      originalName: file.originalName || undefined,
      mimeType: file.mimeType || undefined,
      size: typeof file.size === "number" ? file.size : undefined,
      relativePath: String(file.relativePath || ""),
      preview: typeof file.preview === "string" ? (file.preview as StoredFile["preview"]) : undefined,
      itemId: file.itemId || undefined
    };
  }

  private normalizeRunStep(value: unknown): RunStep {
    const step = (value || {}) as Partial<RunStep>;
    return {
      nodeId: String(step.nodeId || ""),
      label: String(step.label || step.nodeId || "Step"),
      status: step.status || "waiting",
      startedAt: step.startedAt || undefined,
      finishedAt: step.finishedAt || undefined,
      exitCode: step.exitCode ?? undefined,
      command: step.command || undefined,
      args: step.args || undefined,
      inputs: step.inputs || undefined,
      outputs: step.outputs || undefined,
      logPath: step.logPath || undefined,
      errorMessage: step.errorMessage || undefined
    };
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

  private async updateItem(
    runId: string,
    userId: string,
    itemIndex: number,
    partial: Partial<Omit<RunItem, "steps" | "itemId" | "index" | "label">>
  ) {
    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) {
        updates[`items.${itemIndex}.${key}`] = value;
      }
    }
    if (Object.keys(updates).length === 0) {
      return;
    }
    await RunModel.updateOne(
      { _id: runId, userId, [`items.${itemIndex}`]: { $exists: true } },
      { $set: updates }
    );
  }

  private async updateItemStep(runId: string, userId: string, itemIndex: number, stepIndex: number, partial: Partial<RunStep>) {
    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) {
        updates[`items.${itemIndex}.steps.${stepIndex}.${key}`] = value;
      }
    }
    if (Object.keys(updates).length === 0) {
      return;
    }
    await RunModel.updateOne(
      { _id: runId, userId, [`items.${itemIndex}.steps.${stepIndex}`]: { $exists: true } },
      { $set: updates }
    );
  }

  private async syncAggregateStep(runId: string, userId: string, stepIndex: number) {
    const run = await RunModel.findOne({ _id: runId, userId }).select("items steps").lean();
    if (!run?.items?.length) {
      return;
    }

    const itemSteps = run.items.map((item) => item.steps?.[stepIndex]).filter(Boolean);
    if (itemSteps.length === 0) {
      return;
    }

    const status = itemSteps.some((step) => step.status === "failed")
      ? "failed"
      : itemSteps.some((step) => step.status === "cancelled")
        ? "cancelled"
        : itemSteps.some((step) => step.status === "running")
          ? "running"
          : itemSteps.every((step) => step.status === "success")
            ? "success"
            : "waiting";
    const sample = itemSteps.find((step) => step.status === "running") || itemSteps.find((step) => step.status === "failed") || itemSteps[0];

    await this.updateStep(runId, userId, stepIndex, {
      status,
      startedAt: sample.startedAt || undefined,
      finishedAt: status === "success" || status === "failed" || status === "cancelled" ? sample.finishedAt || undefined : undefined,
      exitCode: sample.exitCode ?? undefined,
      command: sample.command || undefined,
      args: sample.args,
      inputs: sample.inputs,
      outputs: sample.outputs,
      logPath: sample.logPath || undefined,
      errorMessage: sample.errorMessage || undefined
    });
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
