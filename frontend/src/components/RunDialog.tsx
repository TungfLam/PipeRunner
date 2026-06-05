import DeleteIcon from "@mui/icons-material/Delete";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
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
  const [files, setFiles] = useState<Record<string, File[]>>({});
  const [textInputs, setTextInputs] = useState<Record<string, string>>({});
  const [paramsJson, setParamsJson] = useState("{}");
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);

  const addFile = (inputName: string, file?: File) => {
    if (!file) return;
    setFiles((current) => ({ ...current, [inputName]: [...(current[inputName] || []), file] }));
  };

  const removeFile = (inputName: string, index: number) => {
    setFiles((current) => ({
      ...current,
      [inputName]: (current[inputName] || []).filter((_file, fileIndex) => fileIndex !== index)
    }));
  };

  const requiredInputs = useMemo(() => {
    const incomingTargets = new Set(workflow.edges.map((edge) => `${edge.target}:${edge.targetHandle || ""}`));
    const definitions = new Map<string, WorkflowInputDefinition>();
    for (const node of workflow.nodes) {
      if (node.type === "fileInput") {
        for (const output of node.outputs || []) {
          definitions.set(output.name, {
            name: output.name,
            type: output.type || "file",
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
      for (const [inputName, inputFiles] of Object.entries(files)) {
        for (const file of inputFiles || []) {
          formData.append(inputName, file);
        }
      }
      formData.append(
        "textInputs",
        JSON.stringify(
          Object.fromEntries(
            Object.entries(textInputs).map(([inputName, value]) => [
              inputName,
              value
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
            ])
          )
        )
      );
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
              This workflow has no unconnected inputs.
            </Typography>
          ) : (
            requiredInputs.map((input) => {
              const selectedFiles = files[input.name] || [];
              if (input.type === "text") {
                return (
                  <TextField
                    key={input.name}
                    label={`${input.name}${input.required ? " *" : ""}`}
                    placeholder={"https://example.com/item-1\nhttps://example.com/item-2"}
                    value={textInputs[input.name] || ""}
                    onChange={(event) => setTextInputs((current) => ({ ...current, [input.name]: event.target.value }))}
                    minRows={4}
                    multiline
                    fullWidth
                    helperText="One non-empty line becomes one batch item. The value is passed as a string."
                  />
                );
              }
              return (
                <Box key={input.name}>
                  <Stack spacing={1}>
                    <Button variant="outlined" component="label" fullWidth>
                      {selectedFiles.length
                        ? `Add ${input.name} (${selectedFiles.length} selected)`
                        : `Add ${input.name}${input.required ? " *" : ""}`}
                      <input
                        hidden
                        type="file"
                        accept={(input.accept || []).map((ext) => `.${ext.replace(/^\./, "")}`).join(",")}
                        onChange={(event) => {
                          addFile(input.name, event.target.files?.[0]);
                          event.target.value = "";
                        }}
                      />
                    </Button>
                    {selectedFiles.length > 0 && (
                      <Stack spacing={0.75}>
                        {selectedFiles.map((file, index) => (
                          <Stack
                            key={`${file.name}-${file.lastModified}-${index}`}
                            direction="row"
                            spacing={1}
                            alignItems="center"
                            sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, px: 1, py: 0.75 }}
                          >
                            <Typography variant="body2" sx={{ flexGrow: 1, minWidth: 0 }} noWrap title={file.name}>
                              {index + 1}. {file.name}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {(file.size / 1024 / 1024).toFixed(file.size >= 10 * 1024 * 1024 ? 0 : 1)} MB
                            </Typography>
                            <IconButton size="small" color="error" onClick={() => removeFile(input.name, index)}>
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Stack>
                        ))}
                      </Stack>
                    )}
                  </Stack>
                </Box>
              );
            })
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
