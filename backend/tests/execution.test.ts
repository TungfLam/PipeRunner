import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionScheduler } from "../src/services/executionScheduler";
import { aggregateStatus, recoverRun } from "../src/services/runState";
import { readLogWindow } from "../src/services/logReader";
import { runSupervisedCommand } from "../src/services/processRunner";
import type { RunItem } from "../src/types/domain";

test("FIFO transfers slots without oversubscription, removes aborted waiters and updates limits", async () => {
  const scheduler = new ExecutionScheduler();
  const controller = new AbortController();
  scheduler.setLimit("tool", 1);
  const release = await scheduler.acquire("tool", controller.signal);
  const cancelled = new AbortController();
  const waiter = scheduler.acquire("tool", cancelled.signal);
  const second = scheduler.acquire("tool", controller.signal);
  cancelled.abort(new Error("cancel"));
  await assert.rejects(waiter, /cancel/);
  release();
  let granted = false;
  const third = scheduler.acquire("tool", controller.signal).then((release) => { granted = true; return release; });
  const releaseSecond = await second;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(granted, false);
  scheduler.setLimit("tool", 2);
  const releaseThird = await third;
  scheduler.setLimit("tool", 1);
  let fourthGranted = false;
  const fourth = scheduler.acquire("tool", controller.signal).then((release) => { fourthGranted = true; return release; });
  releaseSecond(); releaseSecond();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fourthGranted, false);
  releaseThird(); (await fourth)();
});

test("aggregation prioritizes live work and crash recovery preserves successful steps", () => {
  assert.equal(aggregateStatus(["failed", "running"]), "running");
  assert.equal(aggregateStatus(["cancelled", "await"]), "await");
  assert.equal(aggregateStatus(["cancelled", "failed"]), "failed");
  const item: RunItem = { itemId: "a", index: 0, label: "A", status: "running", steps: [
    { nodeId: "a", label: "A", status: "success", outputs: { file: "saved" } },
    { nodeId: "b", label: "B", status: "running" }, { nodeId: "c", label: "C", status: "await" }
  ] };
  const run = recoverRun({ status: "running", items: [item] });
  assert.equal(run.status, "cancelled");
  assert.deepEqual(run.items?.[0].steps.map((step) => step.status), ["success", "cancelled", "cancelled"]);
  assert.equal(run.items?.[0].steps[0].outputs?.file, "saved");
  const once = JSON.stringify(run);
  assert.equal(JSON.stringify(recoverRun(run)), once);
});

test("log windows have bounded cursors and preserve split UTF-8 characters", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piperunner-logs-"));
  const file = path.join(dir, "log");
  try {
    const content = "xin chào 🌏\n".repeat(100000);
    await fs.writeFile(file, content);
    const tail = await readLogWindow(file);
    assert.ok(Buffer.byteLength(tail.log) <= 256 * 1024);
    assert.ok(!tail.log.includes("�"));
    assert.equal(tail.nextCursor, Buffer.byteLength(content));
    const older = await readLogWindow(file, { before: tail.startCursor });
    assert.equal(older.nextCursor, tail.startCursor);
    await fs.writeFile(file, Buffer.from([0x61, 0xf0, 0x9f]));
    const partial = await readLogWindow(file, { cursor: 0 });
    assert.equal(partial.log, "a"); assert.equal(partial.nextCursor, 1);
    const complete = await readLogWindow(file, { cursor: 0, complete: true });
    assert.equal(complete.nextCursor, 3); assert.equal(complete.hasMore, false);
    await fs.appendFile(file, Buffer.from([0x8c, 0x8f]));
    assert.equal((await readLogWindow(file, { cursor: 1 })).log, "🌏");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("supervisor registers before executing, handles spawn failures, timeout and abort", { timeout: 15000 }, async () => {
  let registered = false;
  let output = "";
  const common = { cwd: process.cwd(), env: {}, signal: new AbortController().signal,
    register: async () => { registered = true; }, log: (chunk: Buffer) => { assert.ok(registered); output += chunk.toString(); return true; }, onDrain: () => undefined };
  await runSupervisedCommand({ ...common, bin: process.execPath, args: ["-e", "console.log('ready')"] });
  assert.match(output, /ready/);
  await assert.rejects(runSupervisedCommand({ ...common, bin: "/missing-command", args: [] }), /Command exited/);
  await assert.rejects(runSupervisedCommand({ ...common, bin: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutSeconds: 0.1 }), /timed out/);
  const abort = new AbortController();
  const running = runSupervisedCommand({ ...common, signal: abort.signal, bin: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
  setTimeout(() => abort.abort(new Error("cancelled")), 100);
  await assert.rejects(running, /cancelled/);
});

test("cancellation force-kills a command and grandchild which both ignore SIGTERM", { timeout: 10000 }, async () => {
  const controller = new AbortController();
  let output = "";
  const code = `
    const {spawn}=require('child_process');
    process.on('SIGTERM',()=>{});
    console.log('parent:'+process.pid);
    spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('grandchild:'+process.pid);setInterval(()=>{},1000)"],{stdio:'inherit'});
    setInterval(()=>{},1000);
  `;
  const started = Date.now();
  await assert.rejects(runSupervisedCommand({ bin: process.execPath, args: ["-e", code], cwd: process.cwd(), env: {}, signal: controller.signal,
    register: async () => undefined, onDrain: () => undefined,
    log: (chunk) => { output += chunk; if (output.includes("grandchild:")) controller.abort(new Error("cancelled tree")); return true; }
  }), /cancelled tree/);
  assert.ok(Date.now() - started >= 2400, "waits for force-kill before releasing execution");
  for (const match of output.matchAll(/(?:parent|grandchild):(\d+)/g)) {
    const stat = await fs.readFile(`/proc/${match[1]}/stat`, "utf8").catch(() => "");
    assert.ok(!stat || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z"), `process ${match[1]} stopped`);
  }
});
