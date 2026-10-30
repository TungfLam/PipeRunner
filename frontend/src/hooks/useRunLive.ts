import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { io, type Socket } from "socket.io-client";
import { API_URL, api } from "../api/client";
import type { WorkflowRun, WorkflowRunItem } from "../types/domain";

interface RunPatch {
  revision: number; run: { status: WorkflowRun["status"]; startedAt?: string | null; finishedAt?: string | null; errorMessage?: string | null };
  items: WorkflowRunItem[]; steps: WorkflowRun["steps"];
}

export function useRunLive(runId: string, token: string | null) {
  const client = useQueryClient();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const query = useQuery({
    queryKey: ["run", runId],
    queryFn: async () => {
      const run = (await api.get<{ run: WorkflowRun }>(`/runs/${runId}`)).data.run;
      const current = client.getQueryData<WorkflowRun>(["run", runId]);
      return current && (current.revision || 0) > (run.revision || 0) ? current : run;
    },
    refetchInterval: (query) => !connected && ["await", "running"].includes(query.state.data?.status || "") ? 5000 : false,
    refetchOnWindowFocus: false
  });
  useEffect(() => {
    if (!token || !runId) return;
    const connection = io(API_URL, { auth: { token } });
    setSocket(connection);
    let pending: RunPatch | undefined;
    const items = new Map<string, { item: WorkflowRunItem; revision: number }>();
    let needsSnapshot = false;
    let resyncing = false;
    const refresh = async () => {
      resyncing = true;
      try {
        await client.cancelQueries({ queryKey: ["run", runId] });
        await client.invalidateQueries({ queryKey: ["run", runId] });
      } finally { resyncing = false; }
    };
    connection.on("connect", () => {
      setConnected(true);
      connection.emit("run:join", runId, (reply: { joined?: boolean }) => { if (reply?.joined) void refresh(); });
    });
    connection.on("disconnect", () => setConnected(false));
    connection.on("connect_error", () => setConnected(false));
    connection.on("run:patch", (patch: RunPatch) => {
      if (document.hidden) { needsSnapshot = true; return; }
      const current = client.getQueryData<WorkflowRun>(["run", runId]);
      if (current && patch.revision <= (current.revision || 0)) return;
      if (!pending || patch.revision > pending.revision) pending = patch;
      for (const item of patch.items) {
        if ((items.get(item.itemId)?.revision || 0) < patch.revision) items.set(item.itemId, { item, revision: patch.revision });
      }
    });
    const timer = window.setInterval(() => {
      if (!pending || document.hidden || resyncing || !client.getQueryData(["run", runId])) return;
      const patch = pending;
      const updates = new Map(items);
      pending = undefined; items.clear();
      client.setQueryData<WorkflowRun>(["run", runId], (current) => {
        if (!current || patch.revision <= (current.revision || 0)) return current;
        const changed = new Map([...updates].filter(([, value]) => value.revision > (current.revision || 0)));
        const ids = new Set(current.items?.map((item) => item.itemId));
        return { ...current, status: patch.run.status, revision: patch.revision, steps: patch.steps,
          startedAt: "startedAt" in patch.run ? patch.run.startedAt || undefined : current.startedAt,
          finishedAt: "finishedAt" in patch.run ? patch.run.finishedAt || undefined : current.finishedAt,
          errorMessage: "errorMessage" in patch.run ? patch.run.errorMessage || undefined : current.errorMessage,
          items: [...(current.items || []).map((item) => changed.get(item.itemId)?.item || item),
            ...[...changed.values()].filter(({ item }) => !ids.has(item.itemId)).map(({ item }) => item)] };
      });
    }, 250);
    const visible = () => {
      if (!document.hidden && needsSnapshot) { pending = undefined; items.clear(); needsSnapshot = false; void refresh(); }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(timer); document.removeEventListener("visibilitychange", visible);
      connection.emit("run:leave", runId); connection.disconnect(); setConnected(false); setSocket(null);
    };
  }, [client, runId, token]);
  return { query, socket, connected };
}
