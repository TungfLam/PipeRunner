import { Schema, model, type InferSchemaType } from "mongoose";

const fileSchema = new Schema(
  {
    name: { type: String, required: true },
    originalName: { type: String },
    mimeType: { type: String },
    size: { type: Number },
    relativePath: { type: String, required: true },
    preview: { type: String, enum: ["video", "audio", "text", "json", "image"] },
    itemId: { type: String }
  },
  { _id: false }
);

const runStepSchema = new Schema(
  {
    nodeId: { type: String, required: true },
    attemptId: { type: String },
    label: { type: String, required: true },
    status: {
      type: String,
      enum: ["await", "running", "success", "failed", "skipped", "cancelled"],
      default: "await"
    },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    exitCode: { type: Number },
    command: { type: String },
    args: [{ type: String }],
    inputs: { type: Schema.Types.Mixed, default: {} },
    outputs: { type: Schema.Types.Mixed, default: {} },
    logPath: { type: String },
    errorMessage: { type: String }
  },
  { _id: false }
);

const inputValueSchema = new Schema(
  {
    name: { type: String, required: true },
    type: { type: String, enum: ["text"], default: "text" },
    value: { type: String, required: true }
  },
  { _id: false }
);

const runItemSchema = new Schema(
  {
    itemId: { type: String, required: true },
    attemptId: { type: String },
    waitReason: { type: String },
    cancelRequestedAt: { type: Date },
    process: { type: Schema.Types.Mixed },
    index: { type: Number, required: true },
    label: { type: String, required: true },
    status: {
      type: String,
      enum: ["await", "running", "success", "failed", "cancelled"],
      default: "await"
    },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    workingDir: { type: String },
    exportDir: { type: String },
    inputFiles: [fileSchema],
    inputValues: [inputValueSchema],
    outputFiles: [fileSchema],
    steps: [runStepSchema],
    errorMessage: { type: String }
  },
  { _id: false }
);

const runSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    workflowId: { type: Schema.Types.ObjectId, ref: "Workflow", required: true, index: true },
    status: {
      type: String,
      enum: ["await", "running", "success", "failed", "cancelled"],
      default: "await",
      index: true
    },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    workingDir: { type: String },
    inputFiles: [fileSchema],
    outputFiles: [fileSchema],
    steps: [runStepSchema],
    items: [runItemSchema],
    params: { type: Schema.Types.Mixed, default: {} },
    workflowSnapshot: { type: Schema.Types.Mixed },
    revision: { type: Number, default: 0 },
    errorMessage: { type: String }
  },
  { timestamps: true }
);

runSchema.index({ userId: 1, workflowId: 1, createdAt: -1 });

export type RunDocument = InferSchemaType<typeof runSchema> & { _id: unknown };
export const RunModel = model("Run", runSchema);
