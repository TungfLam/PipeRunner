// Reproducible UI comparison against the pre-change committed frontend. Uses
// synthetic logs and an isolated server; never launches tools or touches MongoDB.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { chromium } from "@playwright/test";

const root = process.cwd();
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "piperunner-performance-"));
const artifacts = path.join(root, ".cache", "qa");
await fs.mkdir(artifacts, { recursive: true });
const basePort = Number(process.env.PERF_PORT || 4018);
const api = `http://127.0.0.1:${basePort}`;
const runId = "000000000000000000000001";
const workflowId = "000000000000000000000002";
const initial = ("Previous log output: xin chào 🌏 " + "x".repeat(100) + "\n").repeat(1000);
const workflow = { _id: workflowId, projectId: "000000000000000000000003", name: "50 jobs · live log benchmark",
  nodes: Array.from({ length: 3 }, (_, i) => ({ id: `node_${i}`, type: "tool", label: `Processing step ${i + 1}`,
    position: { x: i * 450, y: 100 }, toolConfig: { bin: "processor", args: [], maxConcurrent: 50 },
    inputs: [{ name: "input", type: "file" }], outputs: [{ name: "output", type: "file" }] })),
  edges: [0, 1].map((i) => ({ id: `edge_${i}`, source: `node_${i}`, target: `node_${i + 1}`, sourceHandle: "output", targetHandle: "input" })) };
const steps = workflow.nodes.map((node, i) => ({ nodeId: node.id, label: node.label, status: i ? "await" : "running",
  attemptId: "attempt", startedAt: new Date().toISOString(), command: "processor", args: ["--input", "sample.mp4"] }));
let logs = [], offsets = [], tick = 0, revision = 0;
const makeRun = () => ({ _id: runId, userId: "benchmark", projectId: workflow.projectId, workflowId, status: "running", revision,
  workflowSnapshot: workflow, workingDir: "users/benchmark/project/run", createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
  inputFiles: [], outputFiles: [], steps, items: Array.from({ length: 50 }, (_, i) => ({
    itemId: `item_${String(i + 1).padStart(3, "0")}`, index: i, label: `Media job ${i + 1}.mp4`, status: "running", attemptId: "attempt",
    startedAt: new Date().toISOString(), steps, inputFiles: [], inputValues: [], outputFiles: [] })) });
const app = express(); app.use(cors({ origin: true }));
app.get(`/api/runs/${runId}`, (_, res) => res.json({ run: makeRun() }));
app.get(`/api/workflows/${workflowId}`, (_, res) => res.json({ workflow }));
app.get(`/api/runs/${runId}/logs`, (req, res) => {
  const result = makeRun().items.filter((item) => !req.query.itemId || item.itemId === req.query.itemId).map((item) => {
    const i = item.index;
    const buffer = Buffer.from(logs[i]);
    const cursor = req.query.cursor === undefined ? Math.max(offsets[i], offsets[i] + buffer.length - 262144) : Number(req.query.cursor);
    const position = Math.max(0, cursor - offsets[i]);
    const slice = buffer.subarray(position, position + 262144);
    return { itemId: item.itemId, nodeId: "node_0", label: "Processing step 1", attemptId: "attempt",
      log: slice.toString(), startCursor: offsets[i] + position, nextCursor: offsets[i] + position + slice.length,
      totalBytes: offsets[i] + buffer.length, hasMore: position + slice.length < buffer.length };
  });
  res.json({ logs: result });
});
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
io.on("connection", (socket) => {
  socket.on("run:join", (_, ack) => { socket.join("run"); if (!ack) socket.join("legacy"); ack?.({ joined: true }); });
  socket.on("log:watch", (input, ack) => { socket.join(`log:${input.itemId}`); ack?.({ joined: true }); });
  socket.on("log:unwatch", () => { for (const room of socket.rooms) if (room.startsWith("log:")) socket.leave(room); });
});
const clients = [];
let browser, timer;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function build(source, output) {
  const child = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build", source, "--outDir", output, "--emptyOutDir"], {
    cwd: root, env: { ...process.env, VITE_API_URL: api }, stdio: "inherit" });
  const [code] = await once(child, "exit"); assert.equal(code, 0);
}
async function preview(source, output, port) {
  const child = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "preview", source, "--outDir", output,
    "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: "ignore" });
  clients.push(child);
  for (let i = 0; i < 100; i++) { if (await fetch(`http://127.0.0.1:${port}`).then((r) => r.ok).catch(() => false)) return; await pause(100); }
  throw new Error("Preview startup failed");
}
async function measure(port, name) {
  logs = Array.from({ length: 50 }, () => initial); offsets = Array(50).fill(0); tick = 0; revision = 0;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => { localStorage.setItem("workflow-auth-token", "benchmark"); localStorage.setItem("workflow-auth-user", JSON.stringify({ id: "benchmark", username: "benchmark" })); });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable"); await cdp.send("Network.enable");
  let requests = 0, logRequests = 0, transferred = 0;
  cdp.on("Network.requestWillBeSent", ({ request }) => { if (request.url.includes("/api/")) { requests++; if (request.url.includes("/logs")) logRequests++; } });
  cdp.on("Network.loadingFinished", ({ encodedDataLength }) => transferred += encodedDataLength);
  await page.goto(`http://127.0.0.1:${port}/runs/${runId}`);
  await page.getByRole("button", { name: "Refresh", exact: true }).waitFor();
  await pause(3000);
  await cdp.send("HeapProfiler.collectGarbage");
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const before = await metrics(); const serverCpu = process.cpuUsage(); const started = Date.now();
  requests = 0; logRequests = 0; transferred = 0;
  await page.evaluate(() => {
    window.qaLogUpdates = 0;
    const log = document.querySelector('[role="log"]');
    if (log) new MutationObserver(() => window.qaLogUpdates++).observe(log, { subtree: true, childList: true, characterData: true });
  });
  await pause(10000);
  const after = await metrics(); const elapsedMs = Date.now() - started;
  const cpu = process.cpuUsage(serverCpu);
  await cdp.send("HeapProfiler.collectGarbage"); const collected = await metrics();
  const result = { name, elapsedMs, rendererCpuPercent: (after.TaskDuration - before.TaskDuration) / (elapsedMs / 1000) * 100,
    scriptSeconds: after.ScriptDuration - before.ScriptDuration, layoutSeconds: after.LayoutDuration - before.LayoutDuration,
    heapAfterGcMiB: collected.JSHeapUsedSize / 1048576,
    mockServerCpuPercent: (cpu.user + cpu.system) / (elapsedMs * 1000) * 100,
    apiRequests: requests, logRequests, transferredMiB: transferred / 1048576,
    logUpdates: await page.evaluate(() => window.qaLogUpdates || 0),
    visibleJobRows: await page.getByTestId("job-row").count(), errors };
  await page.screenshot({ path: path.join(artifacts, `performance-${name}.png`) });
  await context.close(); return result;
}

try {
  const archive = execFileSync("git", ["archive", "HEAD", "frontend"], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  const baselineDirectory = path.join(temp, "baseline"); await fs.mkdir(baselineDirectory);
  execFileSync("tar", ["-x", "-C", baselineDirectory], { input: archive });
  await fs.symlink(path.join(root, "node_modules"), path.join(baselineDirectory, "node_modules"));
  const oldSource = path.join(baselineDirectory, "frontend"), oldOutput = path.join(temp, "old-web"), newOutput = path.join(temp, "new-web");
  await build(oldSource, oldOutput); await build(path.join(root, "frontend"), newOutput);
  await preview(oldSource, oldOutput, 5187); await preview(path.join(root, "frontend"), newOutput, 5188);
  await new Promise((resolve) => server.listen(basePort, "127.0.0.1", resolve));
  timer = setInterval(() => {
    if (!logs.length) return;
    tick++;
    for (let i = 0; i < 50; i++) {
      const message = `chunk ${tick} job ${i + 1}: ${"x".repeat(180)}\n`;
      logs[i] += message;
      if (logs[i].length > 500000) { const cut = logs[i].length - 400000; offsets[i] += Buffer.byteLength(logs[i].slice(0, cut)); logs[i] = logs[i].slice(cut); }
      const itemId = `item_${String(i + 1).padStart(3, "0")}`;
      io.to("legacy").emit("step:log", { itemId, nodeId: "node_0", message });
      if (tick % 5 === 0) io.to(`log:${itemId}`).emit("log:changed", { runId, itemId, nodeId: "node_0", attemptId: "attempt" });
    }
    if (tick % 20 === 0) {
      revision++;
      io.to("run").emit("step:status", { itemId: "item_001", nodeId: "node_0", status: "running" });
      io.to("run").emit("run:patch", { revision, run: { status: "running" }, items: [makeRun().items[0]], steps });
    }
  }, 50);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined), headless: true, args: ["--no-sandbox"] });
  const baseline = await measure(5187, "baseline");
  const updated = await measure(5188, "updated");
  const reductionPercent = (1 - updated.rendererCpuPercent / baseline.rendererCpuPercent) * 100;
  const report = { fixture: "50 jobs, 20 log chunks/job/second, status event each second, production builds, 10-second sample after warmup",
    baseline, updated, rendererCpuReductionPercent: reductionPercent };
  await fs.writeFile(path.join(artifacts, "performance.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(updated.errors, []); assert.ok(updated.visibleJobRows < 15);
  assert.ok(updated.logUpdates <= 44, "log updates are batched at approximately 4 Hz");
  assert.ok(reductionPercent >= 50, `Renderer CPU improvement ${reductionPercent.toFixed(1)}% is below target`);
} finally {
  clearInterval(timer); await browser?.close(); for (const child of clients) child.kill("SIGTERM");
  await new Promise((resolve) => io.close(resolve)); server.close();
}
