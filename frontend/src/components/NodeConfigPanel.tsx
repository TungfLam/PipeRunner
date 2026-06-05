import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import DeleteIcon from "@mui/icons-material/Delete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import type {
  PreviewType,
  RunStep,
  WorkflowInputDefinition,
  WorkflowNodeConfig,
  WorkflowOutputDefinition
} from "../types/domain";
import { statusColor } from "../utils/status";
import {
  nameFromFlag,
  normalizeInputDefinition,
  normalizeOutputDefinition,
  shouldAutoUpdateName
} from "../utils/workflowHandles";

interface Props {
  node: WorkflowNodeConfig | null;
  step?: RunStep;
  logs?: string;
  readOnly?: boolean;
  onClose: () => void;
  onChange?: (node: WorkflowNodeConfig) => void;
  onDelete?: (nodeId: string) => void;
}

const previewTypes: PreviewType[] = ["video", "audio", "text", "json", "image"];

function splitLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseFixedOptions(value: string) {
  return splitLines(value).flatMap((line) => {
    const separator = line.indexOf("=");
    if (!line.startsWith("--") || separator === -1) {
      return [line];
    }

    const flag = line.slice(0, separator).trim();
    const optionValue = line.slice(separator + 1).trim();
    if (!flag) {
      return [];
    }
    return optionValue ? [flag, optionValue] : [flag];
  });
}

function parseCsv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim().replace(/^\./, ""))
    .filter(Boolean);
}

function parseScalar(value: string) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

function objectToKeyValueLines(value?: Record<string, unknown>) {
  return Object.entries(value || {})
    .map(([key, item]) => `${key}=${String(item)}`)
    .join("\n");
}

function keyValueLinesToObject(value: string) {
  return Object.fromEntries(
    splitLines(value)
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator === -1) {
          return [line, ""] as const;
        }
        return [line.slice(0, separator).trim(), parseScalar(line.slice(separator + 1).trim())] as const;
      })
      .filter(([key]) => Boolean(key))
  );
}

function envLinesToObject(value: string) {
  return Object.fromEntries(
    Object.entries(keyValueLinesToObject(value)).map(([key, item]) => [key, String(item)])
  );
}

function previewForExtension(extension?: string): PreviewType | undefined {
  const ext = extension?.replace(/^\./, "").toLowerCase();
  if (!ext) return undefined;
  if (["mp4", "mov", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav"].includes(ext)) return "audio";
  if (["txt", "srt", "log"].includes(ext)) return "text";
  if (ext === "json") return "json";
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) return "image";
  return undefined;
}

function buildArgs(inputs: WorkflowInputDefinition[], outputs: WorkflowOutputDefinition[], fixedOptionsText: string) {
  const generated: string[] = [];
  for (const input of inputs) {
    if (input.flag && input.name) {
      generated.push(input.flag, `{{inputs.${input.name}}}`);
    }
  }
  for (const output of outputs) {
    if (output.flag && output.name) {
      generated.push(output.flag, `{{outputs.${output.name}}}`);
    }
  }
  return [...generated, ...parseFixedOptions(fixedOptionsText)];
}

function deriveFixedOptions(node: WorkflowNodeConfig) {
  const args = [...(node.toolConfig.args || [])];
  const generatedPairs = new Map<string, string>();
  const templateArgPattern = /^\{\{\s*(inputs|outputs)\.[^{}]+?\s*\}\}$/;

  for (const input of node.inputs || []) {
    if (input.flag) {
      generatedPairs.set(input.flag, `{{inputs.${input.name}}}`);
    }
  }
  for (const output of node.outputs || []) {
    if (output.flag) {
      generatedPairs.set(output.flag, `{{outputs.${output.name}}}`);
    }
  }

  const fixed: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const nextTemplate = generatedPairs.get(args[index]);
    if ((nextTemplate && args[index + 1] === nextTemplate) || (args[index].startsWith("--") && templateArgPattern.test(args[index + 1] || ""))) {
      index += 1;
      continue;
    }
    if (node.toolConfig.bin !== "python3" && args[index].includes("tools/examples/convert_mock.py")) {
      continue;
    }
    fixed.push(args[index]);
  }
  return fixed.join("\n");
}

function defaultInput(): WorkflowInputDefinition {
  return {
    name: "input",
    type: "file",
    flag: "--input",
    accept: [],
    required: true
  };
}

function defaultOutput(): WorkflowOutputDefinition {
  return {
    name: "result",
    type: "file",
    flag: "--output",
    extension: "txt",
    preview: "text"
  };
}

export function NodeConfigPanel({ node, step, logs, readOnly = false, onClose, onChange, onDelete }: Props) {
  const [fixedOptionsText, setFixedOptionsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [paramsText, setParamsText] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  useEffect(() => {
    if (!node) return;
    const nextFixedOptionsText = deriveFixedOptions(node);
    setFixedOptionsText(nextFixedOptionsText);
    setEnvText(objectToKeyValueLines(node.toolConfig.env));
    setParamsText(objectToKeyValueLines(node.defaultParams));

    if (!readOnly && onChange) {
      const normalizedInputs = node.inputs.map(normalizeInputDefinition);
      const normalizedOutputs = node.outputs.map(normalizeOutputDefinition);
      const normalizedArgs = buildArgs(normalizedInputs, normalizedOutputs, nextFixedOptionsText);
      if (
        JSON.stringify(normalizedArgs) !== JSON.stringify(node.toolConfig.args || []) ||
        JSON.stringify(normalizedInputs) !== JSON.stringify(node.inputs) ||
        JSON.stringify(normalizedOutputs) !== JSON.stringify(node.outputs)
      ) {
        onChange({
          ...node,
          inputs: normalizedInputs,
          outputs: normalizedOutputs,
          toolConfig: {
            ...node.toolConfig,
            args: normalizedArgs
          }
        });
      }
    }
  }, [node?.id]);

  const title = useMemo(() => node?.label || "Node", [node]);

  if (!node) {
    return (
      <Box sx={{ width: 520, borderLeft: "1px solid", borderColor: "divider", bgcolor: "background.paper", p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Select a node to edit its command and handles.
        </Typography>
      </Box>
    );
  }

  const emitChange = (
    partial: Partial<WorkflowNodeConfig>,
    nextInputs = partial.inputs || node.inputs,
    nextOutputs = partial.outputs || node.outputs,
    nextFixedOptionsText = fixedOptionsText,
    nextEnvText = envText,
    nextParamsText = paramsText
  ) => {
    if (readOnly || !onChange) return;
    onChange({
      ...node,
      ...partial,
      inputs: nextInputs,
      outputs: nextOutputs,
      defaultParams: keyValueLinesToObject(nextParamsText),
      toolConfig: {
        ...node.toolConfig,
        ...(partial.toolConfig || {}),
        env: envLinesToObject(nextEnvText),
        args: buildArgs(nextInputs, nextOutputs, nextFixedOptionsText)
      }
    });
  };

  const updateInput = (index: number, patch: Partial<WorkflowInputDefinition>) => {
    const nextInputs = node.inputs.map((input, inputIndex) =>
      inputIndex === index
        ? {
            ...input,
            ...patch,
            name:
              patch.flag !== undefined && shouldAutoUpdateName(input.name, input.flag, `input${index + 1}`)
                ? nameFromFlag(patch.flag, `input${index + 1}`)
                : patch.name ?? input.name
          }
        : input
    );
    emitChange({ inputs: nextInputs }, nextInputs);
  };

  const updateOutput = (index: number, patch: Partial<WorkflowOutputDefinition>) => {
    const nextOutputs = node.outputs.map((output, outputIndex) =>
      outputIndex === index
        ? {
            ...output,
            ...patch,
            name:
              patch.flag !== undefined && shouldAutoUpdateName(output.name, output.flag, `output${index + 1}`)
                ? nameFromFlag(patch.flag, `output${index + 1}`)
                : patch.name ?? output.name,
            preview: patch.extension && !patch.preview ? previewForExtension(patch.extension) : patch.preview || output.preview
          }
        : output
    );
    emitChange({ outputs: nextOutputs }, undefined, nextOutputs);
  };

  const generatedArgs = buildArgs(node.inputs, node.outputs, fixedOptionsText);
  const isFileInput = node.type === "fileInput";

  return (
    <Box
      sx={{
        width: { xs: 460, xl: 560 },
        flexShrink: 0,
        borderLeft: "1px solid",
        borderColor: "divider",
        bgcolor: "background.paper",
        overflow: "auto"
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 2, py: 1.5 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: "50%", bgcolor: statusColor(step?.status), flexShrink: 0 }} />
        <Typography variant="subtitle1" sx={{ fontWeight: 700, flexGrow: 1 }} noWrap title={title}>
          {title}
        </Typography>
        {!readOnly && onDelete && (
          <Tooltip title="Delete node">
            <IconButton
              color="error"
              onClick={() => setDeleteDialogOpen(true)}
              size="small"
            >
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title="Close panel">
          <IconButton onClick={onClose} size="small">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Divider />
      <Stack spacing={2} sx={{ p: 2 }}>
        <TextField
          label="Node label"
          value={node.label}
          disabled={readOnly}
          onChange={(event) => emitChange({ label: event.target.value })}
          size="small"
          fullWidth
        />
        {!isFileInput && (
          <>
            <TextField
              label="Command"
              placeholder="vocremove"
              value={node.toolConfig.bin}
              disabled={readOnly}
              onChange={(event) => emitChange({ toolConfig: { ...node.toolConfig, bin: event.target.value } })}
              size="small"
              fullWidth
            />
            <TextField
              label="Working directory"
              value={node.toolConfig.workingDir || ""}
              disabled={readOnly}
              onChange={(event) =>
                emitChange({ toolConfig: { ...node.toolConfig, workingDir: event.target.value || undefined } })
              }
              size="small"
              fullWidth
            />
            <TextField
              label="Timeout seconds"
              type="number"
              value={node.toolConfig.timeoutSeconds || ""}
              disabled={readOnly}
              onChange={(event) =>
                emitChange({
                  toolConfig: {
                    ...node.toolConfig,
                    timeoutSeconds: event.target.value ? Number(event.target.value) : undefined
                  }
                })
              }
              size="small"
              fullWidth
            />
          </>
        )}

        {!isFileInput && (
          <>
            <Divider />
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
                Inputs
              </Typography>
              {!readOnly && (
                <Button
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={() => {
                    const nextInput = { ...defaultInput(), name: nameFromFlag(defaultInput().flag, `input${node.inputs.length + 1}`) };
                    const nextInputs = [...node.inputs, nextInput];
                    emitChange({ inputs: nextInputs }, nextInputs);
                  }}
                >
                  Input
                </Button>
              )}
            </Stack>
            {node.inputs.map((input, index) => (
              <Box key={`input-row-${index}`} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 1 }}>
                <Stack spacing={1}>
                  <Stack direction="row" spacing={1}>
                    <TextField
                      label="Name"
                      value={input.name}
                      disabled={readOnly}
                      onChange={(event) => updateInput(index, { name: event.target.value })}
                      size="small"
                      sx={{ flex: 1 }}
                      helperText="Auto from CLI flag; editable."
                    />
                    <TextField
                      label="CLI flag"
                      placeholder="--mp4-input"
                      value={input.flag || ""}
                      disabled={readOnly}
                      onChange={(event) => updateInput(index, { flag: event.target.value })}
                      size="small"
                      sx={{ flex: 1 }}
                    />
                    {!readOnly && (
                      <Tooltip title="Remove input">
                        <IconButton
                          color="error"
                          onClick={() => {
                            const nextInputs = node.inputs.filter((_item, inputIndex) => inputIndex !== index);
                            emitChange({ inputs: nextInputs }, nextInputs);
                          }}
                        >
                          <DeleteIcon />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Stack>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <TextField
                      label="Accepted extensions"
                      placeholder="mp4,mov,mkv"
                      value={(input.accept || []).join(",")}
                      disabled={readOnly}
                      onChange={(event) => updateInput(index, { accept: parseCsv(event.target.value) })}
                      size="small"
                      sx={{ flex: 1 }}
                    />
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={Boolean(input.required)}
                          disabled={readOnly}
                          onChange={(event) => updateInput(index, { required: event.target.checked })}
                        />
                      }
                      label="Required"
                    />
                  </Stack>
                </Stack>
              </Box>
            ))}
          </>
        )}

        <Divider />
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
            Outputs
          </Typography>
          {!readOnly && (
            <Button
              size="small"
              startIcon={<AddIcon />}
              onClick={() => {
                const nextOutput = { ...defaultOutput(), name: nameFromFlag(defaultOutput().flag, `output${node.outputs.length + 1}`) };
                const nextOutputs = [...node.outputs, nextOutput];
                emitChange({ outputs: nextOutputs }, undefined, nextOutputs);
              }}
            >
              Output
            </Button>
          )}
        </Stack>
        {node.outputs.map((output, index) => (
          <Box key={`output-row-${index}`} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 1 }}>
            <Stack spacing={1}>
              <Stack direction="row" spacing={1}>
                <TextField
                  label="Name"
                  value={output.name}
                  disabled={readOnly}
                  onChange={(event) => updateOutput(index, { name: event.target.value })}
                  size="small"
                  sx={{ flex: 1 }}
                  helperText="Auto from CLI flag; editable."
                />
                <TextField
                  label={isFileInput ? "CLI flag" : "CLI flag"}
                  placeholder="--mp4-output"
                  value={output.flag || ""}
                  disabled={readOnly}
                  onChange={(event) => updateOutput(index, { flag: event.target.value })}
                  size="small"
                  sx={{ flex: 1 }}
                />
                {!readOnly && (
                  <Tooltip title="Remove output">
                    <IconButton
                      color="error"
                      onClick={() => {
                        const nextOutputs = node.outputs.filter((_item, outputIndex) => outputIndex !== index);
                        emitChange({ outputs: nextOutputs }, undefined, nextOutputs);
                      }}
                    >
                      <DeleteIcon />
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>
              <Stack direction="row" spacing={1}>
                <TextField
                  label="Extension"
                  placeholder="mp4"
                  value={output.extension || ""}
                  disabled={readOnly}
                  onChange={(event) => updateOutput(index, { extension: event.target.value.replace(/^\./, "") })}
                  size="small"
                  sx={{ flex: 1 }}
                />
                <TextField
                  label="Preview"
                  select
                  value={output.preview || ""}
                  disabled={readOnly}
                  onChange={(event) => updateOutput(index, { preview: event.target.value as PreviewType })}
                  size="small"
                  sx={{ flex: 1 }}
                >
                  <MenuItem value="">Auto</MenuItem>
                  {previewTypes.map((preview) => (
                    <MenuItem key={preview} value={preview}>
                      {preview}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
            </Stack>
          </Box>
        ))}

        {!isFileInput && (
          <>
            <Divider />
            <TextField
              label="Fixed options"
              placeholder={"--chunk-duration=10\n--medium=\n--device=cpu\n--verbose="}
              value={fixedOptionsText}
              disabled={readOnly}
              onChange={(event) => {
                const nextValue = event.target.value;
                setFixedOptionsText(nextValue);
                emitChange({}, undefined, undefined, nextValue);
              }}
              minRows={7}
              multiline
              fullWidth
              helperText="Supports --flag=value. Use --medium= or --verbose= for flags without values."
            />
            <Stack spacing={0.75}>
              <Typography variant="caption" color="text.secondary">
                Generated command
              </Typography>
              <Box
                component="pre"
                sx={{
                  m: 0,
                  maxHeight: 170,
                  overflow: "auto",
                  fontSize: 12,
                  bgcolor: (theme) => (theme.palette.mode === "dark" ? "#0b0f14" : "#f8fafc"),
                  color: "text.primary",
                  border: "1px solid",
                  borderColor: "divider",
                  p: 1.25,
                  borderRadius: 1,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word"
                }}
              >
                {[node.toolConfig.bin || "command", ...generatedArgs].join(" ")}
              </Box>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                {node.inputs.map((input) => (
                  <Chip key={`input-${input.name}`} size="small" label={`input:${input.name}`} />
                ))}
                {node.outputs.map((output) => (
                  <Chip key={`output-${output.name}`} size="small" color="secondary" label={`output:${output.name}`} />
                ))}
              </Stack>
            </Stack>
          </>
        )}

        {!isFileInput && (
          <>
            <Divider />
            <TextField
              label="Default params"
              placeholder={"language=en\nquality=medium"}
              value={paramsText}
              disabled={readOnly}
              onChange={(event) => {
                const nextValue = event.target.value;
                setParamsText(nextValue);
                emitChange({}, undefined, undefined, undefined, undefined, nextValue);
              }}
              minRows={2}
              multiline
              fullWidth
              helperText="Optional variables only. Example: language=en, then use {{params.language}} in fixed options."
            />
            <TextField
              label="Environment"
              placeholder={"CUDA_VISIBLE_DEVICES=0\nPYTHONUNBUFFERED=1"}
              value={envText}
              disabled={readOnly}
              onChange={(event) => {
                const nextValue = event.target.value;
                setEnvText(nextValue);
                emitChange({}, undefined, undefined, undefined, nextValue);
              }}
              minRows={2}
              multiline
              fullWidth
            />
          </>
        )}

        {step && (
          <>
            <Divider />
            <Typography variant="subtitle2">Current Step</Typography>
            <Typography variant="body2" color="text.secondary">
              {step.status}
              {typeof step.exitCode === "number" ? `, exit ${step.exitCode}` : ""}
            </Typography>
            {step.errorMessage && (
              <Typography variant="body2" color="error">
                {step.errorMessage}
              </Typography>
            )}
          </>
        )}
        {logs !== undefined && (
          <TextField
            label="Logs"
            value={logs || "No logs captured for this step yet."}
            InputProps={{ readOnly: true }}
            minRows={10}
            multiline
            fullWidth
          />
        )}
      </Stack>
      <ConfirmDialog
        open={deleteDialogOpen}
        title="Delete Node"
        description={`Delete "${node.label}"? Connected edges will also be removed.`}
        confirmLabel="Delete"
        onCancel={() => setDeleteDialogOpen(false)}
        onConfirm={() => {
          setDeleteDialogOpen(false);
          onDelete?.(node.id);
        }}
      />
    </Box>
  );
}
