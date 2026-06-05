import type { Response } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth";
import { ProjectModel } from "../models/Project";
import { RunModel } from "../models/Run";
import { WorkflowModel } from "../models/Workflow";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/httpError";
import { workflowGraphSchema } from "../utils/validation";
import { repairWorkflowGraphHandles } from "../utils/workflowHandles";

const workflowBaseSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(3000).optional().default(""),
  nodes: workflowGraphSchema.shape.nodes.optional().default([]),
  edges: workflowGraphSchema.shape.edges.optional().default([])
});

function refineWorkflowEdges(value: { nodes?: Array<{ id: string }>; edges?: Array<{ id: string; source: string; target: string }> }, context: z.RefinementCtx) {
    if (!value.nodes || !value.edges) {
      return;
    }
    const ids = new Set((value.nodes || []).map((node) => node.id));
    for (const edge of value.edges || []) {
      if (!ids.has(edge.source) || !ids.has(edge.target)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Edge ${edge.id} references a missing node`,
          path: ["edges"]
        });
      }
    }
}

const workflowBodySchema = workflowBaseSchema.superRefine(refineWorkflowEdges);
const workflowUpdateSchema = workflowBaseSchema.partial().superRefine(refineWorkflowEdges);

function repairWorkflowBody<T extends { nodes?: unknown[]; edges?: unknown[] }>(body: T): T {
  if (!body.nodes || !body.edges) {
    return body;
  }
  const graph = repairWorkflowGraphHandles(workflowGraphSchema.parse({ nodes: body.nodes, edges: body.edges }));
  return {
    ...body,
    nodes: graph.nodes,
    edges: graph.edges
  };
}

export const listWorkflows = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const project = await ProjectModel.findOne({ _id: req.params.projectId, userId: req.user.id }).select("_id").lean();
  if (!project) {
    throw new HttpError(404, "Project not found");
  }
  const workflows = await WorkflowModel.find({ projectId: project._id, userId: req.user.id }).sort({ updatedAt: -1 }).lean();
  res.json({ workflows });
});

export const createWorkflow = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const project = await ProjectModel.findOne({ _id: req.params.projectId, userId: req.user.id }).select("_id").lean();
  if (!project) {
    throw new HttpError(404, "Project not found");
  }
  const body = repairWorkflowBody(workflowBodySchema.parse(req.body));
  const workflow = await WorkflowModel.create({
    ...body,
    projectId: project._id,
    userId: req.user.id
  });
  res.status(201).json({ workflow });
});

export const getWorkflow = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const workflow = await WorkflowModel.findOne({ _id: req.params.workflowId, userId: req.user.id }).lean();
  if (!workflow) {
    throw new HttpError(404, "Workflow not found");
  }
  res.json({ workflow });
});

export const updateWorkflow = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const body = repairWorkflowBody(workflowUpdateSchema.parse(req.body));
  const workflow = await WorkflowModel.findOneAndUpdate(
    { _id: req.params.workflowId, userId: req.user.id },
    { $set: body },
    { new: true }
  ).lean();
  if (!workflow) {
    throw new HttpError(404, "Workflow not found");
  }
  res.json({ workflow });
});

export const deleteWorkflow = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const workflow = await WorkflowModel.findOneAndDelete({ _id: req.params.workflowId, userId: req.user.id }).lean();
  if (!workflow) {
    throw new HttpError(404, "Workflow not found");
  }
  await RunModel.deleteMany({ workflowId: workflow._id, userId: req.user.id });
  res.status(204).send();
});
