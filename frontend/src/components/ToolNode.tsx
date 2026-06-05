import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { StepStatus, WorkflowNodeConfig } from "../types/domain";
import { statusColor } from "../utils/status";

export interface ToolNodeData {
  [key: string]: unknown;
  workflowNode: WorkflowNodeConfig;
  status?: StepStatus;
}

export function ToolNode({ data, selected }: NodeProps) {
  const typedData = data as unknown as ToolNodeData;
  const node = typedData.workflowNode;
  const status = typedData.status || "waiting";
  const borderColor = statusColor(status);

  const inputTop = (index: number, total: number) => `${((index + 1) / (total + 1)) * 100}%`;
  const outputTop = (index: number, total: number) => `${((index + 1) / (total + 1)) * 100}%`;
  const handleSize = 24;

  return (
    <Box
      className={status === "running" ? "tool-node-running" : undefined}
      sx={{
        width: 340,
        minHeight: 136,
        bgcolor: "background.paper",
        border: "2px solid",
        borderColor: selected ? "text.primary" : borderColor,
        borderRadius: 1,
        boxShadow: selected ? 4 : 1,
        position: "relative",
        px: 1.5,
        py: 1.25,
        "--xy-node-handle-bg": (theme) => theme.palette.background.paper,
        "--xy-node-handle-border": (theme) => theme.palette.primary.main,
        "--xy-node-handle-color": (theme) => theme.palette.primary.main
      }}
    >
      {(node.inputs || []).map((input, index) => (
        <Box
          key={`in-port-${input.name}`}
          sx={{
            position: "absolute",
            left: -10,
            top: inputTop(index, node.inputs.length),
            transform: "translateY(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 0.5,
            zIndex: 2
          }}
        >
          <Handle
            id={input.name}
            type="target"
            position={Position.Left}
            style={{
              position: "relative",
              left: 0,
              top: 0,
              transform: "none",
              width: handleSize,
              height: handleSize,
              borderRadius: "50%",
              border: "2px solid var(--xy-node-handle-border)",
              background: "var(--xy-node-handle-bg)",
              color: "var(--xy-node-handle-color)",
              display: "grid",
              placeItems: "center",
              fontSize: 18,
              fontWeight: 700,
              lineHeight: "20px"
            }}
          >
            +
          </Handle>
          <Box
            sx={{
              maxWidth: 118,
              px: 0.75,
              py: 0.25,
              borderRadius: 1,
              bgcolor: "background.paper",
              border: "1px solid",
              borderColor: "divider",
              boxShadow: 1,
              pointerEvents: "none"
            }}
          >
            <Typography variant="caption" noWrap title={input.name} sx={{ display: "block", fontWeight: 700 }}>
              {input.name}
            </Typography>
          </Box>
        </Box>
      ))}
      {(node.outputs || []).map((output, index) => (
        <Box
          key={`out-port-${output.name}`}
          sx={{
            position: "absolute",
            right: -10,
            top: outputTop(index, node.outputs.length),
            transform: "translateY(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 0.5,
            zIndex: 2
          }}
        >
          <Box
            sx={{
              maxWidth: 118,
              px: 0.75,
              py: 0.25,
              borderRadius: 1,
              bgcolor: "background.paper",
              border: "1px solid",
              borderColor: "divider",
              boxShadow: 1,
              pointerEvents: "none"
            }}
          >
            <Typography variant="caption" noWrap title={output.name} sx={{ display: "block", fontWeight: 700 }}>
              {output.name}
            </Typography>
          </Box>
          <Handle
            id={output.name}
            type="source"
            position={Position.Right}
            style={{
              position: "relative",
              right: 0,
              top: 0,
              transform: "none",
              width: handleSize,
              height: handleSize,
              borderRadius: "50%",
              border: "2px solid var(--xy-node-handle-border)",
              background: "var(--xy-node-handle-bg)",
              color: "var(--xy-node-handle-color)",
              display: "grid",
              placeItems: "center",
              fontSize: 18,
              fontWeight: 700,
              lineHeight: "20px"
            }}
          >
            +
          </Handle>
        </Box>
      ))}

      <Stack spacing={0.75} sx={{ pl: node.inputs.length ? 9 : 0, pr: node.outputs.length ? 9 : 0 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Box sx={{ width: 10, height: 10, borderRadius: "50%", bgcolor: borderColor, flexShrink: 0 }} />
          <Typography variant="subtitle2" sx={{ fontWeight: 700, minWidth: 0 }} noWrap title={node.label}>
            {node.label}
          </Typography>
          {status === "failed" && <ErrorOutlineIcon color="error" fontSize="small" />}
        </Stack>
        <Typography variant="caption" color="text.secondary" noWrap title={node.toolConfig.bin}>
          {node.type === "fileInput" ? "file picker" : node.toolConfig.bin || "command"}
        </Typography>
      </Stack>
    </Box>
  );
}
