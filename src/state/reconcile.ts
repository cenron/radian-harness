// Interrupted-state reconciliation on resume. Durable state, not chat memory,
// decides what was running. Attempts whose termination is verified are closed;
// live ones are reported for supervision re-attachment; unknown ones are closed
// with unknown termination, which blocks any replacement until reconciled.

import type { Outcome } from "../contracts/blockers.ts";
import type { RunState } from "./model.ts";
import type { RunStore } from "./run-store.ts";

export type AttemptEvidence = "terminated" | "alive" | "unknown";

export interface ReconcileReport {
  closedVerified: string[];
  stillAlive: string[];
  unknown: string[];
  failures: Array<{ attempt: string; code: string }>;
}

export async function reconcileRun(store: RunStore, inspect: (assignment: string, attempt: string) => AttemptEvidence): Promise<ReconcileReport> {
  const report: ReconcileReport = { closedVerified: [], stillAlive: [], unknown: [], failures: [] };
  const state: RunState = store.state;
  for (const assignment of Object.values(state.assignments)) {
    for (const attempt of assignment.attempts) {
      const open = attempt.status !== "ended" || attempt.termination !== "verified";
      if (!open) continue;
      const evidence = inspect(assignment.id, attempt.id);
      let outcome: Outcome<unknown> | undefined;
      if (evidence === "terminated") {
        outcome = await store.endAttempt(assignment.id, attempt.id, attempt.endReason ?? "infrastructure", "verified");
        if (outcome.ok) report.closedVerified.push(attempt.id);
      } else if (evidence === "alive") {
        report.stillAlive.push(attempt.id);
      } else {
        if (attempt.status !== "ended") outcome = await store.endAttempt(assignment.id, attempt.id, "unknown", "unknown");
        report.unknown.push(attempt.id);
      }
      if (outcome && !outcome.ok) report.failures.push({ attempt: attempt.id, code: outcome.blocker.code });
    }
  }
  return report;
}
