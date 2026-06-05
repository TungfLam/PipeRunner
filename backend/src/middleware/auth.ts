import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { UserModel } from "../models/User";
import { HttpError } from "../utils/httpError";

export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    username: string;
  };
}

interface JwtPayload {
  sub: string;
  username: string;
}

export async function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token) {
      throw new HttpError(401, "Missing bearer token");
    }

    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    const user = await UserModel.findById(payload.sub).select("_id username").lean();
    if (!user) {
      throw new HttpError(401, "Invalid token user");
    }

    (req as AuthenticatedRequest).user = {
      id: String(user._id),
      username: user.username
    };
    next();
  } catch (error) {
    next(error instanceof HttpError ? error : new HttpError(401, "Invalid token"));
  }
}
