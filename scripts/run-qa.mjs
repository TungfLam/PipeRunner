import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { chromium } from "@playwright/test";

const root = process.cwd();
const data = await fs.mkdtemp(path.join(os.tmpdir(), "piperunner-qa-"));
const artifacts = path.join(root, ".cache", "qa");
await fs.mkdir(artifacts, { recursive: true });
const dbName = `piperunner_qa_${Date.now()}`;
const uri = new URL(process.env.QA_MONGODB_URI || "mongodb://127.0.0.1:27017");
uri.pathname = `/${dbName}`;
const port = Number(process.env.QA_PORT || 4017);
const webPort = Number(process.env.QA_WEB_PORT || 5185);
const base = `http://127.0.0.1:${port}`;
const web = `http://127.0.0.1:${webPort}`;
const env = { ...process.env, NODE_ENV: "test", PORT: String(port), MONGODB_URI: uri.toString(),
  JWT_SECRET: "piperunner_qa_secret_only", DATA_ROOT: data, FRONTEND_URL: web, VITE_API_URL: base };
const reports = [];
let backend, frontend, browser;
let serverOutput = "";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await check(); if (result) return result; await delay(100); }
  throw new Error(`Timed out: ${label}\n${serverOutput.slice(-3000)}`);
}
async function command(bin, args, options = {}) {
  const child = spawn(bin, args, { cwd: root, env, stdio: "inherit", ...options });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`${bin} ${args.join(" ")} failed (${code})`);
}
async function startBackend() {
  backend = spawn(process.execPath, ["dist/server.js"], { cwd: path.join(root, "backend"), env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [backend.stdout, backend.stderr]) stream.on("data", (chunk) => { serverOutput = (serverOutput + chunk).slice(-12000); });
  await waitFor(async () => {
    if (backend.exitCode !== null) throw new Error(serverOutput);
    return fetch(`${base}/health`).then((response) => response.ok).catch(() => false);
  }, "backend startup");
}
async function stopBackend(signal = "SIGTERM") {
  if (!backend || backend.exitCode !== null || backend.signalCode) return;
  const exited = once(backend, "exit"); backend.kill(signal); await exited;
}
async function request(route, body, token, method = body === undefined ? "GET" : "POST", expected = 200) {
  const response = await fetch(`${base}/api${route}`, { method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result)}`);
  return result;
}
async function test(name, action) {
  const started = Date.now(); await action(); reports.push({ name, passed: true, durationMs: Date.now() - started }); console.log(`PASS ${name}`);
}
const processGone = async (pid) => {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  return !stat || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
};

try {
  await mongoose.connect(uri.toString());
  await startBackend();
  const auth = await request("/auth/register", { username: `qa_${Date.now()}`, password: "piperunner-test-pass" }, undefined, "POST", 201);
  const stranger = await request("/auth/register", { username: `other_${Date.now()}`, password: "piperunner-test-pass" }, undefined, "POST", 201);
  const token = auth.token;
  const project = (await request("/projects", { name: "Runner QA", description: "Isolated test data" }, token, "POST", 201)).project;
  const events = path.join(data, "events.jsonl");
  const failMarker = path.join(data, "fail-marker");
  const tool = (id, maxConcurrent = 1, canFail = false) => ({ id, type: "tool", label: `Tool ${id}`, position: { x: id === "A" ? 0 : 440, y: 0 },
    toolConfig: { bin: process.execPath, maxConcurrent, args: ["-e", `
      const fs=require('fs'); const [label,input,out,duration]=process.argv.slice(1);
      const record=(event)=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({event,label,pid:process.pid,at:Date.now()})+'\\n');
      record('start'); process.on('SIGTERM',()=>{record('end');process.exit(1)});
      let n=0; const timer=setInterval(()=>process.stdout.write('log '+label+' '+(++n)+' xin chào 🌏\\n'),10);
      setTimeout(()=>{clearInterval(timer);record('end');
        if(${canFail} && fs.existsSync(${JSON.stringify(failMarker)})){console.error('intentional failure');process.exit(2)}
        fs.writeFileSync(out, input+' complete');},Number(duration));
    `, id, "{{inputs.value}}", "{{outputs.result}}", "{{params.delay}}"] },
    inputs: [{ name: "value", type: "text", required: true }], outputs: [{ name: "result", type: "file", extension: "txt", preview: "text" }] });
  const createWorkflow = async (nodes, edges = []) => (await request(`/projects/${project._id}/workflows`, { name: "Batch processing", nodes, edges }, token, "POST", 201)).workflow;
  const workflow = await createWorkflow([tool("A")]);
  const start = async (count, duration = 500, workflowId = workflow._id) => (await request(`/workflows/${workflowId}/runs`, {
    textInputs: { value: Array.from({ length: count }, (_, i) => `input-${i + 1}`) }, params: { delay: duration }
  }, token, "POST", 201)).run;
  const read = async (id) => (await request(`/runs/${id}`, undefined, token)).run;
  const finished = (id) => waitFor(async () => { const run = await read(id); return !["await", "running"].includes(run.status) && run; }, `run ${id} completion`);
  let first;

  await test("Shared concurrency, queued status, individual cancel and duplicate bulk rerun", async () => {
    first = await start(6, 500);
    const second = await start(2, 500);
    await waitFor(async () => (await read(first._id)).items[0].process, "registered child");
    const queued = await read(second._id);
    assert.equal(queued.status, "await");
    assert.ok(queued.items.every((item) => item.status === "await" && !item.startedAt));
    const waitingCancel = await request(`/runs/${first._id}/cancel`, { itemIds: ["item_003"] }, token);
    assert.equal(waitingCancel.run.items[2].status, "cancelled");
    assert.equal(waitingCancel.run.items[0].status, "running");
    const pid = (await read(first._id)).items[0].process.pid;
    const cancelled = await request(`/runs/${first._id}/cancel`, { itemIds: ["item_001"] }, token);
    assert.equal(cancelled.run.items[0].status, "cancelled");
    await waitFor(() => processGone(pid), "cancelled process gone");
    const results = await Promise.all([1, 2].map(() => request(`/runs/${first._id}/rerun`, { itemIds: ["item_001", "item_003"] }, token)));
    assert.equal(results.reduce((sum, result) => sum + result.acceptedItemIds.length, 0), 2);
    const state = await read(first._id);
    assert.equal(state.items[0].status, "await");
    assert.equal(state.items[0].startedAt, undefined);
    assert.equal((await finished(first._id)).status, "success");
    assert.equal((await finished(second._id)).status, "success");
    const records = (await fs.readFile(events, "utf8")).trim().split("\n").map(JSON.parse);
    const running = new Set(); let maximum = 0;
    for (const event of records) { event.event === "start" ? running.add(event.pid) : running.delete(event.pid); maximum = Math.max(maximum, running.size); }
    assert.equal(maximum, 1);
  });

  await test("Live concurrency updates and cancel all", async () => {
    const run = await start(8, 2000);
    await waitFor(async () => (await read(run._id)).items.some((item) => item.process), "first running");
    await request(`/workflows/${workflow._id}`, { nodes: [tool("A", 2)] }, token, "PATCH");
    await waitFor(async () => (await read(run._id)).items.filter((item) => item.status === "running").length === 2, "limit increased to two");
    await request(`/workflows/${workflow._id}`, { nodes: [tool("A", 1)] }, token, "PATCH");
    const result = await request(`/runs/${run._id}/cancel`, {}, token);
    assert.equal(result.run.status, "cancelled"); assert.ok(result.run.items.every((item) => item.status === "cancelled"));
    assert.ok(result.run.items.every((item) => !item.process));
    await request(`/runs/${run._id}/cancel`, { itemIds: [] }, token, "POST", 400);
    await request(`/runs/${run._id}`, undefined, stranger.token, "GET", 404);
    await request(`/runs/${run._id}/cancel`, {}, stranger.token, "POST", 404);
    await request(`/runs/${run._id}/logs?itemId=item_001&nodeId=A`, undefined, stranger.token, "GET", 404);
  });

  await test("Resume uses saved workflow and previous outputs; logs are isolated per attempt", async () => {
    const flow = await createWorkflow([tool("A"), tool("B", 1, true)], [{ id: "ab", source: "A", target: "B", sourceHandle: "result", targetHandle: "value" }]);
    await fs.writeFile(failMarker, "fail");
    const run = await start(1, 150, flow._id);
    const failed = await finished(run._id);
    assert.equal(failed.status, "failed");
    const firstStep = failed.items[0].steps[0];
    const oldLog = failed.items[0].steps[1].logPath;
    await fs.unlink(failMarker);
    const changed = [tool("A"), tool("B", 1, true)].map((node) => ({ ...node, toolConfig: { ...node.toolConfig, bin: "/missing-new-workflow-command" } }));
    await request(`/workflows/${flow._id}`, { nodes: changed }, token, "PATCH");
    const accepted = await request(`/runs/${run._id}/rerun`, {}, token);
    assert.equal(accepted.acceptedItemIds.length, 1);
    const success = await finished(run._id);
    assert.equal(success.status, "success");
    assert.deepEqual(success.items[0].steps[0], firstStep);
    assert.notEqual(success.items[0].steps[1].logPath, oldLog);
    assert.equal(success.items[0].outputFiles.length, 2);
    const result = await request(`/runs/${run._id}/logs?itemId=item_001&nodeId=B&attemptId=${success.items[0].steps[1].attemptId}`, undefined, token);
    assert.ok(!result.logs[0].log.includes("\nintentional failure\n"));
    await request(`/runs/${run._id}/logs?itemId=item_001&nodeId=B&attemptId=${failed.items[0].steps[1].attemptId}`, undefined, token, "GET", 409);
    // A large log should remain readable, rather than silently returning empty.
    const absolute = path.join(data, success.items[0].steps[1].logPath);
    await fs.appendFile(absolute, "xin chào 🌏\n".repeat(500000));
    const large = (await request(`/runs/${run._id}/logs?itemId=item_001&nodeId=B`, undefined, token)).logs[0];
    assert.ok(Buffer.byteLength(large.log) <= 262144); assert.ok(large.startCursor > 0); assert.ok(!large.log.includes("�"));
    const incremental = (await request(`/runs/${run._id}/logs?itemId=item_001&nodeId=B&cursor=${large.nextCursor}`, undefined, token)).logs[0];
    assert.equal(incremental.log, "");
  });

  await test("Missing previous outputs reject rerun without changing job state", async () => {
    const flow = await createWorkflow([tool("A"), tool("B", 1, true)], [{ id: "ab", source: "A", target: "B", sourceHandle: "result", targetHandle: "value" }]);
    await fs.writeFile(failMarker, "fail");
    const run = await start(1, 50, flow._id);
    const failed = await finished(run._id);
    await fs.unlink(path.join(data, failed.items[0].steps[0].outputs.result));
    const rejected = await request(`/runs/${run._id}/rerun`, {}, token);
    assert.equal(rejected.acceptedItemIds.length, 0);
    assert.match(rejected.skipped[0].reason, /ENOENT/);
    assert.equal(rejected.run.status, "failed");
    await fs.unlink(failMarker);
  });

  await test("Timeout retains its slot until process group cleanup finishes", async () => {
    const node = tool("A"); node.toolConfig.timeoutSeconds = 0.1;
    const flow = await createWorkflow([node]);
    const run = await start(2, 2000, flow._id);
    await waitFor(async () => (await read(run._id)).items[0].process, "timed command registered");
    await delay(500);
    const duringCleanup = await read(run._id);
    assert.equal(duringCleanup.items[1].status, "await");
    const failed = await finished(run._id);
    assert.ok(failed.items.every((item) => item.status === "failed" && item.steps[0].errorMessage.includes("timed out")));
  });

  await test("SIGKILL recovery stops orphan processes and enables bulk rerun", async () => {
    const run = await start(4, 500);
    const identity = await waitFor(async () => (await read(run._id)).items.find((item) => item.process)?.process, "crash process registered");
    await stopBackend("SIGKILL");
    await waitFor(() => processGone(identity.pid), "parent-death watchdog");
    await startBackend();
    const recovered = await read(run._id);
    assert.equal(recovered.status, "cancelled");
    assert.ok(recovered.items.every((item) => item.status === "cancelled"));
    assert.ok(recovered.items.every((item) => item.steps.every((step) => step.status === "cancelled")));
    assert.equal((await request(`/runs/${run._id}/rerun`, {}, token)).acceptedItemIds.length, 4);
    assert.equal((await finished(run._id)).status, "success");
  });

  await test("Legacy pending/waiting documents are cancelled on startup and rerunnable", async () => {
    const source = await read(first._id);
    const legacyId = new mongoose.Types.ObjectId();
    const legacyRoot = `${source.workingDir}_legacy`;
    await fs.cp(path.join(data, source.workingDir), path.join(data, legacyRoot), { recursive: true });
    const item = JSON.parse(JSON.stringify(source.items[0]).replaceAll(source.workingDir, legacyRoot));
    item.status = "pending"; delete item.finishedAt; delete item.attemptId;
    item.steps = item.steps.map((step) => ({ nodeId: step.nodeId, label: step.label, status: "waiting" }));
    await mongoose.connection.collection("runs").insertOne({ ...source, _id: legacyId, userId: new mongoose.Types.ObjectId(auth.user.id),
      projectId: new mongoose.Types.ObjectId(project._id), workflowId: new mongoose.Types.ObjectId(workflow._id),
      workflowSnapshot: undefined, workingDir: legacyRoot, items: [item], steps: item.steps, status: "running" });
    await stopBackend(); await startBackend();
    const recovered = await read(String(legacyId));
    assert.equal(recovered.items[0].status, "cancelled");
    assert.equal(recovered.items[0].steps[0].status, "cancelled");
    assert.equal((await request(`/runs/${legacyId}/rerun`, {}, token)).acceptedItemIds.length, 1);
    assert.equal((await finished(String(legacyId))).status, "success");
  });

  await command(process.execPath, ["node_modules/vite/bin/vite.js", "build", "frontend", "--outDir", path.join(data, "web"), "--emptyOutDir"], { env: { ...env, NODE_ENV: "production" } });
  frontend = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "frontend", "--outDir", path.join(data, "web"), "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], { cwd: root, env, stdio: "ignore" });
  await waitFor(() => fetch(web).then((response) => response.ok).catch(() => false), "frontend");
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem("workflow-auth-token", token); localStorage.setItem("workflow-auth-user", JSON.stringify(user));
  }, auth);
  const page = await context.newPage();
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));

  await test("Browser: individual/bulk actions, virtual jobs, lazy graph/files and mobile themes", async () => {
    const run = await start(50, 5000);
    const previews = []; page.on("request", (request) => { if (request.url().includes("/files/preview")) previews.push(request.url()); });
    await page.goto(`${web}/runs/${run._id}`);
    await page.getByText("Live updates", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Cancel job 1", exact: true }).waitFor();
    assert.ok(await page.getByTestId("job-row").count() < 15, "only visible jobs are mounted");
    assert.equal(await page.locator(".react-flow").count(), 0);
    assert.equal(previews.length, 0);
    await page.screenshot({ path: path.join(artifacts, "run-desktop.png"), fullPage: true });
    await page.getByRole("checkbox", { name: "Select job 1", exact: true }).check();
    await page.getByRole("checkbox", { name: "Select job 2", exact: true }).check();
    await page.getByRole("button", { name: "Cancel selected (2)", exact: true }).click();
    await page.getByText("Cancelled: 2 job(s).", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Rerun selected (2)", exact: true }).click();
    await page.getByText("Queued for rerun: 2 job(s).", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Workflow", exact: true }).click();
    await page.locator(".react-flow").waitFor();
    assert.equal(await page.locator(".tool-node-running").count(), 0);
    await page.getByRole("button", { name: "Cancel all", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel all", exact: true }).click();
    await page.getByText(/Cancelled: \d+ job\(s\)\./).waitFor();
    await page.goto(`${web}/runs/${first._id}`);
    await page.getByRole("tab", { name: /Files/ }).click();
    assert.equal(previews.length, 0);
    await page.getByRole("button", { name: "Preview", exact: true }).first().click();
    await waitFor(() => previews.length === 1, "explicit preview");
    await page.getByRole("tab", { name: "Steps & Logs", exact: true }).click();
    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    await page.screenshot({ path: path.join(artifacts, "run-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.mouse.move(380, 800);
    await page.screenshot({ path: path.join(artifacts, "run-mobile.png") });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "mobile has no page overflow");
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await test("Browser reconnect after backend crash and rerun", async () => {
    const run = await start(3, 500);
    await page.goto(`${web}/runs/${run._id}`);
    await page.getByText("Live updates", { exact: true }).waitFor();
    await waitFor(async () => (await read(run._id)).items.some((item) => item.process), "browser running job");
    await stopBackend("SIGKILL");
    await startBackend();
    await page.getByText("Live updates", { exact: true }).waitFor();
    const button = page.getByRole("button", { name: "Rerun failed / cancelled", exact: true });
    await waitFor(() => button.isEnabled(), "rerun enabled after reconnect");
    await button.click();
    await page.getByText(/Queued for rerun: [1-3] job\(s\)\./).waitFor();
    assert.equal((await finished(run._id)).status, "success");
  });
  await test("Graceful shutdown marks active and queued jobs cancelled", async () => {
    const run = await start(3, 5000);
    await waitFor(async () => (await read(run._id)).items.some((item) => item.process), "graceful shutdown running job");
    await stopBackend();
    const stored = await mongoose.connection.collection("runs").findOne({ _id: new mongoose.Types.ObjectId(run._id) });
    assert.equal(stored.status, "cancelled");
    assert.ok(stored.items.every((item) => item.status === "cancelled"));
  });
  assert.deepEqual(errors, [], "no browser runtime errors");
  await fs.writeFile(path.join(artifacts, "report.json"), JSON.stringify({ passed: true, tests: reports, dataRoot: data }, null, 2));
  console.log(`QA passed. Artifacts: ${artifacts}`);
} catch (error) {
  await fs.writeFile(path.join(artifacts, "report.json"), JSON.stringify({ passed: false, tests: reports, error: String(error), serverOutput }, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  await browser?.close(); frontend?.kill("SIGTERM");
  await stopBackend();
  if (mongoose.connection.readyState === 1) { assert.ok(dbName.startsWith("piperunner_qa_")); await mongoose.connection.dropDatabase(); }
  await mongoose.disconnect();
}
