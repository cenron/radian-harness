// Verified termination of owned execution: TERM, bounded grace, KILL, then
// re-observation. Only registered processes and their sampled descendants are
// signalled. Processes found only because their working directory lies in the
// assignment's owned roots (often detached children, but possibly a user's own
// shell) are never signalled; if any is alive the postcondition is "unknown".
// The postcondition is "verified" only when no registered, descendant, or
// suspect process survives and no registration was interrupted; "unknown"
// blocks any replacement or resource reuse.

import type { ProcessIdentity } from "../util/process-identity.ts";
import { type ProcessOps, type ProcessRow, descendants, identityOf } from "./processes.ts";

export interface TerminationRequest {
  registered: readonly ProcessIdentity[];
  /** Owned directories (worktree, scratch, output) used for cwd-based discovery. */
  ownedRoots: readonly string[];
  /** Interrupted registrations make the outcome unknown even if nothing is found. */
  unresolvedIntents: number;
  /** PIDs that must never be signalled (coordinator, watcher). */
  protectedPids: readonly number[];
  graceMs: number;
  maxRounds?: number;
}

export interface TerminationOutcome {
  postcondition: "verified" | "unknown";
  signalled: number;
  escalated: number;
  discovered: number;
  survivors: ProcessIdentity[];
  reasons: string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(rows: readonly ProcessRow[], id: ProcessIdentity): boolean {
  const current = identityOf(rows, id.pid);
  return current !== undefined && current.start === id.start;
}

export async function terminateOwned(ops: ProcessOps, request: TerminationRequest, wait: (ms: number) => Promise<unknown> = sleep): Promise<TerminationOutcome> {
  const reasons: string[] = [];
  const forbidden = new Set<number>([0, 1, process.pid, ...request.protectedPids]);
  const known = new Map<string, ProcessIdentity>();
  const suspects = new Map<string, ProcessIdentity>();
  for (const id of request.registered) if (!forbidden.has(id.pid)) known.set(`${id.pid}:${id.start}`, id);
  let discovered = 0;
  let signalled = 0;
  let escalated = 0;

  const discover = (rows: readonly ProcessRow[]): void => {
    const roots = [...known.values()].filter((id) => alive(rows, id)).map((id) => id.pid);
    for (const row of descendants(rows, roots)) {
      if (forbidden.has(row.pid)) continue;
      const key = `${row.pid}:${row.start}`;
      if (!known.has(key)) {
        known.set(key, { pid: row.pid, start: row.start });
        discovered += 1;
      }
    }
    const byCwd = ops.cwdWithin(request.ownedRoots);
    if (byCwd === undefined) {
      if (!reasons.includes("working-directory discovery unavailable")) reasons.push("working-directory discovery unavailable");
      return;
    }
    for (const pid of byCwd) {
      const row = rows.find((r) => r.pid === pid);
      if (!row || forbidden.has(row.pid)) continue;
      const key = `${row.pid}:${row.start}`;
      if (!known.has(key)) suspects.set(key, { pid: row.pid, start: row.start });
    }
  };

  const rounds = request.maxRounds ?? 3;
  for (let round = 0; round < rounds; round += 1) {
    const rows = ops.table();
    if (!rows) {
      reasons.push("process table unavailable");
      return { postcondition: "unknown", signalled, escalated, discovered, survivors: [...known.values()], reasons };
    }
    discover(rows);
    const living = [...known.values()].filter((id) => alive(rows, id));
    if (living.length === 0) break;
    for (const id of living) if (ops.signal(id.pid, "SIGTERM")) signalled += 1;
    await wait(request.graceMs);
    const after = ops.table();
    if (!after) {
      reasons.push("process table unavailable");
      return { postcondition: "unknown", signalled, escalated, discovered, survivors: [...known.values()], reasons };
    }
    discover(after);
    for (const id of [...known.values()].filter((x) => alive(after, x))) {
      // Re-check identity immediately before escalation to avoid signalling a reused PID.
      const fresh = ops.table();
      if (fresh && alive(fresh, id) && ops.signal(id.pid, "SIGKILL")) escalated += 1;
    }
    await wait(Math.min(request.graceMs, 500));
  }
  const final = ops.table();
  if (!final) {
    reasons.push("process table unavailable");
    return { postcondition: "unknown", signalled, escalated, discovered, survivors: [...known.values()], reasons };
  }
  discover(final);
  const survivors = [...known.values()].filter((id) => alive(final, id));
  if (survivors.length > 0) reasons.push(`${survivors.length} owned process(es) survived`);
  const liveSuspects = [...suspects.values()].filter((id) => alive(final, id) && !known.has(`${id.pid}:${id.start}`));
  if (liveSuspects.length > 0) {
    reasons.push(`${liveSuspects.length} process(es) with a working directory in owned roots were not provably owned and were not signalled`);
    survivors.push(...liveSuspects);
  }
  if (request.unresolvedIntents > 0) reasons.push("a registration was interrupted; an unregistered process may exist");
  const unavailable = reasons.some((r) => r.includes("unavailable"));
  const postcondition = survivors.length === 0 && request.unresolvedIntents === 0 && !unavailable ? "verified" : "unknown";
  return { postcondition, signalled, escalated, discovered, survivors, reasons };
}
