import type { Response } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth";
import { RunModel } from "../models/Run";
import { WorkflowModel } from "../models/Workflow";
import { fileStorageService, sanitizeFileName } from "../services/fileStorage.service";
import { workflowRunnerService } from "../services/workflowRunner.service";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/httpError";

const runBodySchema = z.object({
  inputs: z.record(z.string(), z.string()).optional().default({}),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().default({})
});

const bulkDeleteRunsSchema = z.object({
  runIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).min(1).max(200)
});

function parseJsonField(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }
  if (!value.trim()) {
    return undefined;
  }
  return JSON.parse(value);
}

export const createRun = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const body = runBodySchema.parse({
    inputs: parseJsonField(req.body.inputs),
    params: parseJsonField(req.body.params)
  });
  const run = await workflowRunnerService.startRun({
    userId: req.user.id,
    workflowId: req.params.workflowId,
    selectedInputs: body.inputs,
    uploadedFiles: Array.isArray(req.files) ? req.files : [],
    params: body.params
  });
  res.status(201).json({ run });
});

export const listWorkflowRuns = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const workflow = await WorkflowModel.findOne({ _id: req.params.workflowId, userId: req.user.id }).select("_id").lean();
  if (!workflow) {
    throw new HttpError(404, "Workflow not found");
  }
  const filter: Record<string, unknown> = { workflowId: workflow._id, userId: req.user.id };
  if (typeof req.query.status === "string" && req.query.status) {
    filter.status = req.query.status;
  }
  const runs = await RunModel.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  const runsWithStorage = await Promise.all(
    runs.map(async (run) => {
      const fallbackSize = [...(run.inputFiles || []), ...(run.outputFiles || [])].reduce(
        (total, file) => total + (file.size || 0),
        0
      );
      const storageBytes = run.workingDir
        ? await fileStorageService.estimateRelativePathSize(req.user.id, run.workingDir).catch(() => fallbackSize)
        : fallbackSize;
      return { ...run, storageBytes };
    })
  );
  res.json({ runs: runsWithStorage });
});

export const getRun = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const run = await RunModel.findOne({ _id: req.params.runId, userId: req.user.id }).lean();
  if (!run) {
    throw new HttpError(404, "Run not found");
  }
  res.json({ run });
});

export const cancelRun = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const run = await workflowRunnerService.cancelRun(req.user.id, req.params.runId);
  res.json({ run });
});

export const bulkDeleteRuns = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const { runIds } = bulkDeleteRunsSchema.parse(req.body);
  const uniqueRunIds = Array.from(new Set(runIds));
  const runs = await RunModel.find({ _id: { $in: uniqueRunIds }, userId: req.user.id }).lean();
  const runById = new Map(runs.map((run) => [String(run._id), run]));

  const deleted: string[] = [];
  const skipped: Array<{ runId: string; reason: string }> = [];

  for (const runId of uniqueRunIds) {
    const run = runById.get(runId);
    if (!run) {
      skipped.push({ runId, reason: "not_found" });
      continue;
    }

    if (run.status === "running" || run.status === "pending") {
      skipped.push({ runId, reason: "run_is_active" });
      continue;
    }

    if (run.workingDir) {
      await fileStorageService.removeRelativePath(req.user.id, run.workingDir);
    }
    await RunModel.deleteOne({ _id: runId, userId: req.user.id });
    deleted.push(runId);
  }

  res.json({ deleted, skipped });
});

export const getRunLogs = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const run = await RunModel.findOne({ _id: req.params.runId, userId: req.user.id }).lean();
  if (!run) {
    throw new HttpError(404, "Run not found");
  }

  const logs = await Promise.all(
    (run.steps || [])
      .filter((step) => !req.query.nodeId || step.nodeId === req.query.nodeId)
      .map(async (step) => {
        const guessedLogPath = run.workingDir ? `${run.workingDir}/logs/${sanitizeFileName(step.nodeId)}.log` : undefined;
        const logPath = step.logPath || guessedLogPath;
        if (!logPath) {
          return { nodeId: step.nodeId, label: step.label, log: "" };
        }
        fileStorageService.assertUserOwnsPath(req.user.id, logPath);
        const log = await fileStorageService.readText(logPath, 5_000_000).catch(() => "");
        return { nodeId: step.nodeId, label: step.label, logPath, log };
      })
  );

  res.json({ logs });
});

export const getRunFiles = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const run = await RunModel.findOne({ _id: req.params.runId, userId: req.user.id }).select("inputFiles outputFiles").lean();
  if (!run) {
    throw new HttpError(404, "Run not found");
  }
  res.json({ inputFiles: run.inputFiles || [], outputFiles: run.outputFiles || [] });
});

export const downloadRunFile = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const relativePath = String(req.query.path || "");
  fileStorageService.assertUserOwnsPath(req.user.id, relativePath);
  const run = await RunModel.findOne({
    _id: req.params.runId,
    userId: req.user.id,
    $or: [{ "inputFiles.relativePath": relativePath }, { "outputFiles.relativePath": relativePath }, { "steps.logPath": relativePath }]
  }).lean();
  if (!run) {
    throw new HttpError(404, "Run file not found");
  }
  res.download(fileStorageService.resolveRelativePath(relativePath));
});
