import type { RunStatus, StepStatus } from "../types/domain";

export function statusColor(status?: RunStatus | StepStatus) {
  switch (status) {
    case "running":
      return "#1976d2";
    case "success":
      return "#2e7d32";
    case "failed":
      return "#c62828";
    case "skipped":
    case "pending":
      return "#ed6c02";
    case "cancelled":
      return "#6d4c41";
    case "waiting":
    default:
      return "#6b7280";
  }
}

export function readableBytes(size?: number) {
  if (!size) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
