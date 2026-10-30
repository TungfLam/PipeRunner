import type { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { Server, type Socket } from "socket.io";
import { isAllowedCorsOrigin } from "../config/cors";
import { env } from "../config/env";
import { RunModel } from "../models/Run";
import { Types } from "mongoose";

interface SocketPayload {
  sub: string;
  username: string;
}

class SocketService {
  private io?: Server;
  private logTimers = new Map<string, NodeJS.Timeout>();

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
    socket.on("run:join", async (runId: string, acknowledge?: (value: unknown) => void) => {
      try {
        if (!Types.ObjectId.isValid(runId)) return;
        const run = await RunModel.findOne({ _id: runId, userId: socket.data.userId }).select("_id").lean();
        if (run) { await socket.join(this.room(runId)); acknowledge?.({ joined: true }); }
      } catch { acknowledge?.({ joined: false }); }
    });

    socket.on("run:leave", (runId: string) => {
      socket.leave(this.room(runId));
    });
    socket.on("log:watch", async (input: { runId: string; itemId: string; nodeId: string; attemptId: string }, acknowledge?: (value: unknown) => void) => {
      try {
        if (!input || !Types.ObjectId.isValid(input.runId) || ![input.itemId, input.nodeId, input.attemptId].every((value) => typeof value === "string" && value.length < 256)) return;
        for (const room of socket.rooms) if (room.startsWith("log:")) await socket.leave(room);
        if (await RunModel.exists({ _id: input.runId, userId: socket.data.userId })) {
          await socket.join(this.logRoom(input.runId, input.itemId, input.nodeId, input.attemptId));
          acknowledge?.({ joined: true });
        }
      } catch { acknowledge?.({ joined: false }); }
    });
    socket.on("log:unwatch", () => {
      for (const room of socket.rooms) if (room.startsWith("log:")) socket.leave(room);
    });
  }

  emitToRun(runId: string, event: string, payload: unknown) {
    this.io?.to(this.room(runId)).emit(event, payload);
  }

  notifyLog(runId: string, itemId: string, nodeId: string, attemptId: string) {
    const room = this.logRoom(runId, itemId, nodeId, attemptId);
    if (!this.io?.sockets.adapter.rooms.has(room)) return;
    if (this.logTimers.has(room)) return;
    const timer = setTimeout(() => {
      this.logTimers.delete(room);
      // Disk is the cursor-addressed source of truth; never buffer unbounded log
      // strings in Socket.IO, including for clients which are paused or hidden.
      this.io?.to(room).emit("log:changed", { runId, itemId, nodeId, attemptId });
    }, 250);
    timer.unref();
    this.logTimers.set(room, timer);
  }

  private logRoom(runId: string, itemId: string, nodeId: string, attemptId: string) {
    return `log:${JSON.stringify([runId, itemId, nodeId, attemptId])}`;
  }

  private room(runId: string) {
    return `run:${runId}`;
  }
}

export const socketService = new SocketService();
