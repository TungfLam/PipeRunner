import dotenv from "dotenv";
import path from "path";
import { z } from "zod";

dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().default("mongodb://localhost:27017/workflow_app"),
  JWT_SECRET: z.string().min(8, "JWT_SECRET must be at least 8 characters").default("change_me_dev_secret"),
  DATA_ROOT: z.string().default("/data/workflow-app"),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(5000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  FRONTEND_URL: z.string().default("http://localhost:5173")
});

export const env = envSchema.parse(process.env);
