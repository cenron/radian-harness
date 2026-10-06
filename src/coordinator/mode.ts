// Interaction mode (Plan/Build). Managed sessions start in Plan. Plan blocks
// new modifying dispatch and integration immediately; it never pauses live
// workers by itself — that requires a separate confirmed decision. Switching
// modes never grants approval and never starts work.

import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { Role } from "../contracts/identity.ts";
import { type Clock, iso, systemClock } from "../util/clock.ts";
import { atomicWriteJson, readJsonIfExists } from "../state/fsutil.ts";

export type InteractionMode = "plan" | "build";

export interface ModeRecord {
  schema: "radian.mode/1";
  mode: InteractionMode;
  changedAt: string;
}

export class ModeState {
  private readonly file: string;
  private readonly clock: Clock;

  constructor(stateDir: string, clock: Clock = systemClock) {
    this.file = path.join(stateDir, "mode.json");
    this.clock = clock;
  }

  get mode(): InteractionMode {
    const read = readJsonIfExists(this.file);
    // Missing or unreadable mode state is Plan: the safe default.
    if (read.state !== "ok") return "plan";
    return (read.value as ModeRecord).mode === "build" ? "build" : "plan";
  }

  set(mode: InteractionMode): ModeRecord {
    const record: ModeRecord = { schema: "radian.mode/1", mode, changedAt: iso(this.clock.now()) };
    atomicWriteJson(this.file, record);
    return record;
  }

  toggle(): ModeRecord {
    return this.set(this.mode === "plan" ? "build" : "plan");
  }
}

export function isModifyingRole(role: Role): boolean {
  return role === "developer" || role === "tester";
}

/** Plan mode allows read-only scouts; modifying work and integration need Build. */
export function requireModeFor(mode: InteractionMode, action: { kind: "dispatch"; role: Role } | { kind: "integrate" } | { kind: "candidate-check" }): Outcome<true> {
  if (mode === "build") return success(true);
  if (action.kind === "dispatch" && !isModifyingRole(action.role)) return success(true);
  return refuse("MODE_PLAN", "Plan mode blocks modifying dispatch, candidate execution, and integration", "Switch to Build (Shift+Tab) when the approved work should proceed; switching does not approve anything.");
}
