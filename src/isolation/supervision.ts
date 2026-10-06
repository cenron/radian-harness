// Coordinator-side supervision client: starts the independent watcher, sends
// heartbeats, maintains the watch list, and checks watcher health. If the
// watcher is lost, supervision is unhealthy: no new modifying launches, and the
// coordinator stops owned execution itself while it is still alive.

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { type Clock, systemClock } from "../util/clock.ts";
import { type IdentityProbe, type ProcessIdentity, currentIdentity, liveness, psProbe } from "../util/process-identity.ts";
import { atomicWriteJson, ensureDir, readJsonIfExists, withLock } from "../state/fsutil.ts";
import { type WatchList, type WatchedAssignment, watchListFile, watcherStatusFile } from "./watcher.ts";

export interface SupervisionOptions {
  stateDir: string;
  leaseMs: number;
  graceMs: number;
  clock?: Clock;
  probe?: IdentityProbe;
}

const WATCHER_MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "watcher-main.ts");

export class SupervisionClient {
  private readonly options: SupervisionOptions;
  private readonly clock: Clock;
  private readonly probe: IdentityProbe;
  private child: ChildProcess | undefined;
  private watcherIdentity: ProcessIdentity | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: SupervisionOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.probe = options.probe ?? psProbe;
  }

  async start(): Promise<Outcome<ProcessIdentity>> {
    const self = currentIdentity(this.probe);
    if (!self) return refuse("SUPERVISION_UNHEALTHY", "cannot establish coordinator identity");
    ensureDir(path.join(this.options.stateDir, "supervision"));
    await this.updateWatchList((list) => ({ ...list, coordinator: self }));
    const child = spawn(process.execPath, [WATCHER_MAIN, this.options.stateDir, String(this.options.leaseMs), String(this.options.graceMs)], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
    });
    child.unref();
    this.child = child;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const status = readJsonIfExists(watcherStatusFile(this.options.stateDir));
      if (status.state === "ok") {
        const identity = (status.value as { identity?: ProcessIdentity }).identity;
        if (identity && identity.pid === child.pid) {
          this.watcherIdentity = identity;
          this.timer = setInterval(() => this.beat(), Math.max(50, Math.floor(this.options.leaseMs / 3)));
          this.timer.unref();
          return success(identity);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return refuse("SUPERVISION_UNHEALTHY", "watcher did not start");
  }

  beat(): void {
    this.child?.stdin?.write("beat\n");
  }

  /** Healthy only when the watcher process is the recorded one and its status is fresh. */
  health(): Outcome<true> {
    if (!this.watcherIdentity) return refuse("SUPERVISION_UNHEALTHY", "watcher not started");
    const state = liveness(this.watcherIdentity, this.probe);
    if (state !== "alive") return refuse("SUPERVISION_UNHEALTHY", `watcher is ${state === "dead" ? "gone" : "unverifiable"}`, "Stop owned execution and restart supervision before any new launch.");
    const status = readJsonIfExists(watcherStatusFile(this.options.stateDir));
    if (status.state !== "ok") return refuse("SUPERVISION_UNHEALTHY", "watcher status is unreadable");
    const beatAt = Date.parse((status.value as { beatAt?: string }).beatAt ?? "");
    if (!Number.isFinite(beatAt) || this.clock.now() - beatAt > this.options.leaseMs * 2) return refuse("SUPERVISION_UNHEALTHY", "watcher status is stale");
    return success(true);
  }

  async updateWatchList(update: (list: WatchList) => WatchList): Promise<void> {
    const file = watchListFile(this.options.stateDir);
    await withLock(file + ".lock", "watch list", () => {
      const read = readJsonIfExists(file);
      const current: WatchList = read.state === "ok" ? (read.value as WatchList) : { schema: "radian.watch/1", coordinator: { pid: 0, start: "" }, assignments: [] };
      atomicWriteJson(file, update(current));
    }, { probe: this.probe });
  }

  /** Register an assignment with the watcher before its worker is bound. */
  watch(entry: WatchedAssignment): Promise<void> {
    return this.updateWatchList((list) => ({ ...list, assignments: [...list.assignments.filter((a) => a.assignment !== entry.assignment), entry] }));
  }

  unwatch(assignment: string): Promise<void> {
    return this.updateWatchList((list) => ({ ...list, assignments: list.assignments.filter((a) => a.assignment !== assignment) }));
  }

  /** Orderly shutdown: release the watcher without stopping workers. */
  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.child?.stdin?.write("release\n");
    this.child?.stdin?.end();
  }

  /** Simulate or perform an abrupt coordinator loss (tests): close the heartbeat pipe. */
  dropHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.child?.stdin?.destroy();
  }

  get identity(): ProcessIdentity | undefined {
    return this.watcherIdentity;
  }

  get now(): number {
    return this.clock.now();
  }
}
