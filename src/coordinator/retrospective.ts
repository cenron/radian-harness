// On-demand retrospective proposals. A proposal is a private local artifact
// built from aggregated metrics (identifiers and counts only). It describes
// evidence, a proposed change, expected benefit, regression risk, evaluation,
// and rollback, and stays "proposed" until a human decides. Approval records the
// decision only: harness rules are never changed automatically, guardrails are
// never weakened to improve metrics, and nothing is exported.

import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { newId } from "../contracts/identity.ts";
import { type Clock, iso, systemClock } from "../util/clock.ts";
import { HumanChannel } from "../state/approvals.ts";
import { atomicWrite, atomicWriteJson, readJsonIfExists } from "../state/fsutil.ts";
import { type MetricRecord, type VersionSummary, summarize } from "./metrics.ts";

export interface RetrospectiveProposal {
  schema: "radian.retrospective/1";
  id: string;
  createdAt: string;
  status: "proposed" | "approved-for-separate-task" | "rejected";
  basedOn: { records: number; versions: string[] };
  observations: string[];
  proposal: { problem: string; change: string; expectedBenefit: string; regressionRisk: string; evaluation: string; rollback: string };
  decision?: { actor: string; at: string; note: string };
  /** Always false: retrospectives never modify harness policy or export data. */
  autoApply: false;
}

/** Guardrail-related changes that a retrospective may never propose to relax. */
const PROTECTED_TOPICS = /(approval|containment|sandbox|round cap|three rounds|recovery limit|provider restriction|anthropic|credential|publication scan)/i;

export function observationsFrom(summaries: readonly VersionSummary[]): string[] {
  const out: string[] = [];
  for (const s of summaries) {
    const label = `${s.version}@${s.revision.slice(0, 12)}${s.locallyModified === true ? "+modified" : s.locallyModified === "unknown" ? "+unknown-state" : ""}`;
    out.push(`${label}: ${s.tasksIntegrated} integrated task(s), ${s.firstRoundAcceptance} first-round, ${s.roundsExhausted} round cap exhaustion(s), ${s.recoveries} recovery attempt(s), ${s.cancellations} cancellation(s), ${s.preflightBlocks} preflight block(s), ${s.staleResults} stale result(s), ${s.supervisionGaps} supervision gap(s).`);
    const quota = Object.entries(s.quotaBlocks);
    if (quota.length > 0) out.push(`${label}: quota blocks by profile — ${quota.map(([p, n]) => `${p}: ${n}`).join(", ")}.`);
    if (s.usage.unknownCount > 0) out.push(`${label}: usage unknown for ${s.usage.unknownCount} result(s); not counted as zero.`);
    if (s.runs < 3) out.push(`${label}: small sample (${s.runs} run(s)); comparisons are not conclusive.`);
  }
  return out;
}

export class Retrospectives {
  private readonly dir: string;
  private readonly clock: Clock;

  constructor(stateDir: string, clock: Clock = systemClock) {
    this.dir = path.join(stateDir, "retrospectives");
    this.clock = clock;
  }

  create(records: readonly MetricRecord[], proposal: RetrospectiveProposal["proposal"]): Outcome<RetrospectiveProposal> {
    if (PROTECTED_TOPICS.test(`${proposal.change} ${proposal.problem}`) && /(relax|weaken|remove|disable|skip|raise|increase|bypass)/i.test(proposal.change)) {
      return refuse("AUTHORITY_INVALID", "retrospectives may not propose weakening approvals, containment, round limits, provider restrictions, or publication safety");
    }
    const summaries = summarize(records);
    const item: RetrospectiveProposal = {
      schema: "radian.retrospective/1",
      id: newId("retro"),
      createdAt: iso(this.clock.now()),
      status: "proposed",
      basedOn: { records: records.length, versions: summaries.map((s) => `${s.version}@${s.revision.slice(0, 12)}`) },
      observations: observationsFrom(summaries),
      proposal,
      autoApply: false,
    };
    atomicWriteJson(path.join(this.dir, `${item.id}.json`), item);
    atomicWrite(path.join(this.dir, `${item.id}.md`), render(item));
    return success(item);
  }

  /** Record a human decision. Approval schedules a separate harness-development task; it applies nothing. */
  decide(channel: HumanChannel, id: string, decision: "approved-for-separate-task" | "rejected", note: string): Outcome<RetrospectiveProposal> {
    if (!HumanChannel.isGenuine(channel)) return refuse("APPROVAL_NOT_HUMAN", "retrospective decisions require explicit user input");
    const file = path.join(this.dir, `${id}.json`);
    const read = readJsonIfExists(file);
    if (read.state !== "ok") return refuse("INVALID_TRANSITION", "unknown retrospective");
    const item = read.value as RetrospectiveProposal;
    if (item.status !== "proposed") return refuse("INVALID_TRANSITION", "retrospective already decided");
    const updated: RetrospectiveProposal = { ...item, status: decision, decision: { actor: channel.actorId, at: iso(this.clock.now()), note } };
    atomicWriteJson(file, updated);
    atomicWrite(path.join(this.dir, `${id}.md`), render(updated));
    return success(updated);
  }
}

function render(item: RetrospectiveProposal): string {
  return [
    `# Retrospective ${item.id}`,
    ``,
    `Status: **${item.status}** (private local artifact; never applied or exported automatically)`,
    ``,
    `## Evidence`,
    ...item.observations.map((o) => `- ${o}`),
    ``,
    `## Proposal`,
    `- Problem: ${item.proposal.problem}`,
    `- Change: ${item.proposal.change}`,
    `- Expected benefit: ${item.proposal.expectedBenefit}`,
    `- Regression risk: ${item.proposal.regressionRisk}`,
    `- Evaluation: ${item.proposal.evaluation}`,
    `- Rollback: ${item.proposal.rollback}`,
    ...(item.decision ? [``, `## Decision`, `${item.status} by ${item.decision.actor} at ${item.decision.at}: ${item.decision.note}`] : []),
    ``,
  ].join("\n");
}
