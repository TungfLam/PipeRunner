import bcrypt from "bcrypt";
import type { Response } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env";
import type { AuthenticatedRequest } from "../middleware/auth";
import { UserModel } from "../models/User";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/httpError";

const authSchema = z.object({
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(8).max(200)
});

function signToken(user: { _id: unknown; username: string }) {
  return jwt.sign({ username: user.username }, env.JWT_SECRET, {
    subject: String(user._id),
    expiresIn: "30d"
  });
}

function publicUser(user: { _id: unknown; username: string; createdAt?: Date; updatedAt?: Date }) {
  return {
    id: String(user._id),
    username: user.username,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

export const register = asyncHandler(async (req, res: Response) => {
  const body = authSchema.parse(req.body);
  const existing = await UserModel.findOne({ username: body.username.toLowerCase() }).lean();
  if (existing) {
    throw new HttpError(409, "Username is already registered");
  }

  const passwordHash = await bcrypt.hash(body.password, 12);
  const user = await UserModel.create({
    username: body.username.toLowerCase(),
    passwordHash
  });

  res.status(201).json({
    token: signToken(user),
    user: publicUser(user)
  });
});

export const login = asyncHandler(async (req, res: Response) => {
  const body = authSchema.parse(req.body);
  const user = await UserModel.findOne({ username: body.username.toLowerCase() });
  if (!user) {
    throw new HttpError(401, "Invalid username or password");
  }

  const valid = await bcrypt.compare(body.password, user.passwordHash);
  if (!valid) {
    throw new HttpError(401, "Invalid username or password");
  }

  res.json({
    token: signToken(user),
    user: publicUser(user)
  });
});

export const me = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  res.json({ user: req.user });
});
