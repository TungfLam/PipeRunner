import { Router } from "express";
import { downloadFile, previewFile } from "../controllers/files.controller";
import { authMiddleware } from "../middleware/auth";

export const filesRouter = Router();

filesRouter.use(authMiddleware);
filesRouter.get("/preview", previewFile);
filesRouter.get("/download", downloadFile);
