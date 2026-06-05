import type { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { Server, type Socket } from "socket.io";
import { isAllowedCorsOrigin } from "../config/cors";
import { env } from "../config/env";
import { RunModel } from "../models/Run";

interface SocketPayload {
  sub: string;
  username: string;
}

class SocketService {
  private io?: Server;

  initialize(httpServer: HttpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin(origin, callback) {
          if (isAllowedCorsOrigin(origin)) {
            callback(null, true);
            return;
          }
          callback(new Error(`Origin not allowed by CORS: ${origin}`));
        },
        credentials: true
      }
    });

    this.io.use((socket, next) => {
      try {
        const token = socket.handshake.auth?.token || socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, "");
        if (!token) {
          return next(new Error("Missing token"));
        }
        const payload = jwt.verify(token, env.JWT_SECRET) as SocketPayload;
        socket.data.userId = payload.sub;
        socket.data.username = payload.username;
        return next();
      } catch {
        return next(new Error("Invalid token"));
      }
    });

    this.io.on("connection", (socket) => this.registerHandlers(socket));
    return this.io;
  }

  private registerHandlers(socket: Socket) {
    socket.on("run:join", async (runId: string) => {
      const run = await RunModel.findOne({ _id: runId, userId: socket.data.userId }).select("_id").lean();
      if (run) {
        socket.join(this.room(runId));
      }
    });

    socket.on("run:leave", (runId: string) => {
      socket.leave(this.room(runId));
    });
  }

  emitToRun(runId: string, event: string, payload: unknown) {
    this.io?.to(this.room(runId)).emit(event, payload);
  }

  private room(runId: string) {
    return `run:${runId}`;
  }
}

export const socketService = new SocketService();
