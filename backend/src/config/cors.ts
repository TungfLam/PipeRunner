import type { CorsOptions } from "cors";
import { env } from "./env";

const configuredOrigins = env.FRONTEND_URL.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function isPrivateNetworkHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  );
}

export function isAllowedCorsOrigin(origin?: string) {
  if (!origin) {
    return true;
  }

  if (configuredOrigins.includes(origin)) {
    return true;
  }

  if (env.NODE_ENV !== "production") {
    try {
      const parsed = new URL(origin);
      return ["http:", "https:"].includes(parsed.protocol) && isPrivateNetworkHost(parsed.hostname);
    } catch {
      return false;
    }
  }

  return false;
}

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (isAllowedCorsOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true
};
