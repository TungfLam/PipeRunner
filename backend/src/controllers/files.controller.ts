import type { Response } from "express";
import { ProjectModel } from "../models/Project";
import { fileStorageService } from "../services/fileStorage.service";
import type { AuthenticatedRequest } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/httpError";
import { previewTypeForPath } from "../utils/preview";

export const uploadProjectFiles = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const project = await ProjectModel.findOne({ _id: req.params.projectId, userId: req.user.id }).select("_id").lean();
  if (!project) {
    throw new HttpError(404, "Project not found");
  }
  const files = await Promise.all(
    (Array.isArray(req.files) ? req.files : []).map((file) =>
      fileStorageService.saveProjectUpload(req.user.id, String(project._id), file)
    )
  );
  res.status(201).json({ files });
});

export const listProjectFiles = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const project = await ProjectModel.findOne({ _id: req.params.projectId, userId: req.user.id }).select("_id").lean();
  if (!project) {
    throw new HttpError(404, "Project not found");
  }
  const files = await fileStorageService.listFilesUnder(req.user.id, `users/${req.user.id}/projects/${project._id}/files`);
  res.json({ files });
});

export const previewFile = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const relativePath = String(req.query.path || "");
  fileStorageService.assertUserOwnsPath(req.user.id, relativePath);
  const preview = previewTypeForPath(relativePath);

  if (preview === "text") {
    const text = await fileStorageService.readText(relativePath);
    res.type("text/plain").send(text);
    return;
  }

  if (preview === "json") {
    const text = await fileStorageService.readText(relativePath);
    res.type("application/json").send(text);
    return;
  }

  if (!preview) {
    throw new HttpError(415, "File type is not previewable");
  }

  res.sendFile(fileStorageService.resolveRelativePath(relativePath));
});

export const downloadFile = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const relativePath = String(req.query.path || "");
  fileStorageService.assertUserOwnsPath(req.user.id, relativePath);
  res.download(fileStorageService.resolveRelativePath(relativePath));
});
