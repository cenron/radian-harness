// Workspace-wide worker capacity. Reservations are made under a cross-process
// lock before any launch or replacement, count every role and Radian-managed run
// in the installed workspace, and are kept by live blocked or idle workers.
// A reservation is reclaimed only after its worker's termination is verified;
// unknown liveness keeps the slot occupied.

import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { newId, type Role } from "../contracts/identity.ts";
import { type Clock, iso, systemClock } from "../util/clock.ts";
import { type IdentityProbe, type ProcessIdentity, currentIdentity, psProbe } from "../util/process-identity.ts";
import { atomicWriteJson, readJsonIfExists, withLock } from "./fsutil.ts";

export interface Reservation {
  id: string;
  project: string;
  run: string;
  assignment: string;
  role: Role;
  createdAt: string;
  /** Coordinator process that made the reservation. */
  holder: ProcessIdentity;
  state: "reserved" | "active" | "blocked";
}

interface Ledger {
  schema: "radian.capacity/1";
  reservations: Reservation[];
}

export type TerminationEvidence = "terminated" | "alive" | "unknown";

export class CapacityLedger {
  private readonly dir: string;
  private readonly clock: Clock;
  private readonly probe: IdentityProbe;

  constructor(workspaceStateDir: string, options: { clock?: Clock; probe?: IdentityProbe } = {}) {
    this.dir = path.join(workspaceStateDir, "capacity");
    this.clock = options.clock ?? systemClock;
    this.probe = options.probe ?? psProbe;
  }

  private file(): string {
    return path.join(this.dir, "reservations.json");
  }

  private locked<T>(fn: (ledger: Ledger) => T): Promise<T> {
    return withLock(path.join(this.dir, "lock"), "capacity ledger", () => {
      const read = readJsonIfExists(this.file());
      if (read.state === "corrupt") throw new Error("capacity ledger is unreadable");
      const ledger: Ledger = read.state === "ok" ? (read.value as Ledger) : { schema: "radian.capacity/1", reservations: [] };
      return fn(ledger);
    }, { probe: this.probe });
  }

  async list(): Promise<Reservation[]> {
    return this.locked((ledger) => ledger.reservations.map((r) => ({ ...r })));
  }

  async reserve(ceiling: number, request: { project: string; run: string; assignment: string; role: Role }): Promise<Outcome<Reservation>> {
    const holder = currentIdentity(this.probe);
    if (!holder) return refuse("RESERVATION_UNKNOWN_OWNER", "cannot establish coordinator identity for reservation");
    try {
      return await this.locked((ledger) => {
        const existing = ledger.reservations.find((r) => r.assignment === request.assignment);
        if (existing) return success(existing);
        if (ledger.reservations.length >= ceiling) {
          return refuse("CAPACITY_FULL", `workspace capacity of ${ceiling} active worker(s) is in use`, "The assignment stays queued until a slot is released after verified retirement.", { inUse: ledger.reservations.length, ceiling });
        }
        const reservation: Reservation = { id: newId("rsv"), ...request, createdAt: iso(this.clock.now()), holder, state: "reserved" };
        ledger.reservations.push(reservation);
        atomicWriteJson(this.file(), ledger);
        return success(reservation);
      });
    } catch (error) {
      return refuse("RESERVATION_UNKNOWN_OWNER", (error as Error).message);
    }
  }

  async setState(id: string, state: Reservation["state"]): Promise<Outcome<Reservation>> {
    return this.locked((ledger) => {
      const found = ledger.reservations.find((r) => r.id === id);
      if (!found) return refuse("INVALID_TRANSITION", "unknown reservation");
      found.state = state;
      atomicWriteJson(this.file(), ledger);
      return success({ ...found });
    });
  }

  /** Release after the assignment's worker was verifiably retired. */
  async release(id: string, evidence: TerminationEvidence): Promise<Outcome<true>> {
    if (evidence !== "terminated") return refuse("TERMINATION_UNVERIFIED", "a reservation is released only after verified termination");
    return this.locked((ledger) => {
      const before = ledger.reservations.length;
      ledger.reservations = ledger.reservations.filter((r) => r.id !== id);
      if (ledger.reservations.length === before) return refuse("INVALID_TRANSITION", "unknown reservation");
      atomicWriteJson(this.file(), ledger);
      return success(true as const);
    });
  }

  /**
   * Reconcile reservations left by crashed coordinators. Only reservations whose
   * worker termination is verified are removed; alive or unknown ones are kept.
   */
  async reclaim(verify: (reservation: Reservation) => TerminationEvidence): Promise<{ reclaimed: string[]; retained: Array<{ id: string; evidence: TerminationEvidence }> }> {
    return this.locked((ledger) => {
      const reclaimed: string[] = [];
      const retained: Array<{ id: string; evidence: TerminationEvidence }> = [];
      ledger.reservations = ledger.reservations.filter((r) => {
        const evidence = verify(r);
        if (evidence === "terminated") {
          reclaimed.push(r.id);
          return false;
        }
        retained.push({ id: r.id, evidence });
        return true;
      });
      if (reclaimed.length > 0) atomicWriteJson(this.file(), ledger);
      return { reclaimed, retained };
    });
  }
}
