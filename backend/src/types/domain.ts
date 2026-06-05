import type { Types } from "mongoose";

export type MongoId = Types.ObjectId | string;

export type PreviewType = "video" | "audio" | "text" | "json" | "image";
export type RunStatus = "pending" | "running" | "success" | "failed" | "cancelled";
export type StepStatus = "waiting" | "running" | "success" | "failed" | "skipped" | "cancelled";

export interface ToolCommandConfig {
  bin: string;
  args: string[];
  workingDir?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface WorkflowInputDefinition {
  name: string;
  type: "file" | "text" | "number" | "boolean";
  flag?: string;
  accept?: string[];
  required?: boolean;
}

export interface WorkflowOutputDefinition {
  name: string;
  type: "file";
  flag?: string;
  extension?: string;
  preview?: PreviewType;
}

export interface WorkflowNode {
  id: string;
  type: string;
  label: string;
  position: {
    x: number;
    y: number;
  };
  toolConfig: ToolCommandConfig;
  inputs: WorkflowInputDefinition[];
  outputs: WorkflowOutputDefinition[];
  defaultParams?: Record<string, string | number | boolean>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface StoredFile {
  name: string;
  originalName?: string;
  mimeType?: string;
  size?: number;
  relativePath: string;
  preview?: PreviewType;
}

export interface RunStep {
  nodeId: string;
  label: string;
  status: StepStatus;
  startedAt?: Date;
  finishedAt?: Date;
  exitCode?: number | null;
  command?: string;
  args?: string[];
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  logPath?: string;
  errorMessage?: string;
}
