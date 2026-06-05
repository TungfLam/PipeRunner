import DownloadIcon from "@mui/icons-material/Download";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";
import { api, downloadRelativeFile } from "../api/client";
import type { StoredFile } from "../types/domain";
import { readableBytes } from "../utils/status";

interface Props {
  file: StoredFile;
}

export function FilePreview({ file }: Props) {
  const [text, setText] = useState("");
  const [objectUrl, setObjectUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let url = "";

    async function loadPreview() {
      setLoading(true);
      setError("");
      setText("");
      setObjectUrl("");
      try {
        if (file.preview === "text" || file.preview === "json") {
          const response = await api.get("/files/preview", {
            params: { path: file.relativePath },
            responseType: "text"
          });
          if (cancelled) return;
          const value = String(response.data);
          setText(file.preview === "json" ? JSON.stringify(JSON.parse(value), null, 2) : value);
          return;
        }
        if (file.preview) {
          const response = await api.get("/files/preview", {
            params: { path: file.relativePath },
            responseType: "blob"
          });
          if (cancelled) return;
          url = URL.createObjectURL(response.data);
          setObjectUrl(url);
        }
      } catch (previewError) {
        if (!cancelled) {
          setError(previewError instanceof Error ? previewError.message : "Preview failed");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadPreview();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.relativePath, file.preview]);

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 1.5, bgcolor: "background.paper" }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }} noWrap title={file.relativePath}>
          {file.name}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {readableBytes(file.size)}
        </Typography>
        <Button size="small" startIcon={<DownloadIcon />} onClick={() => downloadRelativeFile(file.relativePath)}>
          Download
        </Button>
      </Stack>
      {loading && <CircularProgress size={20} />}
      {error && (
        <Typography variant="body2" color="error">
          {error}
        </Typography>
      )}
      {text && (
        <Box
          component="pre"
          sx={{
            m: 0,
            maxHeight: 260,
            overflow: "auto",
            fontSize: 12,
            bgcolor: (theme) => (theme.palette.mode === "dark" ? "#0b0f14" : "#f8fafc"),
            color: "text.primary",
            border: "1px solid",
            borderColor: "divider",
            p: 1.25,
            borderRadius: 1
          }}
        >
          {text}
        </Box>
      )}
      {objectUrl && file.preview === "image" && (
        <Box component="img" src={objectUrl} alt={file.name} sx={{ maxWidth: "100%", maxHeight: 360 }} />
      )}
      {objectUrl && file.preview === "video" && (
        <Box component="video" src={objectUrl} controls sx={{ width: "100%", maxHeight: 360 }} />
      )}
      {objectUrl && file.preview === "audio" && <Box component="audio" src={objectUrl} controls sx={{ width: "100%" }} />}
    </Box>
  );
}
