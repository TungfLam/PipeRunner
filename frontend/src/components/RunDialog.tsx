import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Workflow, WorkflowInputDefinition } from "../types/domain";

interface Props {
  workflow: Workflow;
  open: boolean;
  onClose: () => void;
}

export function RunDialog({ workflow, open, onClose }: Props) {
  const navigate = useNavigate();
  const [files, setFiles] = useState<Record<string, File | undefined>>({});
  const [paramsJson, setParamsJson] = useState("{}");
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);

  const requiredInputs = useMemo(() => {
    const incomingTargets = new Set(workflow.edges.map((edge) => `${edge.target}:${edge.targetHandle || ""}`));
    const definitions = new Map<string, WorkflowInputDefinition>();
    for (const node of workflow.nodes) {
      if (node.type === "fileInput") {
        for (const output of node.outputs || []) {
          definitions.set(output.name, {
            name: output.name,
            type: "file",
            accept: output.extension ? [output.extension] : [],
            required: true
          });
        }
        continue;
      }
      for (const input of node.inputs || []) {
        if (!incomingTargets.has(`${node.id}:${input.name}`)) {
          definitions.set(input.name, input);
        }
      }
    }
    return Array.from(definitions.values());
  }, [workflow]);

  const startRun = async () => {
    setRunning(true);
    setError("");
    try {
      const formData = new FormData();
      for (const [inputName, file] of Object.entries(files)) {
        if (file) {
          formData.append(inputName, file);
        }
      }
      formData.append("params", JSON.stringify(JSON.parse(paramsJson || "{}")));
      formData.append("inputs", JSON.stringify({}));
      const response = await api.post(`/workflows/${workflow._id}/runs`, formData);
      navigate(`/runs/${response.data.run._id}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to start run");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Run Workflow</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {requiredInputs.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              This workflow has no unconnected file inputs.
            </Typography>
          ) : (
            requiredInputs.map((input) => (
              <Box key={input.name}>
                <Button variant="outlined" component="label" fullWidth>
                  {files[input.name]?.name || `Select ${input.name}${input.required ? " *" : ""}`}
                  <input
                    hidden
                    type="file"
                    accept={(input.accept || []).map((ext) => `.${ext.replace(/^\./, "")}`).join(",")}
                    onChange={(event) => setFiles((current) => ({ ...current, [input.name]: event.target.files?.[0] }))}
                  />
                </Button>
              </Box>
            ))
          )}
          <TextField
            label="Run params JSON"
            value={paramsJson}
            onChange={(event) => setParamsJson(event.target.value)}
            minRows={4}
            multiline
            fullWidth
            error={Boolean(error)}
            helperText={error}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button disabled={running} onClick={startRun} startIcon={<PlayArrowIcon />} variant="contained">
          {running ? "Starting..." : "Run"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
