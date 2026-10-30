import { memo, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { FilePreview } from "./FilePreview";
import { downloadRelativeFile } from "../api/client";
import type { RunInputValue, StoredFile } from "../types/domain";
import { readableBytes } from "../utils/status";

function FileRow({ file }: { file: StoredFile }) {
  const [open, setOpen] = useState(false);
  return <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1.5, overflow: "hidden" }}>
    <Stack direction="row" alignItems="center" spacing={1} sx={{ p: 1.5 }}>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="body2" fontWeight={600} noWrap title={file.relativePath}>{file.originalName || file.name}</Typography>
        <Typography variant="caption" color="text.secondary">{readableBytes(file.size) || "File"}</Typography>
      </Box>
      {file.preview && <Button size="small" onClick={() => setOpen(!open)}>{open ? "Close preview" : "Preview"}</Button>}
      <Button size="small" onClick={() => void downloadRelativeFile(file.relativePath)}>Download</Button>
    </Stack>
    {open && <FilePreview file={file} />}
  </Box>;
}

export default memo(function RunFiles({ inputs, values, outputs }: { inputs: StoredFile[]; values: RunInputValue[]; outputs: StoredFile[] }) {
  return <Stack spacing={2}>
    <Typography variant="subtitle1" fontWeight={700}>Inputs</Typography>
    {values.map((value) => <Box key={value.name} sx={{ p: 1.5, bgcolor: "action.hover", borderRadius: 1 }}>
      <Typography variant="caption" color="text.secondary">{value.name}</Typography>
      <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{value.value}</Typography>
    </Box>)}
    {inputs.map((file) => <FileRow key={file.relativePath} file={file} />)}
    {!inputs.length && !values.length && <Typography color="text.secondary">No recorded inputs.</Typography>}
    <Typography variant="subtitle1" fontWeight={700}>Outputs · {outputs.length}</Typography>
    {outputs.map((file) => <FileRow key={file.relativePath} file={file} />)}
    {!outputs.length && <Typography color="text.secondary">Outputs appear here as steps complete.</Typography>}
  </Stack>;
});
