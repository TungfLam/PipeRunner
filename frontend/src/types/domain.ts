export type PreviewType = "video" | "audio" | "text" | "json" | "image";
export type RunStatus = "pending" | "running" | "success" | "failed" | "cancelled";
export type StepStatus = "waiting" | "running" | "success" | "failed" | "skipped" | "cancelled";

export interface User {
  id: string;
  username: string;
}

export interface Project {
  _id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolCommandConfig {
  bin: string;
  args: string[];
  workingDir?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  maxConcurrent?: number;
}

export interface WorkflowInputDefinition {
  name: string;
  type: "file" | "text" | "number" | "boolean";
  flag?: string;
  accept?: string[];
  required?: boolean;
  autoDownload?: boolean;
}

export interface WorkflowOutputDefinition {
  name: string;
  type: "file" | "text";
  flag?: string;
  extension?: string;
  preview?: PreviewType;
  autoDownload?: boolean;
}

export interface WorkflowNodeConfig {
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

export interface WorkflowEdgeConfig {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface Workflow {
  _id: string;
  userId: string;
  projectId: string;
  name: string;
  description: string;
  nodes: WorkflowNodeConfig[];
  edges: WorkflowEdgeConfig[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredFile {
  name: string;
  originalName?: string;
  mimeType?: string;
  size?: number;
  relativePath: string;
  preview?: PreviewType;
  itemId?: string;
}

export interface RunInputValue {
  name: string;
  type: "text";
  value: string;
}

export interface RunStep {
  nodeId: string;
  label: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  command?: string;
  args?: string[];
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  logPath?: string;
  errorMessage?: string;
}

export interface WorkflowRunItem {
  itemId: string;
  index: number;
  label: string;
  status: RunStatus;
  startedAt?: string;
  finishedAt?: string;
  workingDir?: string;
  exportDir?: string;
  inputFiles?: StoredFile[];
  inputValues?: RunInputValue[];
  outputFiles?: StoredFile[];
  steps: RunStep[];
  errorMessage?: string;
}

export interface WorkflowRun {
  _id: string;
  userId: string;
  projectId: string;
  workflowId: string;
  status: RunStatus;
  startedAt?: string;
  finishedAt?: string;
  workingDir?: string;
  inputFiles: StoredFile[];
  outputFiles: StoredFile[];
  storageBytes?: number;
  steps: RunStep[];
  items?: WorkflowRunItem[];
  params?: Record<string, string | number | boolean>;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}
