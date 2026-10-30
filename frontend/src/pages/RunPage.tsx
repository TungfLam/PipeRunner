import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link as RouterLink, useParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import RefreshIcon from "@mui/icons-material/Refresh";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import StopCircleOutlinedIcon from "@mui/icons-material/StopCircleOutlined";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { api } from "../api/client";
import { ConfirmDialog } from "../components/ConfirmDialog";
import RunJobs from "../components/RunJobs";
import RunLogs from "../components/RunLogs";
import { useRunLive } from "../hooks/useRunLive";
import { useAuthStore } from "../stores/authStore";
import type { Workflow, WorkflowRun } from "../types/domain";
import { statusColor } from "../utils/status";

const RunGraph = lazy(() => import("../components/RunGraph"));
const RunFiles = lazy(() => import("../components/RunFiles"));
const active = (status: string) => ["await", "running"].includes(status);
const rerunnable = (status: string) => ["failed", "cancelled"].includes(status);
interface ActionResult { run: WorkflowRun; acceptedItemIds: string[]; skipped: Array<{ itemId: string; reason: string }> }

function duration(start?: string, finish?: string) {
  if (!start) return "—";
  if (!finish) return "In progress";
  const seconds = Math.max(0, Math.round((Date.parse(finish) - Date.parse(start)) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

export function RunPage() {
  const { runId = "" } = useParams();
  const token = useAuthStore((state) => state.token);
  const client = useQueryClient();
  const { query, socket, connected } = useRunLive(runId, token);
  const run = query.data;
  const [selectedId, setSelectedId] = useState<string>();
  const [nodeId, setNodeId] = useState<string>();
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [tab, setTab] = useState(0);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [notice, setNotice] = useState<{ warning: boolean; text: string }>();
  const checked = useMemo(() => new Set(checkedIds), [checkedIds]);
  const workflowQuery = useQuery({
    queryKey: ["workflow", run?.workflowId], enabled: !!run && !run.workflowSnapshot,
    queryFn: async () => (await api.get<{ workflow: Workflow }>(`/workflows/${run?.workflowId}`)).data.workflow
  });
  const workflow = run?.workflowSnapshot || workflowQuery.data;
  const items = run?.items || [];
  const selected = items.find((item) => item.itemId === selectedId) || items[0];
  const steps = selected?.steps || run?.steps || [];
  const step = steps.find((step) => step.nodeId === nodeId) || steps.find((step) => step.status === "running") ||
    steps.find((step) => step.status === "failed") || steps.find((step) => step.status === "cancelled") || steps[0];
  const firstBlocked = steps.find((step) => rerunnable(step.status));
  const counts = useMemo(() => {
    const result: Record<string, number> = { await: 0, running: 0, success: 0, failed: 0, cancelled: 0 };
    for (const item of items) result[item.status] = (result[item.status] || 0) + 1;
    return result;
  }, [items]);
  useEffect(() => { setSelectedId(undefined); setNodeId(undefined); setCheckedIds([]); setTab(0); setNotice(undefined); }, [runId]);
  useEffect(() => {
    if (!selectedId && items.length) setSelectedId((items.find((item) => item.status === "running") || items.find((item) => item.status === "failed") || items[0]).itemId);
  }, [items, selectedId]);
  const select = useCallback((id: string) => { setSelectedId(id); setNodeId(undefined); }, []);
  const action = useMutation({
    mutationFn: async (input: { type: "cancel" | "rerun"; itemIds?: string[]; nodeId?: string }) =>
      (await api.post<ActionResult>(`/runs/${runId}/${input.type}`, { itemIds: input.itemIds, nodeId: input.nodeId })).data,
    onSuccess: (result, input) => {
      client.setQueryData<WorkflowRun>(["run", runId], (old) => old && (old.revision || 0) > (result.run.revision || 0) ? old : result.run);
      setConfirmCancel(false);
      setNotice({ warning: result.skipped.length > 0 || result.acceptedItemIds.length === 0,
        text: `${input.type === "cancel" ? "Cancelled" : "Queued for rerun"}: ${result.acceptedItemIds.length} job(s).${result.skipped.length ? ` Skipped: ${result.skipped.map((item) => `${item.itemId}: ${item.reason}`).join("; ")}` : ""}` });
      void client.invalidateQueries({ queryKey: ["workflow-runs", run?.workflowId] });
    },
    onError: (error: unknown) => {
      const response = error as { response?: { data?: { message?: string } }; message?: string };
      setNotice({ warning: true, text: response.response?.data?.message || response.message || "Action failed" });
    }
  });
  const cancel = useCallback((ids: string[]) => action.mutate({ type: "cancel", itemIds: ids }), [action.mutate]);
  const rerun = useCallback((ids: string[]) => action.mutate({ type: "rerun", itemIds: ids }), [action.mutate]);
  const selectedActive = items.filter((item) => checked.has(item.itemId) && active(item.status));
  const selectedRetry = items.filter((item) => checked.has(item.itemId) && rerunnable(item.status));
  const completed = (counts.success || 0) + (counts.failed || 0) + (counts.cancelled || 0);
  if (query.isError && !run) return <Alert severity="error">Unable to load this run. <Button onClick={() => void query.refetch()}>Try again</Button></Alert>;
  if (!run) return <Stack alignItems="center" sx={{ p: 8 }}><CircularProgress /><Typography sx={{ mt: 2 }}>Loading run…</Typography></Stack>;

  return <Stack spacing={2.5}>
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <Button component={RouterLink} to={`/workflows/${run.workflowId}/runs`} startIcon={<ArrowBackIcon />} size="small">Run history</Button>
      <Stack direction="row" spacing={1} alignItems="center"><Box sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: connected ? "success.main" : "warning.main" }} />
        <Typography variant="caption" color="text.secondary">{connected ? "Live updates" : "Reconnecting · refresh every 5s"}</Typography>
        <Button size="small" startIcon={<RefreshIcon />} onClick={() => void query.refetch()}>Refresh</Button></Stack>
    </Stack>
    <Paper variant="outlined" sx={{ p: { xs: 2, md: 2.5 }, borderRadius: 2 }}>
      <Stack direction={{ xs: "column", md: "row" }} spacing={2} alignItems={{ md: "center" }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: 1.4 }}>WORKFLOW RUN</Typography>
          <Stack direction="row" alignItems="center" spacing={1.5}><Typography variant="h5" fontWeight={700} noWrap>{workflow?.name || "Workflow"}</Typography>
            <Chip size="small" label={run.status} sx={{ bgcolor: `${statusColor(run.status)}18`, color: statusColor(run.status), fontWeight: 700 }} /></Stack>
          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>{runId} · {new Date(run.createdAt).toLocaleString()} · {duration(run.startedAt, run.finishedAt)}</Typography>
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button variant="outlined" startIcon={<RestartAltIcon />} disabled={action.isPending || !(counts.failed + counts.cancelled || (!items.length && rerunnable(run.status)))} onClick={() => action.mutate({ type: "rerun" })}>Rerun failed / cancelled</Button>
          <Button variant="outlined" color="error" startIcon={<StopCircleOutlinedIcon />} disabled={action.isPending || (!(counts.await + counts.running) && !active(run.status))} onClick={() => setConfirmCancel(true)}>Cancel all</Button>
        </Stack>
      </Stack>
      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mt: 2.5, mb: 1.5 }}>
        {Object.entries(counts).map(([status, count]) => <Stack key={status} direction="row" spacing={0.75} alignItems="center">
          <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: statusColor(status as WorkflowRun["status"]) }} />
          <Typography variant="body2" color="text.secondary">{status} <Box component="span" sx={{ color: "text.primary", fontWeight: 700 }}>{count}</Box></Typography>
        </Stack>)}
        <Typography variant="body2" color="text.secondary" sx={{ ml: "auto !important" }}>{completed}/{items.length} finished</Typography>
      </Stack>
      <LinearProgress variant="determinate" value={items.length ? completed / items.length * 100 : 0} sx={{ height: 5, borderRadius: 3 }} />
    </Paper>
    {notice && <Alert severity={notice.warning ? "warning" : "success"} onClose={() => setNotice(undefined)} sx={{ overflowWrap: "anywhere" }}>{notice.text}</Alert>}
    {query.isError && <Alert severity="warning">Connection interrupted. The last received state is shown.</Alert>}
    {run.errorMessage && <Alert severity={run.status === "failed" ? "error" : "warning"}>{run.errorMessage}</Alert>}
    {!!checkedIds.length && <Paper variant="outlined" sx={{ px: 2, py: 1, borderRadius: 2 }}><Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
      <Typography variant="body2" fontWeight={600} sx={{ flex: 1 }}>{checkedIds.length} selected</Typography>
      <Button size="small" onClick={() => setCheckedIds([])}>Clear selection</Button>
      <Button size="small" disabled={!selectedRetry.length || action.isPending} onClick={() => rerun(selectedRetry.map((item) => item.itemId))}>Rerun selected ({selectedRetry.length})</Button>
      <Button size="small" color="error" disabled={!selectedActive.length || action.isPending} onClick={() => cancel(selectedActive.map((item) => item.itemId))}>Cancel selected ({selectedActive.length})</Button>
    </Stack></Paper>}
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "360px minmax(0, 1fr)" }, gap: 2 }}>
      {!!items.length && <Paper variant="outlined" sx={{ overflow: "hidden", borderRadius: 2, alignSelf: "start" }}>
        <RunJobs items={items} selectedId={selected?.itemId} checked={checked} pending={action.isPending} onSelect={select} onChecked={setCheckedIds} onCancel={cancel} onRerun={rerun} />
      </Paper>}
      <Paper variant="outlined" sx={{ minWidth: 0, borderRadius: 2, overflow: "hidden", gridColumn: items.length ? undefined : "1 / -1" }}>
        <Box sx={{ p: 2, borderBottom: "1px solid", borderColor: "divider" }}>
          <Stack direction="row" spacing={1} alignItems="center"><Typography variant="subtitle1" fontWeight={700} noWrap title={selected?.label} sx={{ flex: 1 }}>{selected ? `${selected.index + 1}. ${selected.label}` : "Run details"}</Typography>
            {selected && <Chip size="small" label={selected.cancelRequestedAt ? "Cancelling…" : selected.status} variant="outlined" />}</Stack>
          {selected && <Typography variant="caption" color="text.secondary">{selected.steps.filter((step) => step.status === "success").length}/{selected.steps.length} steps · {duration(selected.startedAt, selected.finishedAt)}</Typography>}
          {selected?.waitReason && <Typography variant="body2" color="text.secondary">{selected.waitReason}</Typography>}
        </Box>
        <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="scrollable" sx={{ px: 1, borderBottom: "1px solid", borderColor: "divider" }}>
          <Tab label="Steps & Logs" /><Tab label={`Files (${selected?.outputFiles?.length ?? run.outputFiles.length})`} /><Tab label="Workflow" />
        </Tabs>
        <Box sx={{ p: { xs: 1.5, md: 2 } }}><Suspense fallback={<Box sx={{ p: 4, textAlign: "center" }}><CircularProgress size={24} /></Box>}>
          {tab === 0 && <Stack spacing={2}>
            <Stack spacing={0.5}>{steps.map((current, index) => <Box key={current.nodeId} sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.25, py: 1,
              borderRadius: 1, bgcolor: step?.nodeId === current.nodeId ? "action.selected" : "transparent", border: "1px solid", borderColor: step?.nodeId === current.nodeId ? "divider" : "transparent" }}>
              <Button color="inherit" onClick={() => setNodeId(current.nodeId)} sx={{ justifyContent: "flex-start", flex: 1, minWidth: 0 }}><Typography variant="body2" noWrap>{index + 1}. {current.label}</Typography></Button>
              <Typography variant="caption" color="text.secondary" sx={{ display: { xs: "none", sm: "block" } }}>{duration(current.startedAt, current.finishedAt)}</Typography>
              <Chip size="small" label={current.status} sx={{ color: statusColor(current.status), bgcolor: `${statusColor(current.status)}18` }} />
              {selected && firstBlocked?.nodeId === current.nodeId && rerunnable(selected.status) && <Button size="small" disabled={action.isPending} onClick={() => action.mutate({ type: "rerun", itemIds: [selected.itemId], nodeId: current.nodeId })}>Rerun</Button>}
            </Box>)}</Stack>
            {step?.errorMessage && <Alert severity={step.status === "failed" ? "error" : "warning"}>{step.errorMessage}</Alert>}
            {step?.command && <Box sx={{ p: 1.5, bgcolor: "action.hover", borderRadius: 1, minWidth: 0 }}><Typography variant="caption" color="text.secondary">COMMAND</Typography>
              <Typography component="pre" sx={{ m: 0, mt: 0.5, fontSize: 12, overflow: "auto", whiteSpace: "pre" }}>{[step.command, ...(step.args || [])].join(" ")}</Typography></Box>}
            {step && <RunLogs runId={runId} itemId={selected?.itemId} step={step} socket={socket} connected={connected} />}
          </Stack>}
          {tab === 1 && <RunFiles key={selected?.itemId || runId} inputs={selected?.inputFiles || run.inputFiles} values={selected?.inputValues || []} outputs={selected?.outputFiles || run.outputFiles} />}
          {tab === 2 && (workflow ? <RunGraph workflow={workflow} steps={steps} onSelect={(id) => { setNodeId(id); setTab(0); }} /> : <Alert severity="info">Workflow configuration is unavailable for this legacy run.</Alert>)}
        </Suspense></Box>
      </Paper>
    </Box>
    <ConfirmDialog open={confirmCancel} title="Cancel all active jobs?" description={`Cancel ${counts.await + counts.running || (active(run.status) ? 1 : 0)} running or waiting job(s) in this run? Completed results are kept.`}
      confirmLabel="Cancel all" loading={action.isPending} onCancel={() => setConfirmCancel(false)} onConfirm={() => action.mutate({ type: "cancel" })} />
  </Stack>;
}
