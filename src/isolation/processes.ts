// Process observation and signalling for owned execution. Sampling `ps`/`lsof`
// is not an atomic process handle and cannot prove exhaustive discovery; every
// signal is preceded by an identity (PID + start time) check, never sent to
// PID <= 1, this process, or an identity that does not match a registration.

import { spawnSync } from "node:child_process";
import { isWithin } from "../contracts/paths.ts";
import type { ProcessIdentity } from "../util/process-identity.ts";

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  start: string;
}

export interface ProcessOps {
  table(): ProcessRow[] | undefined;
  /** PIDs whose current working directory is inside any of `roots`. */
  cwdWithin(roots: readonly string[]): number[] | undefined;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean;
}

export function parsePsTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), start: m[4]! });
  }
  return rows;
}

export function parseLsofCwd(text: string): Array<{ pid: number; cwd: string }> {
  const out: Array<{ pid: number; cwd: string }> = [];
  let pid: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined) out.push({ pid, cwd: line.slice(1) });
  }
  return out;
}

export const systemProcessOps: ProcessOps = {
  table() {
    const result = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="], { env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 10_000 });
    if (result.status !== 0 || result.error) return undefined;
    return parsePsTable(result.stdout);
  },
  cwdWithin(roots) {
    const result = spawnSync("/usr/sbin/lsof", ["-nP", "-d", "cwd", "-Fpn"], { env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin" }, encoding: "utf8", timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
    if (result.error || (result.status !== 0 && result.status !== 1)) return undefined;
    return parseLsofCwd(result.stdout)
      .filter((entry) => roots.some((root) => isWithin(entry.cwd, root)))
      .map((entry) => entry.pid);
  },
  signal(pid, signal) {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  },
};

/** All descendants of the given roots in a process table snapshot. */
export function descendants(rows: readonly ProcessRow[], roots: readonly number[]): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = byParent.get(row.ppid) ?? [];
    list.push(row);
    byParent.set(row.ppid, list);
  }
  const out: ProcessRow[] = [];
  const queue = [...roots];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

export function identityOf(rows: readonly ProcessRow[], pid: number): ProcessIdentity | undefined {
  const row = rows.find((r) => r.pid === pid);
  return row ? { pid: row.pid, start: row.start } : undefined;
}
