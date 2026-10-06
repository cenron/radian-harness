// Coordinator lease: one active coordinator/writer per project. A lease held by
// a live process, or by a process whose liveness cannot be determined, is never
// taken over. A verifiably dead owner's lease is reclaimed with a higher
// generation, which makes any later write from the old owner fail.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { type Blocker, type Outcome, refuse, success } from "../contracts/blockers.ts";
import { type Clock, iso, systemClock } from "../util/clock.ts";
import { type IdentityProbe, type ProcessIdentity, currentIdentity, liveness, psProbe } from "../util/process-identity.ts";
import { atomicWriteJson, readJsonIfExists, withLock } from "./fsutil.ts";

export interface LeaseRecord {
  schema: "radian.coordinator-lease/1";
  project: string;
  token: string;
  generation: number;
  owner: ProcessIdentity;
  acquiredAt: string;
  expiresAtMs: number;
}

export interface LeaseOptions {
  clock?: Clock;
  probe?: IdentityProbe;
  ttlMs?: number;
}

export class CoordinatorLease {
  readonly stateDir: string;
  readonly record: LeaseRecord;
  private readonly clock: Clock;
  private readonly probe: IdentityProbe;
  private readonly ttlMs: number;
  /** Set once released: this object never renews or writes as the owner again. */
  private released = false;

  constructor(stateDir: string, record: LeaseRecord, options: LeaseOptions) {
    this.stateDir = stateDir;
    this.record = record;
    this.clock = options.clock ?? systemClock;
    this.probe = options.probe ?? psProbe;
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  get generation(): number {
    return this.record.generation;
  }

  static file(stateDir: string): string {
    return path.join(stateDir, "coordinator-lease.json");
  }

  static lockDir(stateDir: string): string {
    return path.join(stateDir, "locks", "lease");
  }

  static async acquire(stateDir: string, project: string, options: LeaseOptions = {}): Promise<Outcome<CoordinatorLease>> {
    const clock = options.clock ?? systemClock;
    const probe = options.probe ?? psProbe;
    const ttlMs = options.ttlMs ?? 30_000;
    const self = currentIdentity(probe);
    if (!self) return refuse("LEASE_HELD", "cannot establish coordinator process identity");
    return withLock(CoordinatorLease.lockDir(stateDir), "coordinator lease", () => {
      const existing = readJsonIfExists(CoordinatorLease.file(stateDir));
      let generation = 1;
      if (existing.state === "corrupt") return refuse("STATE_CORRUPT", "coordinator lease record is unreadable", "Inspect the project state directory; do not delete it blindly.");
      if (existing.state === "ok") {
        const other = existing.value as LeaseRecord;
        if (other.project !== project) return refuse("DUPLICATE_BINDING", "lease belongs to a different project identity");
        const released = other.owner.pid === 0 && other.owner.start === "released";
        const state = released ? "dead" : liveness(other.owner, probe);
        if (state === "alive") return refuse("LEASE_HELD", "another coordinator holds this project's lease", "Use the existing coordinator session, or stop it before starting another.");
        if (state === "unknown") return refuse("LEASE_HELD", "the previous coordinator's liveness cannot be verified", "Confirm the previous coordinator has stopped, then retry.");
        generation = other.generation + 1;
      }
      const record: LeaseRecord = {
        schema: "radian.coordinator-lease/1",
        project,
        token: randomUUID(),
        generation,
        owner: self,
        acquiredAt: iso(clock.now()),
        expiresAtMs: clock.now() + ttlMs,
      };
      atomicWriteJson(CoordinatorLease.file(stateDir), record);
      return success(new CoordinatorLease(stateDir, record, { clock, probe, ttlMs }));
    }, { probe });
  }

  /** Check, without the lease lock, that this lease is still the recorded one and unexpired. */
  checkHeld(): Outcome<true> {
    if (this.released) return refuse("LEASE_LOST", "this coordinator released its lease");
    const current = readJsonIfExists(CoordinatorLease.file(this.stateDir));
    if (current.state !== "ok") return refuse("LEASE_LOST", "coordinator lease record is missing or unreadable");
    const record = current.value as LeaseRecord;
    if (record.token !== this.record.token || record.generation !== this.record.generation) {
      return refuse("LEASE_LOST", "this coordinator's lease was superseded", "Stop this coordinator; another session owns the project.");
    }
    if (this.clock.now() > record.expiresAtMs) return refuse("LEASE_LOST", "coordinator lease expired before renewal", "Renew the lease before further writes.");
    return success(true);
  }

  async renew(): Promise<Outcome<true>> {
    if (this.released) return refuse("LEASE_LOST", "a released lease is never renewed");
    return withLock(CoordinatorLease.lockDir(this.stateDir), "coordinator lease", () => {
      if (this.released) return refuse("LEASE_LOST", "a released lease is never renewed");
      const current = readJsonIfExists(CoordinatorLease.file(this.stateDir));
      if (current.state !== "ok") return refuse("LEASE_LOST", "coordinator lease record is missing");
      const record = current.value as LeaseRecord;
      if (record.token !== this.record.token || record.generation !== this.record.generation) return refuse("LEASE_LOST", "this coordinator's lease was superseded");
      if (record.owner.pid === 0 && record.owner.start === "released") return refuse("LEASE_LOST", "the lease was released");
      if (this.clock.now() > record.expiresAtMs) return refuse("LEASE_LOST", "the lease expired before renewal; another coordinator may take over");
      const renewed = { ...record, expiresAtMs: this.clock.now() + this.ttlMs };
      atomicWriteJson(CoordinatorLease.file(this.stateDir), renewed);
      this.record.expiresAtMs = renewed.expiresAtMs;
      return success(true as const);
    }, { probe: this.probe });
  }

  async release(): Promise<void> {
    this.released = true;
    await withLock(CoordinatorLease.lockDir(this.stateDir), "coordinator lease", () => {
      const current = readJsonIfExists(CoordinatorLease.file(this.stateDir));
      if (current.state === "ok" && (current.value as LeaseRecord).token === this.record.token) {
        // Keep the record (generation history) but mark it expired and ownerless.
        atomicWriteJson(CoordinatorLease.file(this.stateDir), { ...(current.value as LeaseRecord), expiresAtMs: 0, owner: { pid: 0, start: "released" } });
      }
    }, { probe: this.probe });
  }
}

/**
 * Renew a lease periodically and report every refusal or error (never discard
 * them). Ticks do not overlap; after stop() nothing renews or reports, so a
 * session shutdown cannot renew a released lease or surface a stray rejection.
 */
export function startLeaseRenewal(lease: Pick<CoordinatorLease, "renew">, intervalMs: number, onFailure: (blocker: Blocker) => void): { stop(): void } {
  let stopped = false;
  let inFlight = false;
  const tick = (): void => {
    if (stopped || inFlight) return;
    inFlight = true;
    let renewal: Promise<Outcome<true>>;
    try {
      renewal = lease.renew();
    } catch {
      renewal = Promise.resolve(refuse("LEASE_LOST", "lease renewal failed"));
    }
    renewal
      .then(
        (outcome) => {
          if (!stopped && !outcome.ok) onFailure(outcome.blocker);
        },
        () => {
          if (!stopped) onFailure({ code: "LEASE_LOST", message: "lease renewal failed" });
        },
      )
      .finally(() => {
        inFlight = false;
      });
  };
  const timer = setInterval(tick, Math.max(10, intervalMs));
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
