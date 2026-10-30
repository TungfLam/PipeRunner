import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { env } from "../config/env";
import { processIdentity, type ProcessIdentity } from "./processRunner";

/** Recovery requires a single owner of DATA_ROOT. Reject a second live backend. */
export async function acquireBackendLease() {
  const file = path.join(env.DATA_ROOT, ".backend-owner.json");
  const identity: ProcessIdentity = process.platform === "linux" ? await processIdentity(process.pid) : { pid: process.pid };
  // Publish a fully written inode atomically. A kill between open() and write()
  // must not leave an empty owner file that prevents the next startup.
  const candidate = `${file}.${randomUUID()}`;
  await fs.writeFile(candidate, JSON.stringify(identity), { flag: "wx" });
  try { await fs.link(candidate, file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const old: ProcessIdentity = JSON.parse(await fs.readFile(file, "utf8"));
    let alive = false;
    if (process.platform === "linux") {
      const current = await processIdentity(old.pid).catch(() => undefined);
      alive = !!current && current.startTime === old.startTime && current.bootId === old.bootId;
    } else { try { process.kill(old.pid, 0); alive = true; } catch {} }
    if (alive) throw new Error("Another backend already owns DATA_ROOT; stop it before starting this backend");
    await fs.unlink(file);
    await fs.link(candidate, file);
  } finally { await fs.unlink(candidate).catch(() => undefined); }
  return async () => {
    const current = await fs.readFile(file, "utf8").catch(() => "");
    if (current === JSON.stringify(identity)) await fs.unlink(file).catch(() => undefined);
  };
}
