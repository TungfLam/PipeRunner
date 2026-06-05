import CancelIcon from "@mui/icons-material/Cancel";
import RefreshIcon from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";
import { useTheme } from "@mui/material/styles";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import { API_URL, api } from "../api/client";
import { FilePreview } from "../components/FilePreview";
import { NodeConfigPanel } from "../components/NodeConfigPanel";
import { ToolNode, type ToolNodeData } from "../components/ToolNode";
import { useAuthStore } from "../stores/authStore";
import type { RunStep, Workflow, WorkflowRun } from "../types/domain";
import { statusColor } from "../utils/status";
import { repairWorkflowGraphHandles } from "../utils/workflowHandles";

interface LogResponse {
  logs: Array<{ itemId?: string; itemLabel?: string; nodeId: string; label: string; logPath?: string; log: string }>;
}

export function RunPage() {
  const theme = useTheme();
  const { runId = "" } = useParams();
  const token = useAuthStore((state) => state.token);
  const queryClient = useQueryClient();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<Record<string, string>>({});
  const nodeTypes = useMemo(() => ({ tool: ToolNode }), []);

  const runQuery = useQuery({
    queryKey: ["run", runId],
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "running" || status === "pending" ? 2500 : false;
    },
    queryFn: async () => (await api.get<{ run: WorkflowRun }>(`/runs/${runId}`)).data.run
  });

  const workflowQuery = useQuery({
    queryKey: ["workflow", runQuery.data?.workflowId],
    enabled: Boolean(runQuery.data?.workflowId),
    queryFn: async () =>
      (await api.get<{ workflow: Workflow }>(`/workflows/${runQuery.data?.workflowId}`)).data.workflow
  });

  const logsQuery = useQuery({
    queryKey: ["run-logs", runId],
    enabled: Boolean(runQuery.data),
    queryFn: async () => (await api.get<LogResponse>(`/runs/${runId}/logs`)).data
  });

  const cancelRun = useMutation({
    mutationFn: async () => api.post(`/runs/${runId}/cancel`),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["run", runId] })
  });

  useEffect(() => {
    if (!token || !runId) return;
    const socket = io(API_URL, { auth: { token } });
    socket.emit("run:join", runId);
    socket.on("step:log", (payload: { itemId?: string; nodeId: string; message: string }) => {
      const key = `${payload.itemId || ""}:${payload.nodeId}`;
      setLiveLogs((current) => ({
        ...current,
        [key]: `${current[key] || ""}${payload.message}`
      }));
    });
    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: ["run", runId] });
      void queryClient.invalidateQueries({ queryKey: ["run-logs", runId] });
    };
    socket.on("step:status", invalidate);
    socket.on("step:output", invalidate);
    socket.on("run:status", invalidate);
    socket.on("run:finished", invalidate);
    socket.on("run:error", invalidate);
    return () => {
      socket.emit("run:leave", runId);
      socket.disconnect();
    };
  }, [queryClient, runId, token]);

  const selectedItem =
    (selectedItemId && runQuery.data?.items?.find((item) => item.itemId === selectedItemId)) ||
    runQuery.data?.items?.find((item) => item.status === "running") ||
    runQuery.data?.items?.find((item) => item.status === "failed") ||
    runQuery.data?.items?.[0] ||
    null;
  const activeSteps = selectedItem?.steps?.length ? selectedItem.steps : runQuery.data?.steps || [];

  const stepsByNode = useMemo(() => {
    const map = new Map<string, RunStep>();
    for (const step of activeSteps) {
      map.set(step.nodeId, step);
    }
    return map;
  }, [activeSteps]);

  const graph = useMemo(() => {
    const workflow = workflowQuery.data;
    if (!workflow) {
      return { nodes: [] as Node<ToolNodeData>[], edges: [] as Edge[] };
    }
    const repairedWorkflow = repairWorkflowGraphHandles(workflow);
    return {
      nodes: repairedWorkflow.nodes.map(
        (node): Node<ToolNodeData> => ({
          id: node.id,
          type: "tool",
          position: node.position,
          data: {
            workflowNode: node,
            status: stepsByNode.get(node.id)?.status || "waiting"
          }
        })
      ),
      edges: repairedWorkflow.edges.map(
        (edge): Edge => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          type: "smoothstep",
          animated: stepsByNode.get(edge.source)?.status === "running"
        })
      )
    };
  }, [stepsByNode, workflowQuery.data]);

  const baseLogs = useMemo(() => {
    const map: Record<string, string> = {};
    for (const item of logsQuery.data?.logs || []) {
      map[`${item.itemId || ""}:${item.nodeId}`] = item.log;
    }
    return map;
  }, [logsQuery.data]);

  const selectedStep =
    (selectedNodeId && stepsByNode.get(selectedNodeId)) ||
    activeSteps.find((step) => step.status === "running") ||
    activeSteps.find((step) => step.status === "failed") ||
    activeSteps[0];
  const selectedNode =
    selectedStep && graph.nodes.find((node) => node.id === selectedStep.nodeId)
      ? graph.nodes.find((node) => node.id === selectedStep.nodeId)?.data.workflowNode || null
      : null;
  const selectedLogKey = selectedStep ? `${selectedItem?.itemId || ""}:${selectedStep.nodeId}` : "";
  const selectedLogs = selectedStep
    ? (baseLogs[selectedLogKey] || "").includes(liveLogs[selectedLogKey] || "")
      ? baseLogs[selectedLogKey] || liveLogs[selectedLogKey] || ""
      : `${baseLogs[selectedLogKey] || ""}${liveLogs[selectedLogKey] || ""}`
    : "";
  const visibleInputFiles = selectedItem?.inputFiles || runQuery.data?.inputFiles || [];
  const visibleInputValues = selectedItem?.inputValues || [];
  const visibleOutputFiles = selectedItem?.outputFiles || runQuery.data?.outputFiles || [];

  if (!runQuery.data) {
    return <Typography>Loading run...</Typography>;
  }

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }} elevation={1}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} alignItems={{ md: "center" }}>
          <Box sx={{ flexGrow: 1 }}>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              Workflow Run
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {runQuery.data.workingDir}
            </Typography>
          </Box>
          <Chip label={runQuery.data.status} sx={{ bgcolor: statusColor(runQuery.data.status), color: "#fff" }} />
          <Button startIcon={<RefreshIcon />} variant="outlined" onClick={() => runQuery.refetch()}>
            Refresh
          </Button>
          {["running", "pending"].includes(runQuery.data.status) && (
            <Button
              startIcon={<CancelIcon />}
              color="error"
              variant="outlined"
              onClick={() => cancelRun.mutate()}
              disabled={cancelRun.isPending}
            >
              Cancel
            </Button>
          )}
          <Button component={RouterLink} to={`/workflows/${runQuery.data.workflowId}/runs`} variant="text">
            History
          </Button>
        </Stack>
      </Paper>

      {runQuery.data.errorMessage && (
        <Alert severity={runQuery.data.status === "failed" ? "error" : "warning"}>{runQuery.data.errorMessage}</Alert>
      )}

      {Boolean(runQuery.data.items?.length) && (
        <Paper sx={{ overflow: "hidden" }} elevation={1}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Batch Item</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Inputs</TableCell>
                <TableCell>Outputs</TableCell>
                <TableCell>Error</TableCell>
                <TableCell align="right">View</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(runQuery.data.items || []).map((item) => (
                <TableRow key={item.itemId} selected={selectedItem?.itemId === item.itemId} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap title={item.label}>
                      {item.index + 1}. {item.label}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip size="small" label={item.status} sx={{ bgcolor: statusColor(item.status), color: "#fff" }} />
                  </TableCell>
                  <TableCell>{(item.inputFiles?.length || 0) + (item.inputValues?.length || 0)}</TableCell>
                  <TableCell>{item.outputFiles?.length || 0}</TableCell>
                  <TableCell sx={{ maxWidth: 360 }}>
                    {item.errorMessage && (
                      <Typography variant="caption" color="error" noWrap title={item.errorMessage}>
                        {item.errorMessage}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      onClick={() => {
                        setSelectedItemId(item.itemId);
                        setSelectedNodeId(null);
                      }}
                    >
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}

      <Paper sx={{ overflow: "hidden" }} elevation={1}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Step</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Command</TableCell>
              <TableCell>Error</TableCell>
              <TableCell align="right">Logs</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {activeSteps.map((step) => (
              <TableRow key={step.nodeId} selected={selectedStep?.nodeId === step.nodeId} hover>
                <TableCell>{step.label}</TableCell>
                <TableCell>
                  <Chip size="small" label={step.status} sx={{ bgcolor: statusColor(step.status), color: "#fff" }} />
                </TableCell>
                <TableCell sx={{ maxWidth: 460 }}>
                  <Typography variant="caption" sx={{ fontFamily: "monospace" }} noWrap title={[step.command, ...(step.args || [])].filter(Boolean).join(" ")}>
                    {[step.command, ...(step.args || [])].filter(Boolean).join(" ")}
                  </Typography>
                </TableCell>
                <TableCell sx={{ maxWidth: 360 }}>
                  {step.errorMessage && (
                    <Typography variant="caption" color="error" noWrap title={step.errorMessage}>
                      {step.errorMessage}
                    </Typography>
                  )}
                </TableCell>
                <TableCell align="right">
                  <Button size="small" onClick={() => setSelectedNodeId(step.nodeId)}>
                    View
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>

      <Paper
        sx={{
          height: "calc(100vh - 245px)",
          minHeight: 560,
          overflow: "hidden",
          "& .react-flow": {
            bgcolor: "background.default"
          },
          "& .react-flow__controls": {
            boxShadow: 2
          },
          "& .react-flow__controls-button": {
            bgcolor: "background.paper",
            color: "text.primary",
            borderBottom: "1px solid",
            borderColor: "divider",
            "&:hover": {
              bgcolor: "action.hover"
            },
            "& svg": {
              fill: "currentColor"
            }
          },
          "& .react-flow__minimap": {
            bgcolor: "background.paper",
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 1,
            overflow: "hidden"
          },
          "& .react-flow__attribution": {
            bgcolor: "background.paper",
            color: "text.secondary"
          }
        }}
        elevation={1}
      >
        <Box sx={{ display: "flex", height: "100%" }}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <ReactFlow<Node<ToolNodeData>, Edge>
              nodes={graph.nodes}
              edges={graph.edges}
              nodeTypes={nodeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
              fitView
            >
              <Background color={theme.palette.divider} />
              <Controls />
              <MiniMap
                pannable
                zoomable
                bgColor={theme.palette.background.paper}
                maskColor={theme.palette.mode === "dark" ? "rgba(0,0,0,0.45)" : "rgba(245,247,251,0.72)"}
                nodeColor={theme.palette.mode === "dark" ? "#354052" : "#d9e2ef"}
              />
            </ReactFlow>
          </Box>
          <Divider orientation="vertical" flexItem />
          <NodeConfigPanel
            node={selectedNode}
            step={selectedStep}
            logs={selectedLogs}
            readOnly
            onClose={() => setSelectedNodeId(null)}
          />
        </Box>
      </Paper>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2 }}>
        <Paper sx={{ p: 2 }} elevation={1}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Inputs
          </Typography>
          <Stack spacing={1.5}>
            {visibleInputValues.map((value) => (
              <Box
                key={`${value.name}-${value.value}`}
                sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 1.25 }}
              >
                <Typography variant="caption" color="text.secondary">
                  {value.name}
                </Typography>
                <Typography variant="body2" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                  {value.value}
                </Typography>
              </Box>
            ))}
            {visibleInputFiles.map((file) => (
              <FilePreview key={file.relativePath} file={file} />
            ))}
            {!visibleInputFiles.length && !visibleInputValues.length && (
              <Typography variant="body2" color="text.secondary">
                No input files recorded.
              </Typography>
            )}
          </Stack>
        </Paper>

        <Paper sx={{ p: 2 }} elevation={1}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Outputs
          </Typography>
          <Stack spacing={1.5}>
            {visibleOutputFiles.map((file) => (
              <FilePreview key={file.relativePath} file={file} />
            ))}
            {!visibleOutputFiles.length && (
              <Typography variant="body2" color="text.secondary">
                No outputs yet.
              </Typography>
            )}
          </Stack>
        </Paper>
      </Box>
    </Stack>
  );
}
