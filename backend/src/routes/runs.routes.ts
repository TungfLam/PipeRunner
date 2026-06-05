import { Router } from "express";
import {
  bulkDeleteRuns,
  cancelRun,
  downloadRunFile,
  getRun,
  getRunFiles,
  getRunLogs,
  rerunRunFromStep
} from "../controllers/runs.controller";
import { authMiddleware } from "../middleware/auth";

export const runsRouter = Router();

runsRouter.use(authMiddleware);
runsRouter.post("/bulk-delete", bulkDeleteRuns);
runsRouter.get("/:runId", getRun);
runsRouter.post("/:runId/cancel", cancelRun);
runsRouter.post("/:runId/rerun", rerunRunFromStep);
runsRouter.get("/:runId/logs", getRunLogs);
runsRouter.get("/:runId/files", getRunFiles);
runsRouter.get("/:runId/files/download", downloadRunFile);
