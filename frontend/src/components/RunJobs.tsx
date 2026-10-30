import { memo, useEffect, useMemo, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { WorkflowRunItem } from "../types/domain";
import { statusColor } from "../utils/status";

const ROW_HEIGHT = 112;

export default memo(function RunJobs({ items, selectedId, checked, pending, onSelect, onChecked, onCancel, onRerun }: {
  items: WorkflowRunItem[]; selectedId?: string; checked: Set<string>; pending: boolean;
  onSelect: (id: string) => void; onChecked: (ids: string[]) => void;
  onCancel: (ids: string[]) => void; onRerun: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(560);
  const viewport = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => items.filter((item) => (!status || item.status === status) &&
    `${item.index + 1} ${item.label}`.toLowerCase().includes(search.toLowerCase())), [items, search, status]);
  const selectedCount = filtered.filter((item) => checked.has(item.itemId)).length;
  const from = Math.max(0, Math.floor(top / ROW_HEIGHT) - 2);
  const visible = filtered.slice(from, from + Math.ceil(height / ROW_HEIGHT) + 5);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setTop(0); if (viewport.current) viewport.current.scrollTop = 0; }, [search, status]);

  return <Stack sx={{ height: "100%" }}>
    <Stack spacing={1.5} sx={{ p: 2, borderBottom: "1px solid", borderColor: "divider" }}>
      <Stack direction="row" alignItems="center"><Typography variant="subtitle1" fontWeight={700} sx={{ flex: 1 }}>Jobs</Typography>
        <Typography variant="caption" color="text.secondary">{filtered.length} / {items.length}</Typography></Stack>
      <TextField size="small" placeholder="Search jobs…" inputProps={{ "aria-label": "Search jobs" }} value={search} onChange={(event) => setSearch(event.target.value)} />
      <Stack direction="row" alignItems="center" spacing={1}>
        <Checkbox size="small" inputProps={{ "aria-label": "Select visible jobs" }} checked={!!filtered.length && selectedCount === filtered.length}
          indeterminate={selectedCount > 0 && selectedCount < filtered.length} disabled={!filtered.length}
          onChange={() => onChecked(selectedCount === filtered.length ? [...checked].filter((id) => !filtered.some((item) => item.itemId === id)) : [...new Set([...checked, ...filtered.map((item) => item.itemId)])])} />
        <TextField select size="small" label="Status" value={status} onChange={(event) => setStatus(event.target.value)} fullWidth>
          <MenuItem value="">All statuses</MenuItem>
          {["await", "running", "success", "failed", "cancelled"].map((value) => <MenuItem key={value} value={value}>{value}</MenuItem>)}
        </TextField>
      </Stack>
    </Stack>
    <Box ref={viewport} onScroll={(event) => setTop(event.currentTarget.scrollTop)} sx={{ height: { xs: 340, lg: "min(680px, calc(100dvh - 340px))" }, minHeight: 300, overflow: "auto", contain: "strict" }}>
      <Box sx={{ height: filtered.length * ROW_HEIGHT, position: "relative" }}>
        {visible.map((item, index) => {
          const active = ["await", "running"].includes(item.status);
          return <Box key={item.itemId} data-testid="job-row" onClick={() => onSelect(item.itemId)} sx={{ position: "absolute", top: (from + index) * ROW_HEIGHT,
            height: ROW_HEIGHT, boxSizing: "border-box", width: "100%", p: 1.25, borderBottom: "1px solid", borderColor: "divider",
            bgcolor: selectedId === item.itemId ? "action.selected" : "transparent", borderLeft: "3px solid", borderLeftColor: selectedId === item.itemId ? "primary.main" : "transparent", cursor: "pointer" }}>
            <Stack direction="row" alignItems="center" spacing={0.75}>
              <Checkbox size="small" checked={checked.has(item.itemId)} inputProps={{ "aria-label": `Select job ${item.index + 1}` }}
                onClick={(event) => event.stopPropagation()} onChange={() => onChecked(checked.has(item.itemId) ? [...checked].filter((id) => id !== item.itemId) : [...checked, item.itemId])} />
              <Typography component="button" aria-label={`View job ${item.index + 1}`} variant="body2" fontWeight={600} noWrap title={item.label}
                sx={{ flex: 1, minWidth: 0, textAlign: "left", cursor: "pointer", border: 0, p: 0, bgcolor: "transparent", color: "inherit" }}>{item.index + 1}. {item.label}</Typography>
              <Chip size="small" label={item.cancelRequestedAt ? "Cancelling" : item.status} sx={{ color: statusColor(item.status), bgcolor: `${statusColor(item.status)}18`, fontWeight: 600 }} />
            </Stack>
            <Stack direction="row" alignItems="center" sx={{ pl: 4.5 }}>
              <Typography variant="caption" color={item.errorMessage ? "error" : "text.secondary"} noWrap title={item.errorMessage || item.waitReason} sx={{ flex: 1 }}>
                {item.errorMessage || item.waitReason || `${item.steps.filter((step) => step.status === "success").length}/${item.steps.length} steps complete`}
              </Typography>
              <Button size="small" color={active ? "error" : "primary"} disabled={pending || !!item.cancelRequestedAt || (!active && !["failed", "cancelled"].includes(item.status))}
                aria-label={`${active ? "Cancel" : "Rerun"} job ${item.index + 1}`} onClick={(event) => { event.stopPropagation(); active ? onCancel([item.itemId]) : onRerun([item.itemId]); }}>
                {active ? "Cancel" : "Rerun"}
              </Button>
            </Stack>
          </Box>;
        })}
      </Box>
      {!filtered.length && <Typography sx={{ p: 3 }} color="text.secondary">No jobs match this filter.</Typography>}
    </Box>
  </Stack>;
});
