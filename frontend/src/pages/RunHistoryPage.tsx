import DeleteIcon from "@mui/icons-material/Delete";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import RefreshIcon from "@mui/icons-material/Refresh";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link as RouterLink, useParams } from "react-router-dom";
import { api } from "../api/client";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { Workflow, WorkflowRun } from "../types/domain";
import { readableBytes, statusColor } from "../utils/status";

function canDeleteRun(run: WorkflowRun) {
  return run.status !== "running" && run.status !== "pending";
}

export function RunHistoryPage() {
  const { workflowId = "" } = useParams();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("");
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const workflowQuery = useQuery({
    queryKey: ["workflow", workflowId],
    queryFn: async () => (await api.get<{ workflow: Workflow }>(`/workflows/${workflowId}`)).data.workflow
  });

  const runsQuery = useQuery({
    queryKey: ["workflow-runs", workflowId, status],
    queryFn: async () =>
      (
        await api.get<{ runs: WorkflowRun[] }>(`/workflows/${workflowId}/runs`, {
          params: status ? { status } : {}
        })
      ).data.runs
  });

  const runs = runsQuery.data || [];
  const deletableRuns = useMemo(() => runs.filter(canDeleteRun), [runs]);
  const selectedSet = useMemo(() => new Set(selectedRunIds), [selectedRunIds]);
  const allDeletableSelected = deletableRuns.length > 0 && deletableRuns.every((run) => selectedSet.has(run._id));
  const someDeletableSelected = deletableRuns.some((run) => selectedSet.has(run._id));
  const selectedStorageBytes = runs
    .filter((run) => selectedSet.has(run._id))
    .reduce((total, run) => total + (run.storageBytes || 0), 0);

  const bulkDeleteRuns = useMutation({
    mutationFn: async (runIds: string[]) => api.post<{ deleted: string[]; skipped: Array<{ runId: string; reason: string }> }>("/runs/bulk-delete", { runIds }),
    onSuccess: async () => {
      setSelectedRunIds([]);
      setDeleteDialogOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["workflow-runs", workflowId, status] });
      await queryClient.invalidateQueries({ queryKey: ["project-runs"] });
    }
  });

  const toggleRun = (runId: string) => {
    setSelectedRunIds((current) =>
      current.includes(runId) ? current.filter((id) => id !== runId) : [...current, runId]
    );
  };

  const toggleAllVisible = () => {
    if (allDeletableSelected) {
      setSelectedRunIds((current) => current.filter((id) => !deletableRuns.some((run) => run._id === id)));
      return;
    }
    setSelectedRunIds((current) => Array.from(new Set([...current, ...deletableRuns.map((run) => run._id)])));
  };

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }} elevation={1}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} alignItems={{ md: "center" }}>
          <Box sx={{ flexGrow: 1 }}>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              Run History
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {workflowQuery.data?.name}
            </Typography>
          </Box>
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel>Status</InputLabel>
            <Select label="Status" value={status} onChange={(event) => setStatus(event.target.value)}>
              <MenuItem value="">All</MenuItem>
              <MenuItem value="pending">Pending</MenuItem>
              <MenuItem value="running">Running</MenuItem>
              <MenuItem value="success">Success</MenuItem>
              <MenuItem value="failed">Failed</MenuItem>
              <MenuItem value="cancelled">Cancelled</MenuItem>
            </Select>
          </FormControl>
          <Button startIcon={<RefreshIcon />} variant="outlined" onClick={() => runsQuery.refetch()}>
            Refresh
          </Button>
          <Button
            startIcon={<DeleteIcon />}
            variant="outlined"
            color="error"
            disabled={selectedRunIds.length === 0 || bulkDeleteRuns.isPending}
            onClick={() => setDeleteDialogOpen(true)}
          >
            Delete Selected
          </Button>
          {selectedRunIds.length > 0 && (
            <Typography variant="body2" color="text.secondary">
              Selected: {selectedRunIds.length}, about {readableBytes(selectedStorageBytes) || "0 B"}
            </Typography>
          )}
          {workflowQuery.data && (
            <Button
              component={RouterLink}
              to={`/projects/${workflowQuery.data.projectId}/workflows/${workflowId}`}
              variant="contained"
            >
              Editor
            </Button>
          )}
        </Stack>
      </Paper>

      <Paper sx={{ overflow: "hidden" }} elevation={1}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox">
                <Checkbox
                  checked={allDeletableSelected}
                  indeterminate={!allDeletableSelected && someDeletableSelected}
                  disabled={deletableRuns.length === 0}
                  onChange={toggleAllVisible}
                />
              </TableCell>
              <TableCell>Started</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Storage</TableCell>
              <TableCell>Steps</TableCell>
              <TableCell>Outputs</TableCell>
              <TableCell>Finished</TableCell>
              <TableCell align="right">Open</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run._id} hover>
                <TableCell padding="checkbox">
                  <Checkbox
                    checked={selectedSet.has(run._id)}
                    disabled={!canDeleteRun(run)}
                    onChange={() => toggleRun(run._id)}
                  />
                </TableCell>
                <TableCell>{run.startedAt ? new Date(run.startedAt).toLocaleString() : new Date(run.createdAt).toLocaleString()}</TableCell>
                <TableCell>
                  <Chip size="small" label={run.status} sx={{ bgcolor: statusColor(run.status), color: "#fff" }} />
                </TableCell>
                <TableCell>{readableBytes(run.storageBytes) || "0 B"}</TableCell>
                <TableCell>{run.steps?.length || 0}</TableCell>
                <TableCell>{run.outputFiles?.length || 0}</TableCell>
                <TableCell>{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : ""}</TableCell>
                <TableCell align="right">
                  <Button component={RouterLink} to={`/runs/${run._id}`} startIcon={<OpenInNewIcon />} size="small">
                    Run
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!runsQuery.isLoading && runsQuery.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={8}>
                  <Typography variant="body2" color="text.secondary">
                    No runs match this filter.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>
      <ConfirmDialog
        open={deleteDialogOpen}
        title="Delete Runs"
        description={`Delete ${selectedRunIds.length} selected run${selectedRunIds.length === 1 ? "" : "s"} using about ${readableBytes(selectedStorageBytes) || "0 B"}? Database records and local run folders under DATA_ROOT will be removed.`}
        confirmLabel="Delete"
        loading={bulkDeleteRuns.isPending}
        onCancel={() => setDeleteDialogOpen(false)}
        onConfirm={() => bulkDeleteRuns.mutate(selectedRunIds)}
      />
    </Stack>
  );
}
