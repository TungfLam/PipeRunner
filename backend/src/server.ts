import http from "http";
import cors from "cors";
import express from "express";
import mongoose from "mongoose";
import morgan from "morgan";
import { corsOptions } from "./config/cors";
import { env } from "./config/env";
import { errorHandler } from "./middleware/errorHandler";
import { authRouter } from "./routes/auth.routes";
import { filesRouter } from "./routes/files.routes";
import { projectsRouter } from "./routes/projects.routes";
import { runsRouter } from "./routes/runs.routes";
import { workflowsRouter } from "./routes/workflows.routes";
import { fileStorageService } from "./services/fileStorage.service";
import { socketService } from "./services/socket.service";

async function main() {
  await fileStorageService.ensureRoot();
  await mongoose.connect(env.MONGODB_URI);

  const app = express();
  app.use(cors(corsOptions));
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan(env.NODE_ENV === "development" ? "dev" : "combined"));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/projects", projectsRouter);
  app.use("/api/workflows", workflowsRouter);
  app.use("/api/runs", runsRouter);
  app.use("/api/files", filesRouter);
  app.use(errorHandler);

  const server = http.createServer(app);
  socketService.initialize(server);

  server.listen(env.PORT, () => {
    console.log(`Backend listening on http://localhost:${env.PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
