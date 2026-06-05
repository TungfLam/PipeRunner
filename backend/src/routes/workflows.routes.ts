import { Router } from "express";
import multer from "multer";
import { env } from "../config/env";
import { createRun, listWorkflowRuns } from "../controllers/runs.controller";
import { deleteWorkflow, getWorkflow, updateWorkflow } from "../controllers/workflows.controller";
import { authMiddleware } from "../middleware/auth";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MAX_UPLOAD_MB * 1024 * 1024
  }
});

export const workflowsRouter = Router();

workflowsRouter.use(authMiddleware);
workflowsRouter.get("/:workflowId", getWorkflow);
workflowsRouter.patch("/:workflowId", updateWorkflow);
workflowsRouter.delete("/:workflowId", deleteWorkflow);

workflowsRouter.post("/:workflowId/runs", upload.any(), createRun);
workflowsRouter.get("/:workflowId/runs", listWorkflowRuns);
