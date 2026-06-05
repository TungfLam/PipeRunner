import type { Response } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth";
import { ProjectModel } from "../models/Project";
import { RunModel } from "../models/Run";
import { WorkflowModel } from "../models/Workflow";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/httpError";

const projectBodySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().default("")
});

export const listProjects = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const projects = await ProjectModel.find({ userId: req.user.id }).sort({ updatedAt: -1 }).lean();
  res.json({ projects });
});

export const createProject = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const body = projectBodySchema.parse(req.body);
  const project = await ProjectModel.create({
    ...body,
    userId: req.user.id
  });
  res.status(201).json({ project });
});

export const getProject = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const project = await ProjectModel.findOne({ _id: req.params.projectId, userId: req.user.id }).lean();
  if (!project) {
    throw new HttpError(404, "Project not found");
  }
  res.json({ project });
});

export const updateProject = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const body = projectBodySchema.partial().parse(req.body);
  const project = await ProjectModel.findOneAndUpdate(
    { _id: req.params.projectId, userId: req.user.id },
    { $set: body },
    { new: true }
  ).lean();
  if (!project) {
    throw new HttpError(404, "Project not found");
  }
  res.json({ project });
});

export const deleteProject = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const project = await ProjectModel.findOneAndDelete({ _id: req.params.projectId, userId: req.user.id }).lean();
  if (!project) {
    throw new HttpError(404, "Project not found");
  }
  await WorkflowModel.deleteMany({ projectId: project._id, userId: req.user.id });
  await RunModel.deleteMany({ projectId: project._id, userId: req.user.id });
  res.status(204).send();
});
