import fsSync, { createWriteStream } from "fs";
import fs from "fs/promises";
import { finished } from "stream/promises";
import path from "path";
import { randomUUID } from "crypto";
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
import { executionScheduler } from "./executionScheduler";
import { aggregateStatus, aggregateSteps, isActiveStatus, recoverRun } from "./runState";
import { runSupervisedCommand, stopOwnedProcess } from "./processRunner";

interface StartRunInput {
  userId: string; workflowId: string; selectedInputs: Record<string, string | string[]>;
  textInputs: Record<string, string[]>; exportDirs: Record<string, string[]>;
  uploadedFiles: Express.Multer.File[]; params: Record<string, string | number | boolean>;
}
interface RunDirs { runDir: string; inputDir: string; outputDir: string; tempDir: string; logsDir: string }
interface PreparedRunItem {
  itemId: string; index: number; label: string; dirs: RunDirs;
  inputFiles: StoredFile[]; inputValues: RunInputValue[]; exportDir?: string;
}
interface ResolvedValues { stepByName: Record<string, string>; templateByName: Record<string, string> }
interface NodeOutputValues extends ResolvedValues {}
interface Graph { name?: string; nodes: WorkflowNode[]; edges: WorkflowEdge[] }
interface StoredRun {
  _id: unknown; userId: unknown; projectId: unknown; workflowId: unknown;
  status: string; items: RunItem[]; steps: RunStep[]; inputFiles: StoredFile[]; outputFiles: StoredFile[];
  workingDir?: string; startedAt?: Date; finishedAt?: Date; errorMessage?: string;
  workflowSnapshot?: Graph; params: Record<string, string | number | boolean>; revision?: number;
}
interface Execution {
  runId: string; userId: string; workflowId: string; item: PreparedRunItem; attemptId: string;
  controller: AbortController; done: Promise<void>; graph: Graph; order: WorkflowNode[];
  startIndex: number; previousSteps: RunStep[]; outputs: StoredFile[]; failure?: Error;
}
export interface BatchResult { acceptedItemIds: string[]; skipped: Array<{ itemId: string; reason: string }> }

export class WorkflowRunnerService {
  private executions = new Map<string, Execution>();
  private locks = new Map<string, Promise<unknown>>();
  private shuttingDown = false;
  private limitVersions = new Map<string, number>();

  private key(runId: string, itemId: string) { return `${runId}:${itemId}`; }
  private async locked<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(runId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.locks.set(runId, next);
    try { return await next; }
    finally { if (this.locks.get(runId) === next) this.locks.delete(runId); }
  }
  private async readRun(userId: string, runId: string) {
    const run = await RunModel.findOne({ _id: runId, userId }).lean();
    if (!run) throw new HttpError(404, "Run not found");
    const stored = run as unknown as StoredRun;
    stored.items ||= []; stored.steps ||= []; stored.inputFiles ||= []; stored.outputFiles ||= []; stored.params ||= {};
    return stored;
  }
  /** All item mutations and aggregation are serialized; never hold this lock while a command runs. */
  private async mutate(userId: string, runId: string, itemId: string | undefined,
    attemptId: string | undefined, change: (run: StoredRun, item?: RunItem) => void) {
    return this.locked(runId, async () => {
      const run = await this.readRun(userId, runId);
      const item = itemId ? run.items.find((value) => value.itemId === itemId) : undefined;
      if (itemId && (!item || (attemptId && item.attemptId !== attemptId))) return run;
      change(run, item);
      await this.persist(run, itemId ? [itemId] : undefined);
      return run;
    });
  }
  private async persist(run: StoredRun, changedIds?: string[]) {
    if (run.items.length) {
      run.status = aggregateStatus(run.items.map((item) => item.status));
      run.steps = aggregateSteps(run.items);
      run.outputFiles = run.items.flatMap((item) => item.outputFiles || []);
      const starts = run.items.flatMap((item) => item.startedAt ? [new Date(item.startedAt).getTime()] : []);
      if (!run.startedAt && starts.length) run.startedAt = new Date(Math.min(...starts));
      run.finishedAt = isActiveStatus(run.status) ? undefined : run.finishedAt || new Date();
      const failed = run.items.filter((item) => item.status === "failed").length;
      run.errorMessage = !isActiveStatus(run.status) && failed ? `${failed} job(s) failed` : undefined;
    }
    run.revision = (run.revision || 0) + 1;
    const values = { items: run.items, steps: run.steps, outputFiles: run.outputFiles,
      status: run.status, revision: run.revision, startedAt: run.startedAt,
      finishedAt: run.finishedAt, errorMessage: run.errorMessage, workflowSnapshot: run.workflowSnapshot };
    const unset = Object.fromEntries(Object.entries(values).filter(([, value]) => value === undefined).map(([key]) => [key, ""]));
    const set = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
    await RunModel.updateOne({ _id: run._id, userId: run.userId }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    socketService.emitToRun(String(run._id), "run:patch", {
      runId: String(run._id), revision: run.revision,
      run: { status: run.status, startedAt: run.startedAt || null, finishedAt: run.finishedAt || null, errorMessage: run.errorMessage || null },
      items: changedIds ? run.items.filter((item) => changedIds.includes(item.itemId)) : run.items,
      steps: run.steps
    });
    if (!isActiveStatus(run.status) && run.workingDir) {
      await fileStorageService.writeManifest(fileStorageService.resolveRelativePath(run.workingDir), run).catch((error) => console.error("Manifest write failed", error));
    }
  }
  updateLimits(userId: string, workflowId: string, nodes: WorkflowNode[], updatedAt?: Date) {
    const key = `${userId}:${workflowId}`;
    const version = updatedAt ? new Date(updatedAt).getTime() : 0;
    if (version < (this.limitVersions.get(key) || 0)) return;
    this.limitVersions.set(key, version);
    for (const node of nodes) executionScheduler.setLimit(`${userId}:${workflowId}:${node.id}`, node.toolConfig.maxConcurrent || 1);
  }
  async startRun(input: StartRunInput) {
    if (this.shuttingDown) throw new HttpError(503, "Backend is shutting down");
    const workflow = await WorkflowModel.findOne({ _id: input.workflowId, userId: input.userId }).lean();
    if (!workflow) throw new HttpError(404, "Workflow not found");
    if (!await ProjectModel.exists({ _id: workflow.projectId, userId: input.userId })) throw new HttpError(404, "Project not found");
    const graph: Graph = { ...repairWorkflowGraphHandles(workflowGraphSchema.parse(workflow)), name: workflow.name };
    const order = this.resolveExecutionOrder(graph.nodes, graph.edges);
    if (!order.length) throw new HttpError(400, "Workflow has no steps");
    const runId = String(new Types.ObjectId());
    const dirs = await fileStorageService.createRunDirs(input.userId, String(workflow.projectId), runId);
    let prepared: PreparedRunItem[];
    try { prepared = await this.prepareRunItems({ ...input, runDir: dirs.runDir, steps: [] }); }
    catch (error) {
      await fileStorageService.removeRelativePath(input.userId, fileStorageService.relativeFromAbsolute(dirs.runDir)).catch(() => undefined);
      throw error;
    }
    if (this.shuttingDown) throw new HttpError(503, "Backend is shutting down");
    const items: RunItem[] = prepared.map((item) => {
      const attemptId = randomUUID();
      return { itemId: item.itemId, index: item.index, label: item.label, attemptId, status: "await",
        workingDir: fileStorageService.relativeFromAbsolute(item.dirs.runDir), exportDir: item.exportDir,
        inputFiles: item.inputFiles, inputValues: item.inputValues, outputFiles: [],
        steps: order.map((node) => ({ nodeId: node.id, label: node.label, status: "await", attemptId })) };
    });
    const latest = await WorkflowModel.findOne({ _id: input.workflowId, userId: input.userId }).lean();
    this.updateLimits(input.userId, input.workflowId, latest ? workflowGraphSchema.parse(latest).nodes : graph.nodes, latest?.updatedAt);
    await RunModel.create({ _id: runId, userId: input.userId, projectId: workflow.projectId,
      workflowId: workflow._id, workflowSnapshot: graph, status: "await", revision: 0,
      workingDir: fileStorageService.relativeFromAbsolute(dirs.runDir),
      inputFiles: prepared.flatMap((item) => item.inputFiles), outputFiles: [], steps: aggregateSteps(items), items, params: input.params });
    for (const item of prepared) this.launch({ runId, userId: input.userId, workflowId: input.workflowId,
      item, attemptId: items[item.index].attemptId!, graph, order, startIndex: 0, previousSteps: [], outputs: [] });
    return this.readRun(input.userId, runId);
  }
  async cancelRun(userId: string, runId: string, itemIds?: string[]) {
    const acceptedItemIds: string[] = [];
    const skipped: BatchResult["skipped"] = [];
    const contexts: Execution[] = [];
    await this.mutate(userId, runId, undefined, undefined, (run) => {
      for (const itemId of [...new Set(itemIds || run.items.filter((item) => isActiveStatus(item.status)).map((item) => item.itemId))]) {
        const item = run.items.find((value) => value.itemId === itemId);
        if (!item) { skipped.push({ itemId, reason: "not_found" }); continue; }
        if (!isActiveStatus(item.status)) { skipped.push({ itemId, reason: "job_is_finished" }); continue; }
        acceptedItemIds.push(itemId);
        item.cancelRequestedAt = new Date();
        const execution = this.executions.get(this.key(runId, itemId));
        if (execution) { contexts.push(execution); execution.controller.abort(new Error("Job cancelled")); }
        else {
          item.status = "cancelled"; item.finishedAt = new Date(); item.errorMessage = "Job cancelled";
          item.steps = item.steps.map((step) => isActiveStatus(step.status) ? { ...step, status: "cancelled", finishedAt: new Date() } : step);
        }
      }
      if (!run.items.length && isActiveStatus(run.status)) {
        run.status = "cancelled"; run.finishedAt = new Date();
        run.steps = run.steps.map((step) => isActiveStatus(step.status) ? { ...step, status: "cancelled", finishedAt: new Date() } : step);
      }
    });
    await Promise.all(contexts.map((execution) => execution.done));
    return { run: await this.readRun(userId, runId), acceptedItemIds, skipped };
  }
  async rerunFromNode(userId: string, runId: string, nodeId?: string, itemId?: string, itemIds?: string[]) {
    if (this.shuttingDown) throw new HttpError(503, "Backend is shutting down");
    const acceptedItemIds: string[] = [];
    const skipped: BatchResult["skipped"] = [];
    await this.locked(runId, async () => {
      const run = await this.readRun(userId, runId);
      const current = await WorkflowModel.findOne({ _id: run.workflowId, userId }).lean();
      const graph = run.workflowSnapshot || (current ? { ...repairWorkflowGraphHandles(workflowGraphSchema.parse(current)), name: current.name } : undefined);
      if (!graph) throw new HttpError(404, "Workflow configuration not found");
      const order = this.resolveExecutionOrder(graph.nodes, graph.edges);
      this.updateLimits(userId, String(run.workflowId), current ? workflowGraphSchema.parse(current).nodes : graph.nodes, current?.updatedAt);
      if (!run.items.length && run.workingDir) {
        run.items = [{ itemId: "legacy", index: 0, label: "Job 1", status: run.status as RunItem["status"],
          workingDir: run.workingDir, steps: run.steps, inputFiles: run.inputFiles, outputFiles: run.outputFiles }];
      }
      const ids = [...new Set(itemIds || (itemId ? [itemId] : run.items.filter((item) => ["failed", "cancelled"].includes(item.status)).map((item) => item.itemId)))];
      const launch: Array<Omit<Execution, "controller" | "done">> = [];
      for (const id of ids) {
        const item = run.items.find((value) => value.itemId === id);
        try {
          if (!item) throw new Error("not_found");
          if (!["failed", "cancelled"].includes(item.status) || this.executions.has(this.key(runId, id))) throw new Error("job_is_active_or_not_rerunnable");
          if (!item.workingDir) throw new Error("Job has no working directory");
          const byNode = new Map(item.steps.map((step) => [step.nodeId, step]));
          if (!run.workflowSnapshot && (order.length !== item.steps.length || order.some((node) => !byNode.has(node.id)))) {
            throw new Error("Workflow structure changed; restore the original workflow or start a new run");
          }
          const blocked = order.findIndex((node) => byNode.get(node.id)?.status !== "success");
          const startIndex = nodeId ? order.findIndex((node) => node.id === nodeId) : blocked;
          if (startIndex < 0 || (blocked >= 0 && startIndex > blocked)) throw new Error("Rerun from the first failed or cancelled step first");
          for (const file of item.inputFiles || []) {
            fileStorageService.assertUserOwnsPath(userId, file.relativePath);
            await fs.access(fileStorageService.resolveRelativePath(file.relativePath));
          }
          for (const node of order.slice(0, startIndex)) {
            const step = byNode.get(node.id);
            if (!step || step.status !== "success") throw new Error(`Step ${node.label} has no reusable result`);
            for (const output of node.outputs.filter((output) => output.type === "file")) {
              const relative = step.outputs?.[output.name];
              if (!relative) throw new Error(`Missing previous output ${node.label}/${output.name}`);
              fileStorageService.assertUserOwnsPath(userId, relative);
              await fs.access(fileStorageService.resolveRelativePath(relative));
            }
          }
          const attemptId = randomUUID();
          const root = fileStorageService.resolveRelativePath(item.workingDir);
          const dirs = { runDir: root, inputDir: path.join(root, "input"), tempDir: path.join(root, "temp", attemptId),
            outputDir: path.join(root, "output", attemptId), logsDir: path.join(root, "logs", attemptId) };
          await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })));
          const previousSteps = item.steps;
          const retainedPaths = new Set(order.slice(0, startIndex).flatMap((node) => Object.values(byNode.get(node.id)?.outputs || {})));
          const outputs = (item.outputFiles || []).filter((file) => retainedPaths.has(file.relativePath));
          item.steps = order.map((node, index) => index < startIndex ? byNode.get(node.id)! : { nodeId: node.id, label: node.label, status: "await", attemptId });
          Object.assign(item, { status: "await", attemptId, outputFiles: outputs });
          delete item.startedAt; delete item.finishedAt; delete item.errorMessage; delete item.cancelRequestedAt; delete item.waitReason; delete item.process;
          acceptedItemIds.push(id);
          launch.push({ runId, userId, workflowId: String(run.workflowId), graph, order, attemptId, startIndex, previousSteps, outputs,
            item: { itemId: id, index: item.index, label: item.label, dirs,
              inputFiles: (item.inputFiles || []).map((file) => this.normalizeStoredFile(file)), inputValues: item.inputValues || [], exportDir: item.exportDir } });
        } catch (error) { skipped.push({ itemId: id, reason: error instanceof Error ? error.message : "Rerun failed" }); }
      }
      if (acceptedItemIds.length) {
        run.workflowSnapshot ||= graph;
        delete run.finishedAt; delete run.errorMessage;
        await this.persist(run, acceptedItemIds);
        // Register every context before releasing the admission lock.
        for (const input of launch) this.launch(input);
      }
    });
    return { run: await this.readRun(userId, runId), acceptedItemIds, skipped };
  }
  private launch(input: Omit<Execution, "controller" | "done">) {
    const execution: Execution = { ...input, controller: new AbortController(), done: Promise.resolve() };
    if (this.shuttingDown) execution.controller.abort(new Error("Backend stopped; rerun to continue"));
    this.executions.set(this.key(input.runId, input.item.itemId), execution);
    execution.done = this.executeItem(execution).catch((error) => console.error("Execution persistence failed", error)).finally(() => {
      if (this.executions.get(this.key(input.runId, input.item.itemId)) === execution) this.executions.delete(this.key(input.runId, input.item.itemId));
    });
  }
  private async changeItem(execution: Execution, change: (item: RunItem) => void) {
    return this.mutate(execution.userId, execution.runId, execution.item.itemId, execution.attemptId, (_run, item) => {
      if (item!.status === "cancelled" && !execution.controller.signal.aborted) {
        execution.controller.abort(new Error("Job cancelled"));
        return;
      }
      change(item!);
    });
  }
  private async executeItem(execution: Execution) {
    const { item, order, graph, controller, runId, userId } = execution;
    const files = new Map(item.inputFiles.map((file) => [file.name, file.relativePath]));
    const texts = new Map(item.inputValues.map((value) => [value.name, value.value]));
    const nodeOutputs = new Map<string, NodeOutputValues>();
    for (const node of order.slice(0, execution.startIndex)) {
      const step = execution.previousSteps.find((step) => step.nodeId === node.id)!;
      const values = step.outputs || {};
      nodeOutputs.set(node.id, { stepByName: values, templateByName: Object.fromEntries(Object.entries(values).map(([name, value]) => [name,
        node.outputs.find((output) => output.name === name)?.type === "file" ? fileStorageService.resolveRelativePath(value) : value])) });
    }
    let activeIndex = execution.startIndex;
    try {
      for (let index = execution.startIndex; index < order.length; index++) {
        activeIndex = index;
        controller.signal.throwIfAborted();
        const node = order[index];
        if (node.type === "fileInput") {
          const outputs = this.resolveInputNode(node, files, texts);
          await this.copyAutoDownloadFiles({ runId, userId, itemId: item.itemId, node, exportDir: item.exportDir,
            resolvedInputs: { stepByName: {}, templateByName: {} }, resolvedOutputs: { relativeByName: outputs.stepByName, absoluteByName: outputs.templateByName } });
          controller.signal.throwIfAborted();
          await this.changeItem(execution, (current) => Object.assign(current.steps[index], { status: "success", startedAt: new Date(), finishedAt: new Date(), outputs: outputs.stepByName }));
          nodeOutputs.set(node.id, outputs);
          continue;
        }
        await this.changeItem(execution, (current) => { current.status = "await"; current.waitReason = `Waiting for ${node.label}`; });
        const release = await executionScheduler.acquire(`${userId}:${execution.workflowId}:${node.id}`, controller.signal);
        try {
          controller.signal.throwIfAborted();
          const inputs = this.resolveNodeInputs(node, graph.edges, nodeOutputs, files, texts);
          const outputs = this.buildNodeOutputs(node, item.dirs.outputDir);
          await this.runNode(execution, index, inputs, outputs);
          nodeOutputs.set(node.id, { stepByName: outputs.relativeByName, templateByName: outputs.absoluteByName });
          const outputFiles = this.outputFilesForNode(node, outputs.relativeByName, item.itemId);
          for (const file of outputFiles) file.size = (await fs.stat(fileStorageService.resolveRelativePath(file.relativePath))).size;
          execution.outputs.push(...outputFiles);
          await this.changeItem(execution, (current) => {
            current.outputFiles = [...execution.outputs];
            Object.assign(current.steps[index], { status: "success", finishedAt: new Date(), exitCode: 0 });
          });
        } finally { release(); }
      }
      controller.signal.throwIfAborted();
      await this.changeItem(execution, (current) => {
        current.status = "success"; current.finishedAt = new Date(); delete current.waitReason; delete current.process; delete current.cancelRequestedAt;
      });
    } catch (error) {
      const cancelled = controller.signal.aborted && !execution.failure;
      const status = cancelled ? "cancelled" : "failed";
      const message = (execution.failure || error) instanceof Error ? (execution.failure || error as Error).message : "Job failed";
      await this.changeItem(execution, (current) => {
        current.status = status; current.finishedAt = new Date(); current.errorMessage = message;
        delete current.waitReason; delete current.process; delete current.cancelRequestedAt;
        current.steps = current.steps.map((step, index) => !isActiveStatus(step.status) ? step : {
          ...step, status: cancelled ? "cancelled" : index === activeIndex ? "failed" : "skipped", finishedAt: new Date(),
          ...(index === activeIndex ? { errorMessage: message, exitCode: (error as { exitCode?: number }).exitCode } : {}) });
      });
    }
  }
  private async runNode(execution: Execution, index: number, inputs: ResolvedValues,
    outputs: { relativeByName: Record<string, string>; absoluteByName: Record<string, string> }) {
    const { item, controller, runId, userId, attemptId } = execution;
    const node = execution.order[index];
    const scope = { inputs: inputs.templateByName, outputs: outputs.absoluteByName,
      params: { ...(node.defaultParams || {}), ...(await this.readRun(userId, runId)).params },
      runDir: item.dirs.runDir, inputDir: item.dirs.inputDir, outputDir: item.dirs.outputDir, tempDir: item.dirs.tempDir };
    const bin = this.resolveTemplate(node.toolConfig.bin, scope, node.label);
    const args = node.toolConfig.args.map((arg) => this.resolveTemplate(arg, scope, node.label));
    const env = Object.fromEntries(Object.entries(node.toolConfig.env || {}).map(([key, value]) => [key, this.resolveTemplate(value, scope, node.label)]));
    const cwd = node.toolConfig.workingDir ? path.resolve(this.resolveTemplate(node.toolConfig.workingDir, scope, node.label)) : process.cwd();
    const logsDir = path.join(item.dirs.runDir, "logs", attemptId);
    await fs.mkdir(logsDir, { recursive: true });
    const logPath = path.join(logsDir, `${sanitizeFileName(node.id)}.log`);
    await this.changeItem(execution, (current) => {
      current.status = "running"; current.startedAt ||= new Date(); delete current.waitReason;
      Object.assign(current.steps[index], { status: "running", startedAt: new Date(), command: bin, args,
        inputs: inputs.stepByName, outputs: outputs.relativeByName, logPath: fileStorageService.relativeFromAbsolute(logPath), attemptId });
    });
    controller.signal.throwIfAborted();
    const log = createWriteStream(logPath, { flags: "a" });
    const completion = finished(log);
    completion.catch(() => undefined);
    log.on("error", (error) => { execution.failure = error; controller.abort(error); });
    const notify = () => socketService.notifyLog(runId, item.itemId, node.id, attemptId);
    const write = (chunk: Buffer | string) => log.write(chunk, notify);
    write(`[runner] cwd: ${cwd}\n[runner] command: ${JSON.stringify([bin, ...args])}\n`);
    try {
      await runSupervisedCommand({ bin, args, cwd, env, signal: controller.signal, timeoutSeconds: node.toolConfig.timeoutSeconds,
        register: async (identity) => { await this.changeItem(execution, (current) => { current.process = identity; }); },
        log: write, onDrain: (resume) => log.on("drain", resume) });
      controller.signal.throwIfAborted();
      for (const output of Object.values(outputs.absoluteByName)) {
        const stat = await fs.stat(output).catch(() => undefined);
        if (!stat?.isFile()) throw new Error(`Declared output file was not created: ${output}`);
      }
      write("[runner] command finished successfully\n");
    } catch (error) {
      write(`[runner] ${error instanceof Error ? error.message : "Command failed"}\n`);
      throw error;
    } finally { log.end(); await completion; notify(); }
    await this.copyAutoDownloadFiles({ runId, userId, itemId: item.itemId, node, exportDir: item.exportDir,
      resolvedInputs: inputs, resolvedOutputs: outputs, logPath });
    controller.signal.throwIfAborted();
    await this.changeItem(execution, (current) => { delete current.process; });
  }
  async recoverInterruptedRuns() {
    const cursor = RunModel.find({ $or: [
      { status: { $in: ["await", "pending", "running"] } }, { "items.status": { $in: ["await", "pending", "running"] } },
      { "steps.status": "waiting" }, { "items.steps.status": "waiting" }, { "items.process": { $exists: true } }
    ] }).lean().cursor();
    let recovered = 0;
    for await (const document of cursor) {
      const run = document as unknown as StoredRun;
      for (const item of run.items || []) if (item.process) await stopOwnedProcess(item.process);
      const before = JSON.stringify(run);
      recoverRun(run as unknown as Parameters<typeof recoverRun>[0]);
      if (JSON.stringify(run) !== before) {
        run.revision = (run.revision || 0) + 1;
        await RunModel.updateOne({ _id: run._id }, { $set: { status: run.status, items: run.items, steps: run.steps,
          revision: run.revision,
          ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}), ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}) } });
        if (run.workingDir) await fileStorageService.writeManifest(fileStorageService.resolveRelativePath(run.workingDir), run).catch(() => undefined);
        recovered++;
      }
    }
    return recovered;
  }
  async shutdown() {
    this.shuttingDown = true;
    const executions = [...this.executions.values()];
    for (const execution of executions) execution.controller.abort(new Error("Backend stopped; rerun to continue"));
    await Promise.all(executions.map((execution) => execution.done));
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
      | { kind: "text"; inputName: string; value: string; exportRoot?: string };

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
      const exportRoot = input.exportDirs[inputName]?.find((value) => value?.trim())?.trim();
      for (const value of normalizedValues) {
        if (!value) continue;
        appendValue(inputName, { kind: "text", inputName, value, exportRoot });
      }
    }

    const batchSize = Math.max(1, ...Array.from(valuesByInput.values()).map((values) => values.length));
    for (const [inputName, values] of valuesByInput.entries()) {
      if (values.length !== 1 && values.length !== batchSize) {
        throw new HttpError(400, `Input "${inputName}" has ${values.length} values, but this batch needs 1 or ${batchSize}`);
      }
    }

    const configuredTextExportRoots = Array.from(valuesByInput.values())
      .flatMap((values) => values)
      .flatMap((value) => (value.kind === "text" && value.exportRoot ? [value.exportRoot] : []));
    const relativeTextExportRoot = configuredTextExportRoots.find((exportRoot) => !path.isAbsolute(exportRoot));
    if (relativeTextExportRoot) {
      throw new HttpError(400, `Auto download root folder must be an absolute path: ${relativeTextExportRoot}`);
    }
    const textExportRoots = Array.from(new Set(configuredTextExportRoots.map((exportRoot) => path.resolve(exportRoot))));
    if (textExportRoots.length > 1) {
      throw new HttpError(400, "All text inputs must use the same auto download root folder");
    }
    const allocatedTextExportDirs = textExportRoots[0]
      ? await this.allocateSequentialExportDirs(textExportRoots[0], batchSize)
      : [];

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
      const directExportDirs: string[] = [];

      for (const values of valuesByInput.values()) {
        const value = values[values.length === 1 ? 0 : index];
        if (!value) continue;
        if (value.kind !== "text" && value.exportDir?.trim()) {
          directExportDirs.push(value.exportDir.trim());
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
        exportDir: allocatedTextExportDirs[index] || directExportDirs[0]
      });
    }

    return items;
  }

  private async allocateSequentialExportDirs(exportRoot: string, count: number) {
    if (!path.isAbsolute(exportRoot)) {
      throw new HttpError(400, `Auto download root folder must be an absolute path: ${exportRoot}`);
    }

    const resolvedRoot = path.resolve(exportRoot);
    await fs.mkdir(resolvedRoot, { recursive: true });
    const entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
    const largestFolderNumber = entries.reduce((largest, entry) => {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
        return largest;
      }
      const folderNumber = Number(entry.name);
      return Number.isSafeInteger(folderNumber) ? Math.max(largest, folderNumber) : largest;
    }, 0);

    const allocated: string[] = [];
    let nextFolderNumber = largestFolderNumber + 1;
    while (allocated.length < count) {
      const candidate = path.join(resolvedRoot, String(nextFolderNumber));
      nextFolderNumber += 1;
      try {
        await fs.mkdir(candidate);
        allocated.push(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          continue;
        }
        throw error;
      }
    }

    return allocated;
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
    const attemptId = this.executions.get(this.key(input.runId, input.itemId))?.attemptId;
    if (attemptId) socketService.notifyLog(input.runId, input.itemId, input.nodeId, attemptId);
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


}

export const workflowRunnerService = new WorkflowRunnerService();
