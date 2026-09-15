import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Single-host durable store for no-send development workers. Never use on ephemeral hosting.
 * Atomic rename + fsync; exclusive directory lock across processes. A crashed lock fails closed:
 * operator recovery is required, rather than time-based lock stealing during a long RPC call.
 * Production multi-host execution requires a transactional database with fencing.
 */
export class Journal<T> {
  private readonly path: string;
  private readonly initial: () => T;
  constructor(path: string, initial: () => T) { this.path = path; this.initial = initial; }
  async read(): Promise<T> {
    try { return JSON.parse(await readFile(this.path, "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.initial(); throw error; }
  }
  async update<R>(fn: (state: T) => R | Promise<R>): Promise<R> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    await mkdir(lock, { mode: 0o700 }); // EEXIST means busy/recovery required; do not send.
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const state = await this.read();
      const result = await fn(state);
      const file = await open(temp, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path);
      const dir = await open(dirname(this.path), "r");
      try { await dir.sync(); } finally { await dir.close(); }
      return result;
    } finally { await rm(temp, { force: true }); await rm(lock, { recursive: true }); }
  }
}
