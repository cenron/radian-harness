// Local, private, provenance-rich metrics. Records hold identifiers, counts,
// durations, and categories only — never prompts, code, logs, or credentials.
// Unknown usage stays unknown (it is never summed as zero), and no subscription
// dollar amounts are invented.

import { readFileSync } from "node:fs";
import path from "node:path";
import { type Clock, iso, systemClock } from "../util/clock.ts";
import { appendDurable } from "../state/fsutil.ts";
import type { HarnessProvenance } from "../state/model.ts";

export type MetricKind =
  | "run-started"
  | "round-started"
  | "assignment-started"
  | "assignment-bound"
  | "assignment-ended"
  | "result-recorded"
  | "candidate-assembled"
  | "check-outcome"
  | "review-outcome"
  | "integration"
  | "rounds-exhausted"
  | "quota-blocked"
  | "question-opened"
  | "recovery"
  | "cancellation"
  | "preflight-blocked"
  | "stale-result"
  | "supervision-gap";

export interface MetricRecord {
  schema: "radian.metric/1";
  at: string;
  kind: MetricKind;
  provenance: HarnessProvenance;
  configHash: string;
  run: string;
  task?: string;
  assignment?: string;
  role?: string;
  runtime?: string;
  model?: string;
  effort?: string;
  round?: number;
  /** Category-like values only (outcome, blocker code, error class). */
  outcome?: string;
  durationMs?: number;
  blockedMs?: Record<string, number>;
  usage?: { status: "unknown" } | { status: "reported"; inputTokens?: number; outputTokens?: number; source: string };
}

export class MetricsRecorder {
  readonly file: string;
  private readonly clock: Clock;
  private readonly base: Pick<MetricRecord, "provenance" | "configHash" | "run">;

  constructor(stateDir: string, base: Pick<MetricRecord, "provenance" | "configHash" | "run">, clock: Clock = systemClock) {
    this.file = path.join(stateDir, "metrics", "events.jsonl");
    this.base = base;
    this.clock = clock;
  }

  record(kind: MetricKind, fields: Omit<MetricRecord, "schema" | "at" | "kind" | "provenance" | "configHash" | "run"> = {}): void {
    const record: MetricRecord = { schema: "radian.metric/1", at: iso(this.clock.now()), kind, ...this.base, ...fields };
    appendDurable(this.file, JSON.stringify(record));
  }
}

export function readMetrics(file: string): MetricRecord[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as MetricRecord];
    } catch {
      return [];
    }
  });
}

export interface VersionSummary {
  version: string;
  revision: string;
  locallyModified: boolean | "unknown";
  runs: number;
  tasksIntegrated: number;
  firstRoundAcceptance: number;
  roundsStarted: number;
  roundsExhausted: number;
  assignments: number;
  executionMs: number;
  blockedMs: Record<string, number>;
  recoveries: number;
  cancellations: number;
  quotaBlocks: Record<string, number>;
  preflightBlocks: number;
  staleResults: number;
  supervisionGaps: number;
  usage: { reportedInputTokens: number; reportedOutputTokens: number; unknownCount: number };
}

/** Simple per-version summary; comparisons across versions are left to human judgment. */
export function summarize(records: readonly MetricRecord[]): VersionSummary[] {
  const groups = new Map<string, MetricRecord[]>();
  for (const r of records) {
    const key = `${r.provenance.version}@${r.provenance.revision}@${String(r.provenance.locallyModified)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((list) => {
    const p = list[0]!.provenance;
    const integrations = list.filter((r) => r.kind === "integration" && r.outcome === "integrated");
    const summary: VersionSummary = {
      version: p.version,
      revision: p.revision,
      locallyModified: p.locallyModified,
      runs: new Set(list.map((r) => r.run)).size,
      tasksIntegrated: integrations.length,
      firstRoundAcceptance: integrations.filter((r) => r.round === 1).length,
      roundsStarted: list.filter((r) => r.kind === "round-started").length,
      roundsExhausted: list.filter((r) => r.kind === "rounds-exhausted").length,
      assignments: list.filter((r) => r.kind === "assignment-started").length,
      executionMs: 0,
      blockedMs: {},
      recoveries: list.filter((r) => r.kind === "recovery").length,
      cancellations: list.filter((r) => r.kind === "cancellation").length,
      quotaBlocks: {},
      preflightBlocks: list.filter((r) => r.kind === "preflight-blocked").length,
      staleResults: list.filter((r) => r.kind === "stale-result").length,
      supervisionGaps: list.filter((r) => r.kind === "supervision-gap").length,
      usage: { reportedInputTokens: 0, reportedOutputTokens: 0, unknownCount: 0 },
    };
    for (const r of list) {
      if (r.kind === "assignment-ended") {
        summary.executionMs += r.durationMs ?? 0;
        for (const [reason, ms] of Object.entries(r.blockedMs ?? {})) summary.blockedMs[reason] = (summary.blockedMs[reason] ?? 0) + ms;
      }
      if (r.kind === "quota-blocked") {
        const profile = `${r.runtime ?? "?"}/${r.model ?? "?"}/${r.effort ?? "?"}`;
        summary.quotaBlocks[profile] = (summary.quotaBlocks[profile] ?? 0) + 1;
      }
      if (r.kind === "result-recorded" && r.usage) {
        if (r.usage.status === "unknown") summary.usage.unknownCount += 1;
        else {
          summary.usage.reportedInputTokens += r.usage.inputTokens ?? 0;
          summary.usage.reportedOutputTokens += r.usage.outputTokens ?? 0;
        }
      }
    }
    return summary;
  });
}
