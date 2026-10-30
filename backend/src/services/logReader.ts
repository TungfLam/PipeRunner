import fs from "fs/promises";

/** Bounded byte cursors, aligned to UTF-8 boundaries even across read windows. */
export async function readLogWindow(absolutePath: string, options: { cursor?: number; before?: number; limit?: number; complete?: boolean } = {}) {
  const limit = Math.min(256 * 1024, Math.max(1, options.limit || 256 * 1024));
  const handle = await fs.open(absolutePath, "r").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return { log: "", startCursor: 0, nextCursor: 0, totalBytes: 0, hasMore: false };
  try {
    const { size } = await handle.stat();
    const end = Math.min(size, options.before ?? size);
    let start = options.cursor === undefined ? Math.max(0, end - limit) : Math.min(options.cursor, end);
    const truncated = options.cursor !== undefined && end - start > 1024 * 1024;
    if (truncated) start = Math.max(0, end - limit);
    const buffer = Buffer.alloc(Math.min(limit, end - start));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let first = 0;
    while (first < bytesRead && (buffer[first] & 0xc0) === 0x80) first++;
    let last = bytesRead;
    let lead = last - 1;
    while (lead >= first && (buffer[lead] & 0xc0) === 0x80) lead--;
    if (lead >= first) {
      const byte = buffer[lead];
      const length = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
      if (lead + length > last && !(options.complete && start + bytesRead === size)) last = lead;
    }
    start += first;
    const nextCursor = start + Math.max(0, last - first);
    return { log: buffer.subarray(first, last).toString("utf8"), startCursor: start, nextCursor,
      totalBytes: size, hasMore: nextCursor < end, truncated };
  } finally { await handle.close(); }
}
