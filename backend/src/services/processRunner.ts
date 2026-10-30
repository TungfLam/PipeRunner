import { spawn } from "child_process";
import fs from "fs/promises";

export interface ProcessIdentity { pid: number; startTime?: string; bootId?: string }

export async function processIdentity(pid: number): Promise<ProcessIdentity> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  return { pid, startTime: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
    bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() };
}

export async function stopOwnedProcess(identity: ProcessIdentity) {
  if (process.platform !== "linux" || !identity.startTime || !identity.bootId) return;
  const current = await processIdentity(identity.pid).catch(() => undefined);
  if (current?.startTime !== identity.startTime || current?.bootId !== identity.bootId) return;
  try { process.kill(-identity.pid, "SIGKILL"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

// IPC is a parent-death watchdog, including SIGKILL. No command starts until its
// process identity has been persisted. The supervisor owns the command's group.
const supervisor = String.raw`
const {spawn} = require("child_process");
let child, stopping = false, started = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (process.platform !== "win32") {
    try { process.kill(-process.pid, "SIGTERM"); } catch {}
    setTimeout(() => { try { process.kill(-process.pid, "SIGKILL"); } catch {} }, 2500);
  } else {
    child?.kill("SIGTERM");
    setTimeout(() => process.exit(1), 2500);
  }
  if (!child) process.exit(1);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("disconnect", stop);
process.on("message", (message) => {
  if (message.type === "cancel") return stop();
  if (message.type !== "start" || started || stopping) return;
  started = true;
  try {
    child = spawn(message.bin, message.args, {shell: false, cwd: message.cwd,
      env: message.env, stdio: ["ignore", "inherit", "inherit"]});
    child.on("error", error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; process.disconnect?.(); });
    child.on("close", code => {
      // On cancellation stay alive until the force-kill timer has also removed
      // grandchildren which ignored SIGTERM.
      if (!stopping) process.exit(code === null ? 1 : code);
    });
  } catch(error) { process.stderr.write(error.message + "\n"); stop(); }
});
process.send({type: "ready"});
`;

export async function runSupervisedCommand(input: {
  bin: string; args: string[]; cwd: string; env: Record<string, string>;
  timeoutSeconds?: number; signal: AbortSignal;
  register: (identity: ProcessIdentity) => Promise<void>;
  log: (chunk: Buffer) => boolean;
  onDrain: (resume: () => void) => void;
}) {
  input.signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", supervisor], {
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe", "ipc"]
    });
    let failure: Error | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let registered = false;
    const stop = () => { if (child.connected) child.send({ type: "cancel" }, () => undefined); };
    input.signal.addEventListener("abort", stop, { once: true });
    if (input.signal.aborted) stop();
    const write = (chunk: Buffer) => {
      if (!input.log(chunk)) {
        child.stdout!.pause(); child.stderr!.pause();
      }
    };
    input.onDrain(() => { child.stdout!.resume(); child.stderr!.resume(); });
    child.stdout!.on("data", write);
    child.stderr!.on("data", write);
    child.on("message", async (message: unknown) => {
      if ((message as { type?: string })?.type !== "ready" || registered) return;
      registered = true;
      try {
        const identity = process.platform === "linux" ? await processIdentity(child.pid!) : { pid: child.pid! };
        await input.register(identity);
        if (input.signal.aborted) { stop(); return; }
        if (input.timeoutSeconds) timeout = setTimeout(() => {
          failure = new Error(`Command timed out after ${input.timeoutSeconds} seconds`); stop();
        }, input.timeoutSeconds * 1000);
        if (child.connected) child.send({ type: "start", bin: input.bin, args: input.args,
          cwd: input.cwd, env: { ...process.env, ...input.env } }, (error) => {
            if (error) { failure = error; stop(); }
          });
      } catch (error) { failure = error as Error; stop(); }
    });
    child.once("error", (error) => { failure = error; });
    child.once("close", (code) => {
      if (timeout) clearTimeout(timeout);
      input.signal.removeEventListener("abort", stop);
      if (input.signal.aborted) reject(input.signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0) reject(Object.assign(new Error(`Command exited with code ${code ?? "unknown"}`), { exitCode: code }));
      else resolve();
    });
  });
}
