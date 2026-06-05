import { Schema, model, type InferSchemaType } from "mongoose";

const workflowInputSchema = new Schema(
  {
    name: { type: String, required: true },
    type: { type: String, enum: ["file", "text", "number", "boolean"], default: "file" },
    flag: { type: String },
    accept: [{ type: String }],
    required: { type: Boolean, default: false }
  },
  { _id: false }
);

const workflowOutputSchema = new Schema(
  {
    name: { type: String, required: true },
    type: { type: String, enum: ["file"], default: "file" },
    flag: { type: String },
    extension: { type: String },
    preview: { type: String, enum: ["video", "audio", "text", "json", "image"] }
  },
  { _id: false }
);

const workflowNodeSchema = new Schema(
  {
    id: { type: String, required: true },
    type: { type: String, default: "tool" },
    label: { type: String, required: true },
    position: {
      x: { type: Number, required: true },
      y: { type: Number, required: true }
    },
    toolConfig: {
      bin: { type: String, required: true },
      args: [{ type: String }],
      workingDir: { type: String },
      env: { type: Schema.Types.Mixed, default: {} },
      timeoutSeconds: { type: Number }
    },
    inputs: [workflowInputSchema],
    outputs: [workflowOutputSchema],
    defaultParams: { type: Schema.Types.Mixed, default: {} }
  },
  { _id: false }
);

const workflowEdgeSchema = new Schema(
  {
    id: { type: String, required: true },
    source: { type: String, required: true },
    target: { type: String, required: true },
    sourceHandle: { type: String },
    targetHandle: { type: String }
  },
  { _id: false }
);

const workflowSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    nodes: [workflowNodeSchema],
    edges: [workflowEdgeSchema]
  },
  { timestamps: true }
);

workflowSchema.index({ userId: 1, projectId: 1, updatedAt: -1 });

export type WorkflowDocument = InferSchemaType<typeof workflowSchema> & { _id: unknown };
export const WorkflowModel = model("Workflow", workflowSchema);
