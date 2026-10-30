import type { RunItem, RunStatus, RunStep, StepStatus } from "../types/domain";

export const isActiveStatus = (status: string) => ["await", "pending", "waiting", "running"].includes(status);

export function aggregateStatus(statuses: string[], step = false): RunStatus | StepStatus {
  if (statuses.includes("running")) return "running";
  if (statuses.some(isActiveStatus)) return "await";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("cancelled")) return "cancelled";
  if (step && statuses.length && statuses.every((s) => s === "skipped")) return "skipped";
  return "success";
}

export function aggregateSteps(items: RunItem[]): RunStep[] {
  return (items[0]?.steps || []).map((original) => {
    const steps = items.flatMap((item) => item.steps.filter((step) => step.nodeId === original.nodeId));
    const status = aggregateStatus(steps.map((step) => step.status), true) as StepStatus;
    const sample = steps.find((step) => step.status === status) || original;
    const starts = steps.flatMap((step) => step.startedAt ? [new Date(step.startedAt).getTime()] : []);
    const finishes = steps.flatMap((step) => step.finishedAt ? [new Date(step.finishedAt).getTime()] : []);
    return { ...sample, status,
      startedAt: starts.length ? new Date(Math.min(...starts)) : undefined,
      finishedAt: !isActiveStatus(status) && finishes.length ? new Date(Math.max(...finishes)) : undefined };
  });
}

/** Also handles legacy documents which have steps but no batch items. */
export function recoverRun(run: { status: string; items?: RunItem[]; steps?: RunStep[]; [key: string]: unknown }) {
  const now = new Date();
  let interrupted = isActiveStatus(run.status);
  const normalize = (steps: RunStep[], cancel: boolean) => steps.map((step) => {
    if (cancel && isActiveStatus(step.status)) {
      return { ...step, status: "cancelled" as const, finishedAt: now, errorMessage: "Backend interrupted; rerun to continue" };
    }
    return { ...step, status: (["pending", "waiting"].includes(step.status) ? "await" : step.status) as StepStatus };
  });
  run.items = (run.items || []).map((item) => {
    const active = isActiveStatus(item.status);
    interrupted ||= active;
    return { ...item, process: undefined, steps: normalize(item.steps, active),
      ...(active ? { status: "cancelled" as const, finishedAt: now, waitReason: undefined,
        cancelRequestedAt: undefined, errorMessage: "Backend interrupted; rerun to continue" } : {}) };
  });
  run.steps = normalize(run.steps || [], interrupted);
  if (interrupted) {
    run.status = run.items.length ? aggregateStatus(run.items.map((item) => item.status)) : "cancelled";
    run.finishedAt = now;
    run.errorMessage = "Backend interrupted; rerun cancelled jobs to continue";
  }
  return run;
}
