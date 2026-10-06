// Local durable-file primitives: atomic replace (temp + fsync + rename), fsynced
// appends, and a cross-process mutex based on atomic directory creation with a
// verified owner. A lock whose owner cannot be proven dead is never broken.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { type IdentityProbe, type ProcessIdentity, currentIdentity, liveness, psProbe } from "../util/process-identity.ts";

export function ensureDir(dir: string, mode = 0o700): void {
  mkdirSync(dir, { recursive: true, mode });
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is best effort on platforms that do not support it.
  }
}

export function atomicWrite(file: string, data: string | Buffer, mode = 0o600): void {
  const dir = path.dirname(file);
  ensureDir(dir);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", mode);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  fsyncDir(dir);
}

export function atomicWriteJson(file: string, value: unknown): void {
  atomicWrite(file, JSON.stringify(value, null, 2) + "\n");
}

export function readJsonIfExists(file: string): { state: "absent" } | { state: "ok"; value: unknown } | { state: "corrupt" } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "corrupt" };
  }
  try {
    return { state: "ok", value: JSON.parse(text) as unknown };
  } catch {
    return { state: "corrupt" };
  }
}

export function appendDurable(file: string, line: string): void {
  ensureDir(path.dirname(file));
  const fd = openSync(file, "a", 0o600);
  try {
    writeSync(fd, Buffer.from(line.endsWith("\n") ? line : line + "\n", "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface LockOwner {
  token: string;
  identity: ProcessIdentity;
  purpose: string;
}

export interface LockOptions {
  timeoutMs?: number;
  retryMs?: number;
  probe?: IdentityProbe;
}

export class LockUnavailableError extends Error {
  readonly reason: "held" | "owner-unknown" | "timeout";
  constructor(reason: "held" | "owner-unknown" | "timeout", message: string) {
    super(message);
    this.reason = reason;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` while holding a directory-based mutex. A lock left by a process that
 * is verifiably gone (absent PID or different start time) is removed; a lock
 * whose owner is alive or cannot be checked is respected until timeout.
 */
export async function withLock<T>(lockDir: string, purpose: string, fn: () => Promise<T> | T, options: LockOptions = {}): Promise<T> {
  const probe = options.probe ?? psProbe;
  const identity = currentIdentity(probe);
  if (!identity) throw new LockUnavailableError("owner-unknown", "cannot establish this process's identity");
  const owner: LockOwner = { token: randomUUID(), identity, purpose };
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  ensureDir(path.dirname(lockDir));
  let lastReason: "held" | "owner-unknown" = "held";
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(owner), { mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readJsonIfExists(path.join(lockDir, "owner.json"));
      if (existing.state === "ok") {
        const other = existing.value as Partial<LockOwner>;
        const otherIdentity = other.identity;
        if (otherIdentity && typeof otherIdentity.pid === "number" && typeof otherIdentity.start === "string") {
          const state = liveness(otherIdentity as ProcessIdentity, probe);
          if (state === "dead") {
            // Rename before removal so two reclaimers cannot both proceed on the same stale lock.
            const tomb = `${lockDir}.stale.${randomUUID()}`;
            try {
              renameSync(lockDir, tomb);
              rmSync(tomb, { recursive: true, force: true });
            } catch {
              // Another process reclaimed it first.
            }
            continue;
          }
          lastReason = state === "alive" ? "held" : "owner-unknown";
        } else {
          lastReason = "owner-unknown";
        }
      } else {
        // Lock directory without a readable owner: possibly mid-creation. Wait; never break it.
        lastReason = "owner-unknown";
      }
      if (Date.now() >= deadline) throw new LockUnavailableError(lastReason === "held" ? "timeout" : "owner-unknown", `lock for ${purpose} is unavailable (${lastReason})`);
      await sleep(options.retryMs ?? 25);
    }
  }
  try {
    return await fn();
  } finally {
    const current = readJsonIfExists(path.join(lockDir, "owner.json"));
    if (current.state === "ok" && (current.value as LockOwner).token === owner.token) {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
}
