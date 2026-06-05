import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { env } from "../config/env";
import { HttpError } from "../utils/httpError";

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    return res.status(400).json({
      message: "Validation failed",
      issues: error.issues
    });
  }

  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({ message: error.message });
  }

  const statusCode = typeof error?.statusCode === "number" ? error.statusCode : 500;
  const message = statusCode === 500 ? "Internal server error" : error.message;

  if (env.NODE_ENV !== "test") {
    console.error(error);
  }

  return res.status(statusCode).json({
    message,
    ...(env.NODE_ENV === "development" ? { stack: error?.stack } : {})
  });
};
