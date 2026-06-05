import { Schema, model, type InferSchemaType } from "mongoose";

const projectSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true }
  },
  { timestamps: true }
);

projectSchema.index({ userId: 1, updatedAt: -1 });

export type ProjectDocument = InferSchemaType<typeof projectSchema> & { _id: unknown };
export const ProjectModel = model("Project", projectSchema);
