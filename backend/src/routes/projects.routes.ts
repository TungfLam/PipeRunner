import { Router } from "express";
import multer from "multer";
import { env } from "../config/env";
import { listProjectFiles, uploadProjectFiles } from "../controllers/files.controller";
import { createProject, deleteProject, getProject, listProjects, updateProject } from "../controllers/projects.controller";
import { createWorkflow, listWorkflows } from "../controllers/workflows.controller";
import { authMiddleware } from "../middleware/auth";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MAX_UPLOAD_MB * 1024 * 1024
  }
});

export const projectsRouter = Router();

projectsRouter.use(authMiddleware);
projectsRouter.get("/", listProjects);
projectsRouter.post("/", createProject);
projectsRouter.get("/:projectId", getProject);
projectsRouter.patch("/:projectId", updateProject);
projectsRouter.delete("/:projectId", deleteProject);

projectsRouter.get("/:projectId/workflows", listWorkflows);
projectsRouter.post("/:projectId/workflows", createWorkflow);

projectsRouter.post("/:projectId/files/upload", upload.any(), uploadProjectFiles);
projectsRouter.get("/:projectId/files", listProjectFiles);
