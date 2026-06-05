import AddIcon from "@mui/icons-material/Add";
import HistoryIcon from "@mui/icons-material/History";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import SaveIcon from "@mui/icons-material/Save";
import Alert from "@mui/material/Alert";
import { useTheme } from "@mui/material/styles";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useParams } from "react-router-dom";
import { api } from "../api/client";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { NodeConfigPanel } from "../components/NodeConfigPanel";
import { RunDialog } from "../components/RunDialog";
import { ToolNode, type ToolNodeData } from "../components/ToolNode";
import type { Workflow, WorkflowEdgeConfig, WorkflowNodeConfig } from "../types/domain";
import { repairWorkflowGraphHandles } from "../utils/workflowHandles";

function makeId(prefix: string) {
  if ("randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Date.now()}`;
}

function newToolNode(index: number): WorkflowNodeConfig {
  const id = makeId("tool");
  return {
    id,
    type: "tool",
    label: `Tool ${index}`,
    position: { x: 120 + index * 40, y: 120 + index * 30 },
    toolConfig: {
      bin: "",
      args: ["--input", "{{inputs.input}}", "--output", "{{outputs.result}}"]
    },
    inputs: [{ name: "input", type: "file", flag: "--input", required: false }],
    outputs: [{ name: "result", type: "file", flag: "--output", extension: "txt", preview: "text" }],
    defaultParams: {}
  };
}

function newFileInputNode(index: number): WorkflowNodeConfig {
  const id = makeId("file-input");
  return {
    id,
    type: "fileInput",
    label: "Input File",
    position: { x: 40 + index * 25, y: 80 + index * 25 },
    toolConfig: {
      bin: "__file_input__",
      args: []
    },
    inputs: [],
    outputs: [{ name: "mp4", type: "file", flag: "", extension: "mp4", preview: "video" }],
    defaultParams: {}
  };
}

function toFlowNodes(workflow: Workflow): Node<ToolNodeData>[] {
  return workflow.nodes.map((node) => ({
    id: node.id,
    type: "tool",
    position: node.position,
    data: { workflowNode: node }
  }));
}

function toFlowEdges(workflow: Workflow): Edge[] {
  return workflow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    type: "smoothstep"
  }));
}

function remapEdgesForNodeUpdate(previous: WorkflowNodeConfig, updated: WorkflowNodeConfig, currentEdges: Edge[]) {
  const inputRenames = new Map<string, string>();
  const outputRenames = new Map<string, string>();
  const validInputs = new Set(updated.inputs.map((input) => input.name));
  const validOutputs = new Set(updated.outputs.map((output) => output.name));

  previous.inputs.forEach((input, index) => {
    const nextInput = updated.inputs[index];
    if (nextInput && input.name !== nextInput.name) {
      inputRenames.set(input.name, nextInput.name);
    }
  });

  previous.outputs.forEach((output, index) => {
    const nextOutput = updated.outputs[index];
    if (nextOutput && output.name !== nextOutput.name) {
      outputRenames.set(output.name, nextOutput.name);
    }
  });

  return currentEdges.flatMap((edge) => {
    let sourceHandle = edge.sourceHandle || undefined;
    let targetHandle = edge.targetHandle || undefined;

    if (edge.source === updated.id && sourceHandle) {
      sourceHandle = outputRenames.get(sourceHandle) || sourceHandle;
      if (!validOutputs.has(sourceHandle)) {
        return [];
      }
    }

    if (edge.target === updated.id && targetHandle) {
      targetHandle = inputRenames.get(targetHandle) || targetHandle;
      if (!validInputs.has(targetHandle)) {
        return [];
      }
    }

    return [
      {
        ...edge,
        sourceHandle,
        targetHandle,
        id: `edge-${edge.source}-${sourceHandle || ""}-${edge.target}-${targetHandle || ""}`
      }
    ];
  });
}

export function WorkflowEditorPage() {
  const theme = useTheme();
  const { projectId = "", workflowId = "" } = useParams();
  const queryClient = useQueryClient();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [deleteEdgeDialogOpen, setDeleteEdgeDialogOpen] = useState(false);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [saveToast, setSaveToast] = useState<{ open: boolean; severity: "success" | "error" | "info"; message: string }>({
    open: false,
    severity: "info",
    message: ""
  });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ToolNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const nodeTypes = useMemo(() => ({ tool: ToolNode }), []);

  const workflowQuery = useQuery({
    queryKey: ["workflow", workflowId],
    queryFn: async () => (await api.get<{ workflow: Workflow }>(`/workflows/${workflowId}`)).data.workflow
  });

  useEffect(() => {
    if (!workflowQuery.data) return;
    const repairedWorkflow = repairWorkflowGraphHandles(workflowQuery.data);
    setName(repairedWorkflow.name);
    setDescription(repairedWorkflow.description || "");
    setNodes(toFlowNodes(repairedWorkflow));
    setEdges(toFlowEdges(repairedWorkflow));
  }, [workflowQuery.data?._id, setEdges, setNodes]);

  const saveWorkflow = useMutation({
    mutationFn: async () => {
      const repairedGraph = repairWorkflowGraphHandles({
        nodes: nodes.map((node) => ({
          ...node.data.workflowNode,
          id: node.id,
          type: node.data.workflowNode.type || "tool",
          position: node.position
        })),
        edges: edges.map(
          (edge): WorkflowEdgeConfig => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            sourceHandle: edge.sourceHandle || undefined,
            targetHandle: edge.targetHandle || undefined
          })
        )
      });
      const payload = {
        name,
        description,
        nodes: repairedGraph.nodes,
        edges: repairedGraph.edges
      };
      return api.patch(`/workflows/${workflowId}`, payload);
    },
    onMutate: () => {
      setSaveToast({ open: true, severity: "info", message: "Saving workflow..." });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["workflow", workflowId] });
      setSaveToast({ open: true, severity: "success", message: "Workflow saved successfully." });
    },
    onError: () => {
      setSaveToast({ open: true, severity: "error", message: "Failed to save workflow." });
    }
  });

  const selectedNode = nodes.find((node) => node.id === selectedNodeId)?.data.workflowNode || null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) || null;
  const displayEdges = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        selected: edge.id === selectedEdgeId,
        style:
          edge.id === selectedEdgeId
            ? { ...edge.style, stroke: theme.palette.error.main, strokeWidth: 3 }
            : edge.style
      })),
    [edges, selectedEdgeId, theme.palette.error.main]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setSelectedEdgeId(null);
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            id: `edge-${connection.source}-${connection.sourceHandle}-${connection.target}-${connection.targetHandle}`,
            type: "smoothstep"
          },
          current
        )
      );
    },
    [setEdges]
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChange(changes);
      if (selectedEdgeId && changes.some((change) => change.type === "remove" && "id" in change && change.id === selectedEdgeId)) {
        setSelectedEdgeId(null);
        setDeleteEdgeDialogOpen(false);
      }
      const selectedChange = changes.find(
        (change): change is EdgeChange & { id: string; selected: boolean } =>
          change.type === "select" && "id" in change && "selected" in change && change.selected
      );
      if (selectedChange) {
        setSelectedNodeId(null);
        setSelectedEdgeId(selectedChange.id);
      }
    },
    [onEdgesChange, selectedEdgeId]
  );

  const addTool = () => {
    const workflowNode = newToolNode(nodes.length + 1);
    setNodes((current) => [
      ...current,
      {
        id: workflowNode.id,
        type: "tool",
        position: workflowNode.position,
        data: { workflowNode }
      }
    ]);
    setSelectedNodeId(workflowNode.id);
    setSelectedEdgeId(null);
  };

  const addFileInput = () => {
    const workflowNode = newFileInputNode(nodes.length + 1);
    setNodes((current) => [
      ...current,
      {
        id: workflowNode.id,
        type: "tool",
        position: workflowNode.position,
        data: { workflowNode }
      }
    ]);
    setSelectedNodeId(workflowNode.id);
    setSelectedEdgeId(null);
  };

  const updateSelectedNode = (updated: WorkflowNodeConfig) => {
    const previous = nodes.find((node) => node.id === updated.id)?.data.workflowNode;
    if (previous) {
      setEdges((current) => remapEdgesForNodeUpdate(previous, updated, current));
    }

    setNodes((current) =>
      current.map((node) =>
        node.id === updated.id
          ? {
              ...node,
              data: {
                workflowNode: {
                  ...updated,
                  position: node.position
                }
              }
            }
          : node
      )
    );
  };

  const deleteNode = (nodeId: string) => {
    setNodes((current) => current.filter((node) => node.id !== nodeId));
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  };

  const deleteSelectedEdge = () => {
    if (!selectedEdgeId) return;
    setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
    setSelectedEdgeId(null);
    setDeleteEdgeDialogOpen(false);
  };

  if (!workflowQuery.data) {
    return <Typography>Loading workflow...</Typography>;
  }

  const workingWorkflow: Workflow = repairWorkflowGraphHandles({
    ...workflowQuery.data,
    name,
    description,
    nodes: nodes.map((node) => ({ ...node.data.workflowNode, position: node.position })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle || undefined,
      targetHandle: edge.targetHandle || undefined
    }))
  });

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }} elevation={1}>
        <Stack direction={{ xs: "column", lg: "row" }} spacing={1.5} alignItems={{ lg: "center" }}>
          <TextField
            label="Workflow name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            size="small"
            sx={{ minWidth: 260 }}
          />
          <TextField
            label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            size="small"
            sx={{ flexGrow: 1 }}
          />
          <Button startIcon={<AddIcon />} variant="outlined" onClick={addTool}>
            Tool
          </Button>
          <Button startIcon={<AddIcon />} variant="outlined" onClick={addFileInput}>
            File Input
          </Button>
          <Button
            startIcon={<LinkOffIcon />}
            variant="outlined"
            color="error"
            disabled={!selectedEdge}
            onClick={() => setDeleteEdgeDialogOpen(true)}
          >
            Delete Wire
          </Button>
          <Button startIcon={<SaveIcon />} variant="contained" onClick={() => saveWorkflow.mutate()} disabled={saveWorkflow.isPending}>
            {saveWorkflow.isPending ? "Saving..." : "Save"}
          </Button>
          <Button startIcon={<PlayArrowIcon />} variant="contained" color="secondary" onClick={() => setRunDialogOpen(true)}>
            Run
          </Button>
          <Button component={RouterLink} to={`/workflows/${workflowId}/runs`} startIcon={<HistoryIcon />} variant="outlined">
            History
          </Button>
          <Button component={RouterLink} to={`/projects/${projectId}`} variant="text">
            Project
          </Button>
        </Stack>
      </Paper>

      <Paper
        sx={{
          height: "calc(100vh - 210px)",
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
              nodes={nodes}
              edges={displayEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={onConnect}
              onEdgeClick={(event, edge) => {
                event.stopPropagation();
                setSelectedNodeId(null);
                setSelectedEdgeId(edge.id);
              }}
              onNodeClick={(_event, node) => {
                setSelectedNodeId(node.id);
                setSelectedEdgeId(null);
              }}
              onPaneClick={() => {
                setSelectedNodeId(null);
                setSelectedEdgeId(null);
              }}
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
            onClose={() => setSelectedNodeId(null)}
            onChange={updateSelectedNode}
            onDelete={deleteNode}
          />
        </Box>
      </Paper>

      <RunDialog workflow={workingWorkflow} open={runDialogOpen} onClose={() => setRunDialogOpen(false)} />
      <ConfirmDialog
        open={deleteEdgeDialogOpen}
        title="Delete connection"
        description="Remove this connection from the workflow?"
        confirmLabel="Delete"
        onCancel={() => setDeleteEdgeDialogOpen(false)}
        onConfirm={deleteSelectedEdge}
      />
      <Snackbar
        open={saveToast.open}
        autoHideDuration={saveToast.severity === "info" ? 1600 : 3000}
        onClose={() => setSaveToast((current) => ({ ...current, open: false }))}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          severity={saveToast.severity}
          variant="filled"
          onClose={() => setSaveToast((current) => ({ ...current, open: false }))}
          sx={{ width: "100%" }}
        >
          {saveToast.message}
        </Alert>
      </Snackbar>
    </Stack>
  );
}
