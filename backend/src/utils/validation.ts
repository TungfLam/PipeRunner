import { z } from "zod";

const envRecordSchema = z.record(z.string(), z.string()).default({});

export const nodeInputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["file", "text", "number", "boolean"]).default("file"),
  flag: z.string().optional(),
  accept: z.array(z.string()).optional().default([]),
  required: z.boolean().optional().default(false)
});

export const nodeOutputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["file", "text"]).default("file"),
  flag: z.string().optional(),
  extension: z.string().optional(),
  preview: z.enum(["video", "audio", "text", "json", "image"]).optional()
});

export const workflowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1).default("tool"),
  label: z.string().min(1),
  position: z.object({
    x: z.number(),
    y: z.number()
  }),
  toolConfig: z.object({
    bin: z.string().min(1),
    args: z.array(z.string()).default([]),
    workingDir: z.string().optional(),
    env: envRecordSchema.optional(),
    timeoutSeconds: z.number().positive().optional(),
    maxConcurrent: z.number().int().positive().max(100).optional()
  }),
  inputs: z.array(nodeInputSchema).default([]),
  outputs: z.array(nodeOutputSchema).default([]),
  defaultParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().default({})
});

export const workflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional()
});

export const workflowGraphSchema = z.object({
  nodes: z.array(workflowNodeSchema).default([]),
  edges: z.array(workflowEdgeSchema).default([])
});
