import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import HistoryIcon from "@mui/icons-material/History";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link as RouterLink, useParams } from "react-router-dom";
import { api, downloadRelativeFile } from "../api/client";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { Project, StoredFile, Workflow, WorkflowRun } from "../types/domain";
import { readableBytes, statusColor } from "../utils/status";

const exampleNodes: Workflow["nodes"] = [
  {
    id: "extract-audio",
    type: "tool",
    label: "Extract Audio",
    position: { x: 80, y: 120 },
    toolConfig: {
      bin: "python3",
      args: [
        "../tools/examples/extract_audio.py",
        "--input",
        "{{inputs.video}}",
        "--output",
        "{{outputs.audio}}"
      ]
    },
    inputs: [{ name: "video", type: "file", flag: "--input", accept: ["mp4", "mov", "mkv", "txt"], required: true }],
    outputs: [{ name: "audio", type: "file", flag: "--output", extension: "wav", preview: "audio" }],
    defaultParams: {}
  },
  {
    id: "transcribe",
    type: "tool",
    label: "Transcribe Mock",
    position: { x: 420, y: 120 },
    toolConfig: {
      bin: "python3",
      args: [
        "../tools/examples/transcribe_mock.py",
        "--input",
        "{{inputs.audio}}",
        "--output",
        "{{outputs.subtitle}}",
        "--language",
        "{{params.language}}"
      ]
    },
    inputs: [{ name: "audio", type: "file", flag: "--input", accept: ["wav", "mp3"], required: true }],
    outputs: [{ name: "subtitle", type: "file", flag: "--output", extension: "srt", preview: "text" }],
    defaultParams: { language: "en" }
  },
  {
    id: "convert",
    type: "tool",
    label: "Build Summary",
    position: { x: 760, y: 120 },
    toolConfig: {
      bin: "python3",
      args: [
        "../tools/examples/convert_mock.py",
        "--input",
        "{{inputs.subtitle}}",
        "--output",
        "{{outputs.result}}",
        "--metadata",
        "{{outputs.metadata}}"
      ]
    },
    inputs: [{ name: "subtitle", type: "file", flag: "--input", accept: ["srt"], required: true }],
    outputs: [
      { name: "result", type: "file", flag: "--output", extension: "txt", preview: "text" },
      { name: "metadata", type: "file", flag: "--metadata", extension: "json", preview: "json" }
    ],
    defaultParams: {}
  }
];

const exampleEdges: Workflow["edges"] = [
  {
    id: "extract-to-transcribe",
    source: "extract-audio",
    target: "transcribe",
    sourceHandle: "audio",
    targetHandle: "audio"
  },
  {
    id: "transcribe-to-convert",
    source: "transcribe",
    target: "convert",
    sourceHandle: "subtitle",
    targetHandle: "subtitle"
  }
];

export function ProjectDetailPage() {
  const { projectId = "" } = useParams();
  const queryClient = useQueryClient();
  const [workflowName, setWorkflowName] = useState("");
  const [workflowToDelete, setWorkflowToDelete] = useState<Workflow | null>(null);

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => (await api.get<{ project: Project }>(`/projects/${projectId}`)).data.project
  });

  const workflowsQuery = useQuery({
    queryKey: ["workflows", projectId],
    queryFn: async () => (await api.get<{ workflows: Workflow[] }>(`/projects/${projectId}/workflows`)).data.workflows
  });

  const filesQuery = useQuery({
    queryKey: ["project-files", projectId],
    queryFn: async () => (await api.get<{ files: StoredFile[] }>(`/projects/${projectId}/files`)).data.files
  });

  const workflowIds = useMemo(() => (workflowsQuery.data || []).map((workflow) => workflow._id).join(","), [workflowsQuery.data]);

  const recentRunsQuery = useQuery({
    queryKey: ["project-runs", projectId, workflowIds],
    enabled: Boolean(workflowIds),
    queryFn: async () => {
      const responses = await Promise.all(
        (workflowsQuery.data || []).map((workflow) => api.get<{ runs: WorkflowRun[] }>(`/workflows/${workflow._id}/runs`))
      );
      return responses
        .flatMap((response) => response.data.runs)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 10);
    }
  });

  const createWorkflow = useMutation({
    mutationFn: async (kind: "blank" | "example") => {
      const name = workflowName.trim() || (kind === "example" ? "Mock media workflow" : "Untitled workflow");
      return api.post(`/projects/${projectId}/workflows`, {
        name,
        description: kind === "example" ? "Example three-step workflow using the bundled Python mock tools." : "",
        nodes: kind === "example" ? exampleNodes : [],
        edges: kind === "example" ? exampleEdges : []
      });
    },
    onSuccess: async () => {
      setWorkflowName("");
      await queryClient.invalidateQueries({ queryKey: ["workflows", projectId] });
    }
  });

  const deleteWorkflow = useMutation({
    mutationFn: async (workflowId: string) => api.delete(`/workflows/${workflowId}`),
    onSuccess: async () => {
      setWorkflowToDelete(null);
      await queryClient.invalidateQueries({ queryKey: ["workflows", projectId] });
    }
  });

  const uploadFiles = useMutation({
    mutationFn: async (files: FileList) => {
      const formData = new FormData();
      Array.from(files).forEach((file) => formData.append("files", file));
      return api.post(`/projects/${projectId}/files/upload`, formData);
    },
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["project-files", projectId] })
  });

  return (
    <Stack spacing={3}>
      <Stack direction="row" alignItems="flex-start" spacing={2}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            {projectQuery.data?.name || "Project"}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {projectQuery.data?.description}
          </Typography>
        </Box>
        <Button component={RouterLink} to="/dashboard" variant="outlined">
          Projects
        </Button>
      </Stack>

      <Paper sx={{ p: 2 }} elevation={1}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} alignItems={{ md: "center" }}>
          <TextField
            size="small"
            label="Workflow name"
            value={workflowName}
            onChange={(event) => setWorkflowName(event.target.value)}
            sx={{ minWidth: 280 }}
          />
          <Button
            startIcon={<AddIcon />}
            variant="contained"
            onClick={() => createWorkflow.mutate("blank")}
            disabled={createWorkflow.isPending}
          >
            Blank
          </Button>
          <Button
            startIcon={<PlayArrowIcon />}
            variant="outlined"
            onClick={() => createWorkflow.mutate("example")}
            disabled={createWorkflow.isPending}
          >
            Example
          </Button>
          <Box sx={{ flexGrow: 1 }} />
          <Button startIcon={<UploadFileIcon />} variant="outlined" component="label">
            Upload Files
            <input hidden type="file" multiple onChange={(event) => event.target.files && uploadFiles.mutate(event.target.files)} />
          </Button>
        </Stack>
      </Paper>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "2fr 1fr" }, gap: 3 }}>
        <Paper sx={{ overflow: "hidden" }} elevation={1}>
          <Box sx={{ px: 2, py: 1.5 }}>
            <Typography variant="h6">Workflows</Typography>
          </Box>
          <Divider />
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Nodes</TableCell>
                <TableCell>Updated</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(workflowsQuery.data || []).map((workflow) => (
                <TableRow key={workflow._id} hover>
                  <TableCell>
                    <Button
                      component={RouterLink}
                      to={`/projects/${projectId}/workflows/${workflow._id}`}
                      startIcon={<AccountTreeIcon />}
                    >
                      {workflow.name}
                    </Button>
                  </TableCell>
                  <TableCell>{workflow.nodes.length}</TableCell>
                  <TableCell>{new Date(workflow.updatedAt).toLocaleString()}</TableCell>
                  <TableCell align="right">
                    <Tooltip title="Run history">
                      <IconButton component={RouterLink} to={`/workflows/${workflow._id}/runs`}>
                        <HistoryIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete workflow">
                      <IconButton color="error" onClick={() => setWorkflowToDelete(workflow)}>
                        <DeleteIcon />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>

        <Stack spacing={3}>
          <Paper sx={{ overflow: "hidden" }} elevation={1}>
            <Box sx={{ px: 2, py: 1.5 }}>
              <Typography variant="h6">Recent Runs</Typography>
            </Box>
            <Divider />
            <Table size="small">
              <TableBody>
                {(recentRunsQuery.data || []).map((run) => (
                  <TableRow key={run._id} hover>
                    <TableCell>
                      <Button component={RouterLink} to={`/runs/${run._id}`}>
                        {new Date(run.createdAt).toLocaleString()}
                      </Button>
                    </TableCell>
                    <TableCell align="right">
                      <Chip size="small" label={run.status} sx={{ color: "#fff", bgcolor: statusColor(run.status) }} />
                    </TableCell>
                  </TableRow>
                ))}
                {!recentRunsQuery.data?.length && (
                  <TableRow>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        No runs yet.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Paper>

          <Paper sx={{ overflow: "hidden" }} elevation={1}>
            <Box sx={{ px: 2, py: 1.5 }}>
              <Typography variant="h6">Project Files</Typography>
            </Box>
            <Divider />
            <Table size="small">
              <TableBody>
                {(filesQuery.data || []).slice(0, 12).map((file) => (
                  <TableRow key={file.relativePath}>
                    <TableCell sx={{ maxWidth: 260 }}>
                      <Typography variant="body2" noWrap title={file.relativePath}>
                        {file.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {readableBytes(file.size)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Button size="small" onClick={() => downloadRelativeFile(file.relativePath)}>
                        Download
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {!filesQuery.data?.length && (
                  <TableRow>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        No uploaded files.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Paper>
        </Stack>
      </Box>
      <ConfirmDialog
        open={Boolean(workflowToDelete)}
        title="Delete Workflow"
        description={
          workflowToDelete
            ? `Delete "${workflowToDelete.name}"? Previous runs for this workflow will also be removed.`
            : ""
        }
        confirmLabel="Delete"
        loading={deleteWorkflow.isPending}
        onCancel={() => setWorkflowToDelete(null)}
        onConfirm={() => workflowToDelete && deleteWorkflow.mutate(workflowToDelete._id)}
      />
    </Stack>
  );
}
