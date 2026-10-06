// Independent safety watcher. It runs as a separate process from the Pi
// coordinator, receives heartbeats over a pipe only the coordinator holds, and
// keeps a monotonic lease. On pipe EOF (coordinator crash) or lease expiry (live
// but stalled coordinator), it stops every watched assignment's owned execution,
// destroys their credential projections, and records termination evidence.
// It never relaunches anything.

import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import { type Clock, iso, systemClock } from "../util/clock.ts";
import type { ProcessIdentity } from "../util/process-identity.ts";
import { atomicWriteJson, readJsonIfExists } from "../state/fsutil.ts";
import type { ProcessOps } from "./processes.ts";
import { SupervisionRegistry } from "./registry.ts";
import { terminateOwned, type TerminationOutcome } from "./terminate.ts";

export interface WatchedAssignment {
  assignment: string;
  attempt: string;
  ownedRoots: string[];
  projectionDirs: string[];
}

export interface WatchList {
  schema: "radian.watch/1";
  coordinator: ProcessIdentity;
  assignments: WatchedAssignment[];
}

export function watchListFile(stateDir: string): string {
  return path.join(stateDir, "supervision", "watch.json");
}

export function watcherStatusFile(stateDir: string): string {
  return path.join(stateDir, "supervision", "watcher.json");
}

export function lossFile(stateDir: string): string {
  return path.join(stateDir, "supervision", "loss.json");
}

export interface WatcherOptions {
  stateDir: string;
  leaseMs: number;
  graceMs: number;
  ops: ProcessOps;
  clock?: Clock;
  self: ProcessIdentity;
}

export type LossReason = "heartbeat-eof" | "lease-expired";

export interface LossReport {
  reason: LossReason;
  at: string;
  outcomes: Array<{ assignment: string; attempt: string; outcome: TerminationOutcome; projectionsDestroyed: boolean }>;
}

export class Watcher {
  private readonly options: WatcherOptions;
  private readonly clock: Clock;
  private deadline: number;
  private stopped = false;

  constructor(options: WatcherOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.deadline = this.clock.monotonic() + options.leaseMs;
  }

  beat(): void {
    this.deadline = this.clock.monotonic() + this.options.leaseMs;
    this.writeStatus();
  }

  /** Orderly coordinator shutdown: stop watching without touching workers. */
  release(): void {
    this.stopped = true;
  }

  get released(): boolean {
    return this.stopped;
  }

  expired(): boolean {
    return !this.stopped && this.clock.monotonic() > this.deadline;
  }

  writeStatus(): void {
    atomicWriteJson(watcherStatusFile(this.options.stateDir), { schema: "radian.watcher/1", identity: this.options.self, beatAt: iso(this.clock.now()), leaseMs: this.options.leaseMs });
  }

  watchList(): WatchList | undefined {
    const read = readJsonIfExists(watchListFile(this.options.stateDir));
    return read.state === "ok" ? (read.value as WatchList) : undefined;
  }

  /** Stop all watched execution after loss of healthy coordination. */
  async onLoss(reason: LossReason): Promise<LossReport> {
    const list = this.watchList();
    const report: LossReport = { reason, at: iso(this.clock.now()), outcomes: [] };
    for (const watched of list?.assignments ?? []) {
      const registry = new SupervisionRegistry(this.options.stateDir, watched.assignment, this.clock);
      const outcome = await terminateOwned(this.options.ops, {
        registered: registry.processes(watched.attempt),
        ownedRoots: watched.ownedRoots,
        unresolvedIntents: registry.unresolvedIntents(watched.attempt).length,
        protectedPids: [this.options.self.pid, ...(list ? [list.coordinator.pid] : [])],
        graceMs: this.options.graceMs,
      });
      let projectionsDestroyed = true;
      for (const dir of watched.projectionDirs) {
        rmSync(dir, { recursive: true, force: true });
        if (existsSync(dir)) projectionsDestroyed = false;
      }
      await registry.append({ kind: "terminated", attempt: watched.attempt, postcondition: outcome.postcondition, survivors: outcome.survivors.length, discovered: outcome.discovered });
      report.outcomes.push({ assignment: watched.assignment, attempt: watched.attempt, outcome, projectionsDestroyed });
    }
    // Unfinished work in worktrees and outputs is never deleted.
    atomicWriteJson(lossFile(this.options.stateDir), report);
    return report;
  }
}
