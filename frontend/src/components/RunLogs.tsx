import { memo, useEffect, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { Socket } from "socket.io-client";
import { api, downloadRelativeFile } from "../api/client";
import type { RunStep } from "../types/domain";

interface LogWindow {
  log: string; startCursor: number; nextCursor: number; totalBytes: number; hasMore: boolean; logPath?: string; truncated?: boolean;
}

export function boundedLog(text: string) {
  const bounded = text.slice(-262144); // <= 1 MiB even for four-byte code points
  const lines = bounded.split("\n");
  return lines.length > 2000 ? lines.slice(-2000).join("\n") : bounded;
}

export default memo(function RunLogs({ runId, itemId, step, socket, connected }: {
  runId: string; itemId?: string; step: RunStep; socket: Socket | null; connected: boolean;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [following, setFollowing] = useState(true);
  const [start, setStart] = useState(0);
  const [path, setPath] = useState(step.logPath);
  const [loading, setLoading] = useState(false);
  const viewport = useRef<HTMLPreElement>(null);
  const cursor = useRef<number>();
  const shownText = useRef("");
  const shownStart = useRef(0);
  const dirty = useRef(true);
  const key = `${runId}:${itemId || ""}:${step.nodeId}:${step.attemptId || "legacy"}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const params = { itemId, nodeId: step.nodeId, attemptId: step.attemptId };

  useEffect(() => {
    setText(""); setError(""); setStart(0); setPath(step.logPath); setPaused(false); setFollowing(true);
    cursor.current = undefined;
    shownText.current = ""; shownStart.current = 0; setLoading(false);
  }, [key]);

  useEffect(() => { dirty.current = true; }, [step.status, step.logPath]);

  useEffect(() => {
    if (paused) return;
    let disposed = false;
    let inFlight = false;
    let lastRead = 0;
    const abort = new AbortController();
    // Start from a bounded tail after reconnect/resume, then use byte cursors.
    cursor.current = undefined;
    dirty.current = true;
    const markDirty = () => { dirty.current = true; };
    const watch = () => {
      if (document.hidden) { socket?.emit("log:unwatch"); return; }
      if (itemId && step.attemptId) socket?.emit("log:watch", { runId, ...params }, markDirty);
      markDirty();
    };
    const read = async () => {
      if (disposed || inFlight || document.hidden || (!dirty.current && (connected || Date.now() - lastRead < 5000))) return;
      inFlight = true; dirty.current = false; lastRead = Date.now();
      try {
        const from = cursor.current;
        const response = await api.get<{ logs: LogWindow[] }>(`/runs/${runId}/logs`, {
          params: { ...params, cursor: from }, signal: abort.signal
        });
        if (disposed) return;
        const window = response.data.logs[0];
        if (!window) return;
        cursor.current = window.nextCursor;
        const reset = from === undefined || window.startCursor > from;
        const combined = (reset ? "" : shownText.current) + window.log;
        const next = boundedLog(combined);
        shownStart.current = (reset ? window.startCursor : shownStart.current) +
          new TextEncoder().encode(combined.slice(0, combined.length - next.length)).length;
        shownText.current = next;
        setText(next); setStart(shownStart.current);
        setPath(window.logPath);
        setError(window.truncated ? "Log output exceeded the live window. Download the full log for complete output." : "");
        // At EOF an incomplete UTF-8 character can briefly remain on disk.
        dirty.current ||= window.hasMore;
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : "Unable to load logs");
      } finally { inFlight = false; }
    };
    socket?.on("log:changed", markDirty);
    socket?.on("connect", watch);
    document.addEventListener("visibilitychange", watch);
    watch();
    void read();
    const timer = window.setInterval(() => void read(), 250);
    return () => {
      disposed = true; abort.abort(); window.clearInterval(timer);
      socket?.off("log:changed", markDirty); socket?.off("connect", watch); socket?.emit("log:unwatch");
      document.removeEventListener("visibilitychange", watch);
    };
  }, [key, paused, socket, connected]);

  useEffect(() => {
    if (following && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [text, following]);

  const older = async () => {
    const requestKey = key;
    setPaused(true); setLoading(true);
    try {
      const response = await api.get<{ logs: LogWindow[] }>(`/runs/${runId}/logs`, { params: { ...params, before: start } });
      if (currentKey.current !== requestKey) return;
      const window = response.data.logs[0];
      if (window) {
        const next = boundedLog(window.log);
        shownText.current = next;
        shownStart.current = window.startCursor + new TextEncoder().encode(window.log.slice(0, window.log.length - next.length)).length;
        setText(next); setStart(shownStart.current); setFollowing(false);
      }
    } catch (failure) { if (currentKey.current === requestKey) setError(failure instanceof Error ? failure.message : "Unable to load earlier logs"); }
    finally { if (currentKey.current === requestKey) setLoading(false); }
  };

  return <Stack spacing={1.25}>
    <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
      <Typography variant="subtitle2" sx={{ flex: "1 0 100px" }}>Step logs</Typography>
      <Chip size="small" variant="outlined" label={paused ? "Paused" : connected ? "Live" : "Reconnecting"} />
      <Button size="small" disabled={!start || loading} onClick={() => void older()}>Earlier</Button>
      <Button size="small" onClick={() => { setPaused(!paused); if (paused) setFollowing(true); }}>{paused ? "Resume live" : "Pause"}</Button>
      <Button size="small" onClick={() => setFollowing(!following)}>{following ? "Auto-scroll on" : "Auto-scroll off"}</Button>
      <Button size="small" disabled={!text} onClick={() => void navigator.clipboard.writeText(text).catch(() => setError("Unable to copy logs to clipboard"))}>Copy</Button>
      <Button size="small" disabled={!path} onClick={() => path && void downloadRelativeFile(path)}>Download full log</Button>
    </Stack>
    {error && <Alert severity="warning">{error}</Alert>}
    <Box component="pre" ref={viewport} role="log" aria-label="Step logs" aria-live="off" onScroll={() => {
      const element = viewport.current;
      if (element) setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 32);
    }} sx={{ m: 0, p: 2, height: { xs: 300, lg: 380 }, overflow: "auto", borderRadius: 1.5,
      bgcolor: "#0d1522", color: "#d4deee", border: "1px solid #243149", font: "12px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace",
      whiteSpace: "pre", tabSize: 2, contain: "content" }}>
      {text || (paused ? "Log updates paused." : "Waiting for log output…")}
    </Box>
    <Typography variant="caption" color="text.secondary">Showing up to 2,000 recent lines. Download the full log for complete output.</Typography>
  </Stack>;
});
