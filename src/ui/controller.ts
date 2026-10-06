// Radian's Pi coordinator interface. A thin integration layer over the
// coordinator services: it installs the managed editor (Shift+Tab Plan/Build),
// the Calm renderer, the coordinator tool guard, status/widgets, user commands,
// and model-callable tools. Approval, decision, integration, round-grant,
// recovery, and retrospective decisions are user commands only — never tools —
// and require an interactive terminal plus an explicit confirmation of the
// exact artifact/candidate. Without an interactive UI they are refused.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Blocker, type Outcome, refuse, success } from "../contracts/blockers.ts";
import { type Operation } from "../contracts/authority.ts";
import { ROLES, type Role } from "../contracts/identity.ts";
import { safeRelative } from "../contracts/paths.ts";
import type { AssignmentOutcome, AssignmentPlan } from "../coordinator/orchestrator.ts";
import { readMetrics } from "../coordinator/metrics.ts";
import { Retrospectives } from "../coordinator/retrospective.ts";
import type { Delivery } from "../git/delivery.ts";
import { CAPABILITIES, CapabilityRegistry } from "../isolation/capabilities.ts";
import { HumanChannel } from "../state/approvals.ts";
import { calmResolver } from "./calm.ts";
import { managedEditorFactory } from "./editor.ts";
import { guardToolCall } from "./guard.ts";
import type { HostContext, HostRuntime, PiHost } from "./pi-host.ts";
import { type ProjectSession, artifactHash, shortHash } from "./session.ts";

export const RADIAN_TOOLS = ["radian_status", "radian_write_artifact", "radian_dispatch", "radian_assemble"] as const;

export interface ControllerOptions {
  loadRuntime: () => Promise<HostRuntime>;
  openSession: (cwd: string) => Promise<Outcome<ProjectSession>>;
  startRun: (session: ProjectSession) => Promise<Outcome<NonNullable<ProjectSession["run"]>>>;
  /** Actor label recorded on human decisions (private local state). */
  actorId?: string;
}

const MODIFYING_OPS: Operation[] = ["read", "edit", "shell", "run-checks", "install-locked-dependencies", "deliver-changes", "write-report", "network-outbound"];
const ROLE_OPS: Record<Role, Operation[]> = {
  developer: MODIFYING_OPS,
  tester: MODIFYING_OPS,
  reviewer: ["read", "git-inspect", "write-report"],
  scout: ["read", "shell", "network-outbound", "write-report"],
};

export interface RadianController {
  readonly session: () => ProjectSession | undefined;
  readonly lastInputSource: () => string | undefined;
  toggleMode(ctx: HostContext): Promise<void>;
  command(args: string, ctx: HostContext): Promise<string>;
}

function blockerText(b: Blocker): string {
  return `BLOCKED ${b.code}: ${b.message}${b.nextAction ? ` — ${b.nextAction}` : ""}`;
}

export function registerRadian(pi: PiHost, options: ControllerOptions): RadianController {
  let session: ProjectSession | undefined;
  let runtime: HostRuntime | undefined;
  let lastInputSource: string | undefined;
  let toolsRegistered = false;
  const deliveries = new Map<string, Delivery>();
  const actor = options.actorId ?? "local-user";

  const managed = () => session !== undefined;

  const updateStatus = (ctx: HostContext): void => {
    if (!session) return;
    const mode = session.mode.mode.toUpperCase();
    const live = session.run?.coordinator.liveAssignments() ?? [];
    const calm = session.calm.enabled ? " · calm" : "";
    ctx.ui.setStatus("radian", `${mode}${live.length ? ` · ${live.length} live worker(s)` : ""}${calm}`);
    const lines: string[] = [];
    const state = session.run?.store.state;
    if (state) {
      for (const task of Object.values(state.tasks)) lines.push(`task ${task.id}: ${task.phase}, round ${task.roundsUsed}/${task.maxRounds}`);
      for (const a of Object.values(state.assignments)) {
        if (["retired", "cancelled"].includes(a.status)) continue;
        lines.push(`  ${a.role} ${a.id}: ${a.status}${a.status === "running" ? "" : ""}`);
      }
      for (const d of Object.values(state.decisions)) if (d.status === "open") lines.push(`decision ${d.id}: ${d.prompt.slice(0, 120)}`);
    }
    ctx.ui.setWidget("radian", lines.length ? lines : undefined);
  };

  /** Explicit human confirmation from an interactive terminal; never fabricated. */
  const humanConfirm = async (ctx: HostContext, title: string, details: string, origin: string): Promise<Outcome<HumanChannel>> => {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      return refuse("NONINTERACTIVE_APPROVAL_REQUIRED", "this decision requires an interactive Pi terminal", "Open the project in interactive Pi and run the command there.");
    }
    if (lastInputSource !== undefined && lastInputSource !== "interactive") {
      return refuse("APPROVAL_NOT_HUMAN", "decisions must come from interactive user input, not RPC or extension input");
    }
    const confirmed = await ctx.ui.confirm(title, details);
    if (!confirmed) return refuse("APPROVAL_MISSING", "the user declined");
    return success(HumanChannel.fromUserInput("user-ui", actor, origin));
  };

  const requireRun = async (): Promise<Outcome<NonNullable<ProjectSession["run"]>>> => {
    if (!session) return refuse("INSTALL_TARGET_INVALID", "this is not a Radian-managed project");
    return session.run ? success(session.run) : options.startRun(session);
  };

  const setMode = async (ctx: HostContext, mode: "plan" | "build"): Promise<string> => {
    if (!session) return "Radian is inactive in this project.";
    const previous = session.mode.mode;
    session.mode.set(mode);
    let note = "";
    if (mode === "plan" && previous === "build") {
      const live = (session.run?.coordinator.liveAssignments() ?? []).filter((a) => a.role === "developer" || a.role === "tester");
      if (live.length > 0) {
        if (ctx.mode === "tui" && ctx.hasUI && (await ctx.ui.confirm("Pause live modifying workers?", `${live.length} worker(s) are still running. Plan mode already blocks new modifying dispatch. Pausing stops them and preserves their work.`))) {
          for (const worker of live) await session.run!.coordinator.pause(worker.assignment, "user switched to Plan");
          note = ` Paused ${live.length} worker(s); their work is preserved.`;
        } else {
          note = ` ${live.length} modifying worker(s) are still running; Plan only blocks new dispatch.`;
        }
      }
    }
    updateStatus(ctx);
    return `Mode: ${mode.toUpperCase()}. Mode changes never approve or start work.${note}`;
  };

  const controller: RadianController = {
    session: () => session,
    lastInputSource: () => lastInputSource,
    async toggleMode(ctx) {
      if (!session) return;
      const message = await setMode(ctx, session.mode.mode === "plan" ? "build" : "plan");
      ctx.ui.notify(message, "info");
    },
    async command(args, ctx) {
      if (!session) return "Radian is inactive: this project is not registered in a Radian workspace.";
      const words = args.trim().split(/\s+/).filter(Boolean);
      const [sub = "status", ...rest] = words;
      switch (sub) {
        case "status":
          return statusText(session);
        case "mode": {
          const target = rest[0];
          if (target !== "plan" && target !== "build") return `Mode: ${session.mode.mode.toUpperCase()} (use /radian mode plan|build or Shift+Tab)`;
          return setMode(ctx, target);
        }
        case "calm": {
          const value = rest[0] === "on" ? true : rest[0] === "off" ? false : !session.calm.enabled;
          session.calm.set(value);
          updateStatus(ctx);
          return `Calm ${value ? "on" : "off"}: presentation only — execution, context, approvals, and logs are unchanged.`;
        }
        case "start": {
          const run = await requireRun();
          return run.ok ? `Run ${run.value.store.state.run.id} is active.` : blockerText(run.blocker);
        }
        case "task": {
          if (rest[0] !== "add" || rest.length < 2) return "Usage: /radian task add <title>";
          const run = await requireRun();
          if (!run.ok) return blockerText(run.blocker);
          const before = new Set(Object.keys(run.value.store.state.tasks));
          const added = await run.value.store.addTask(rest.slice(1).join(" "), session.config.harness.assignment.candidateRounds);
          if (!added.ok) return blockerText(added.blocker);
          const id = Object.keys(added.value.tasks).find((t) => !before.has(t));
          updateStatus(ctx);
          return `Task ${id} added.`;
        }
        case "approve":
        case "reject": {
          const [kind, task, artifact, flag] = rest;
          if (!kind || !task || !artifact || !["spec", "brief", "plan", "integration"].includes(kind)) return `Usage: /radian ${sub} <spec|brief|plan|integration> <task> <artifact-path>`;
          if (!safeRelative(artifact)) return "BLOCKED PATH_INVALID: artifact path must be repository-relative";
          const run = await requireRun();
          if (!run.ok) return blockerText(run.blocker);
          const hash = artifactHash(session.repo.root, artifact);
          if (!hash) return `BLOCKED APPROVAL_MISSING: artifact ${artifact} is missing`;
          let details = `${sub === "approve" ? "Approve" : "Reject"} ${kind} for task ${task}\nartifact ${artifact} (content ${shortHash(hash)})`;
          let integration: { candidate: { commit: string; tree: string; base: string }; target: { ref: string; commit: string } } | undefined;
          if (kind === "integration") {
            const summary = await run.value.coordinator.integrationSummary(task, run.value.coordinator.evidence(task).requiredChecks ?? []);
            if (!summary.ok) return blockerText(summary.blocker);
            integration = { candidate: summary.value.candidate, target: summary.value.target };
            details += `\ncandidate ${summary.value.candidate.commit.slice(0, 12)} onto ${summary.value.target.ref} at ${summary.value.target.commit.slice(0, 12)}\nchecks: ${summary.value.checks.map((c) => `${c.id}=${c.outcome}`).join(", ") || "none"}\nreview: ${summary.value.review ? `${summary.value.review.blockingFindings} blocking of ${summary.value.review.findings}` : "none"}\nrisks: ${summary.value.risks.join("; ") || "none"}\ngaps: ${summary.value.gaps.join("; ") || "none"}`;
            if (sub === "approve" && !summary.value.ready) return `BLOCKED CANDIDATE_MISMATCH: not ready for integration (${summary.value.gaps.join("; ")})`;
          }
          const channel = await humanConfirm(ctx, `Radian ${sub} ${kind}`, details, `/radian ${sub} ${kind}`);
          if (!channel.ok) return blockerText(channel.blocker);
          const recorded = await run.value.store.recordApproval(channel.value, {
            kind: kind as "spec" | "brief" | "plan" | "integration",
            task,
            artifact: { path: artifact, hash },
            decision: sub === "approve" ? "approved" : "rejected",
            ...(flag === "lightweight" && kind === "brief" ? { lightweight: true as const } : {}),
            ...(integration ?? {}),
          });
          updateStatus(ctx);
          return recorded.ok ? `${kind} ${sub === "approve" ? "approved" : "rejected"} for ${task} (content ${shortHash(hash)}).` : blockerText(recorded.blocker);
        }
        case "decide": {
          const [decisionId, ...answer] = rest;
          if (!decisionId || answer.length === 0) return "Usage: /radian decide <decision-id> <answer>";
          const run = await requireRun();
          if (!run.ok) return blockerText(run.blocker);
          const decision = run.value.store.state.decisions[decisionId];
          if (!decision) return "BLOCKED INVALID_TRANSITION: unknown decision";
          const channel = await humanConfirm(ctx, "Radian decision", `${decision.prompt}\n\nAnswer: ${answer.join(" ")}`, "/radian decide");
          if (!channel.ok) return blockerText(channel.blocker);
          const resolved = await run.value.store.resolveDecision(channel.value, decisionId, answer.join(" "));
          updateStatus(ctx);
          return resolved.ok ? `Decision ${decisionId} resolved. Resume starts a fresh attempt.` : blockerText(resolved.blocker);
        }
        case "integrate": {
          const [task] = rest;
          if (!task) return "Usage: /radian integrate <task>";
          const run = await requireRun();
          if (!run.ok) return blockerText(run.blocker);
          const evidence = run.value.coordinator.evidence(task);
          const required = evidence.requiredChecks ?? [];
          if (required.length === 0) return "BLOCKED CANDIDATE_MISMATCH: no required checks were recorded for this task";
          const approval = Object.values(run.value.store.state.approvals).filter((a) => a.task === task && a.kind === "integration" && a.decision === "approved").at(-1);
          if (!approval) return "BLOCKED APPROVAL_MISSING: integration approval is required (/radian approve integration ...)";
          const channel = await humanConfirm(ctx, "Radian integrate", `Fast-forward ${session.target?.ref ?? "target"} to the approved candidate for ${task}?`, "/radian integrate");
          if (!channel.ok) return blockerText(channel.blocker);
          const integrated = await run.value.coordinator.integrate(channel.value, task, required, { path: approval.artifact.path });
          updateStatus(ctx);
          return integrated.ok ? `Integrated ${task}: ${integrated.value.from.slice(0, 12)} → ${integrated.value.to.slice(0, 12)}.` : blockerText(integrated.blocker);
        }
        case "pause":
        case "cancel": {
          const [assignment] = rest;
          if (!assignment) return `Usage: /radian ${sub} <assignment>`;
          const run = await requireRun();
          if (!run.ok) return blockerText(run.blocker);
          const done = sub === "pause" ? await run.value.coordinator.pause(assignment, "user request") : await run.value.coordinator.cancel(assignment);
          updateStatus(ctx);
          return done.ok ? `${sub === "pause" ? "Paused" : "Cancelled"} ${assignment}; termination ${done.value.termination}. Work is preserved.` : blockerText(done.blocker);
        }
        case "grant-rounds":
        case "authorize-recovery": {
          const [target, n] = rest;
          if (!target) return `Usage: /radian ${sub} <${sub === "grant-rounds" ? "task> <n" : "assignment"}>`;
          const run = await requireRun();
          if (!run.ok) return blockerText(run.blocker);
          const channel = await humanConfirm(ctx, `Radian ${sub}`, sub === "grant-rounds" ? `Grant ${n ?? "1"} more candidate round(s) to ${target}?` : `Authorize one more attempt for ${target}?`, `/radian ${sub}`);
          if (!channel.ok) return blockerText(channel.blocker);
          const decisionId = `dec_${sub}-${Date.now()}`;
          const done = sub === "grant-rounds" ? await run.value.store.grantRounds(channel.value, target, Number(n ?? "1"), decisionId) : await run.value.store.authorizeRecovery(channel.value, target, decisionId);
          return done.ok ? `Recorded human decision ${decisionId}.` : blockerText(done.blocker);
        }
        case "retro": {
          const run = await requireRun();
          if (!run.ok) return blockerText(run.blocker);
          const retros = new Retrospectives(session.project.state);
          if (rest[0] === "decide") {
            const [, id, verdict, ...note] = rest;
            if (!id || (verdict !== "approve" && verdict !== "reject")) return "Usage: /radian retro decide <id> approve|reject [note]";
            const channel = await humanConfirm(ctx, "Radian retrospective decision", `${verdict} retrospective ${id}? Approval only schedules a separate harness task.`, "/radian retro decide");
            if (!channel.ok) return blockerText(channel.blocker);
            const decided = retros.decide(channel.value, id, verdict === "approve" ? "approved-for-separate-task" : "rejected", note.join(" ") || "no note");
            return decided.ok ? `Retrospective ${id}: ${decided.value.status}.` : blockerText(decided.blocker);
          }
          const records = readMetrics(path.join(session.project.state, "metrics", "events.jsonl"));
          const created = retros.create(records, { problem: "On-demand review of recent runs", change: "To be written by the user from the evidence below", expectedBenefit: "n/a until specified", regressionRisk: "n/a until specified", evaluation: "Compare per-version summaries on comparable tasks", rollback: "Do not adopt; keep the current harness version" });
          return created.ok ? `Retrospective ${created.value.id} written privately (${created.value.observations.length} observation(s)); status proposed.` : blockerText(created.blocker);
        }
        case "capabilities":
          return capabilityText(session);
        default:
          return "Radian commands: status, mode plan|build, calm on|off, start, task add <title>, approve|reject <kind> <task> <path>, decide <id> <answer>, integrate <task>, pause|cancel <assignment>, grant-rounds <task> <n>, authorize-recovery <assignment>, retro [decide …], capabilities";
      }
    },
  };

  const registerTools = (rt: HostRuntime): void => {
    if (toolsRegistered) return;
    toolsRegistered = true;
    const T = rt.Type;
    pi.registerTool({
      name: "radian_status",
      label: "Radian status",
      description: "Read Radian's run, task, assignment, decision, and capability status. Read-only.",
      parameters: T.Object({}),
      execute: async () => ({ content: [{ type: "text", text: session ? statusText(session) : "Radian inactive." }], details: undefined }),
    });
    pi.registerTool({
      name: "radian_write_artifact",
      label: "Write planning artifact",
      description: "Write a PRD/spec, brief, or plan draft under .radian/planning/ for human review. Writing never approves it; only the user can approve with /radian approve.",
      parameters: T.Object({ path: T.String({ description: "Path relative to .radian/planning/" }), content: T.String() }),
      execute: async (_id, params) => {
        if (!session) throw new Error("Radian inactive");
        const relative = String(params.path ?? "");
        if (!safeRelative(relative)) throw new Error("path must be relative inside .radian/planning/");
        const root = session.planningRoots[0]!;
        const file = path.join(root, relative);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, String(params.content ?? ""));
        return { content: [{ type: "text", text: `Wrote ${path.join(".radian", "planning", relative)} (draft; requires the user's /radian approve).` }], details: undefined };
      },
    });
    pi.registerTool({
      name: "radian_dispatch",
      label: "Dispatch a worker",
      description: "Dispatch a registered worker assignment for an approved task. Requires Build mode for modifying roles, current approvals, healthy supervision, capacity, and verified runtime capabilities; otherwise returns a blocker. Runs in the background and reports its outcome.",
      parameters: T.Object({
        task: T.String(),
        role: T.Union(ROLES.map((r) => T.Literal(r))),
        objective: T.String(),
        planPath: T.String(),
        specPath: T.Optional(T.String()),
        briefPath: T.Optional(T.String()),
        acceptanceCriteria: T.Optional(T.Array(T.String())),
        nonGoals: T.Optional(T.Array(T.String())),
        writeRoots: T.Optional(T.Array(T.String())),
        candidateCheck: T.Optional(T.Boolean()),
        requiredChecks: T.Optional(T.Array(T.Object({ id: T.String(), description: T.String(), argv: T.Array(T.String()) }))),
        newCandidateRound: T.Optional(T.Boolean()),
        baseCandidate: T.Optional(T.String()),
        ruleId: T.Optional(T.String()),
        profile: T.Optional(T.String()),
        rationale: T.Optional(T.String()),
      }),
      execute: async (_id, params, _signal, _update, ctx) => {
        const run = await requireRun();
        if (!run.ok) return { content: [{ type: "text", text: blockerText(run.blocker) }], details: undefined };
        const planned = toPlan(session!, params);
        if (!planned.ok) return { content: [{ type: "text", text: blockerText(planned.blocker) }], details: undefined };
        if (planned.value.requiredChecks?.length) run.value.coordinator.setRequiredChecks(planned.value.task, planned.value.requiredChecks.map((c) => c.id));
        void run.value.coordinator.runAssignment(planned.value).then((outcome) => {
          const text = outcomeText(outcome);
          if (outcome.state === "completed") {
            if (outcome.delivery) deliveries.set(outcome.assignment, outcome.delivery);
            if (planned.value.purpose === "candidate-check") run.value.coordinator.recordCheckEvidence(planned.value.task, outcome.result);
            if (planned.value.role === "reviewer" && planned.value.base.kind === "commit") run.value.coordinator.recordReview(planned.value.task, planned.value.base.commit, outcome.result);
          }
          ctx.ui.notify(text, outcome.state === "completed" ? "info" : "warning");
          pi.sendMessage({ customType: "radian-outcome", content: text, display: true }, { triggerTurn: false });
          updateStatus(ctx);
        });
        return { content: [{ type: "text", text: `Dispatch requested for ${planned.value.role} on ${planned.value.task}; the outcome will be reported.` }], details: undefined };
      },
    });
    pi.registerTool({
      name: "radian_assemble",
      label: "Assemble candidate",
      description: "Combine completed developer/tester deliveries for a task into one exact candidate.",
      parameters: T.Object({ task: T.String(), assignments: T.Array(T.String()), mergeBase: T.String() }),
      execute: async (_id, params) => {
        const run = await requireRun();
        if (!run.ok) return { content: [{ type: "text", text: blockerText(run.blocker) }], details: undefined };
        const list = (params.assignments as string[]).map((a) => deliveries.get(a));
        if (list.some((d) => d === undefined)) return { content: [{ type: "text", text: "BLOCKED CANDIDATE_MISMATCH: unknown delivery" }], details: undefined };
        const candidate = await run.value.coordinator.assemble(String(params.task), list as Delivery[], String(params.mergeBase));
        return { content: [{ type: "text", text: candidate.ok ? `Candidate ${candidate.value.commit} (round ${candidate.value.round}) on ${candidate.value.base.slice(0, 12)}.` : blockerText(candidate.blocker) }], details: undefined };
      },
    });
  };

  pi.on("input", (event) => {
    lastInputSource = event.source;
    return undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    const opened = await options.openSession(ctx.cwd);
    if (!opened.ok) {
      session = undefined;
      return;
    }
    session = opened.value;
    runtime ??= await options.loadRuntime();
    registerTools(runtime);
    if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setEditorComponent(managedEditorFactory(runtime, () => void controller.toggleMode(ctx)));
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!session) return;
    if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setEditorComponent(undefined);
    ctx.ui.setStatus("radian", undefined);
    ctx.ui.setWidget("radian", undefined);
    const run = session.run;
    if (run) {
      // With live workers, leave the watcher fed by nothing: losing coordination stops owned work.
      if (run.coordinator.liveAssignments().length === 0) run.supervision.release();
      else run.supervision.dropHeartbeat();
      await run.lease.release();
    }
    session = undefined;
  });

  pi.on("tool_call", (event, ctx) => {
    if (!session) return undefined;
    const decision = guardToolCall(event, { projectRoot: session.repo.root, planningRoots: session.planningRoots, radianTools: new Set(RADIAN_TOOLS) }, ctx.cwd);
    return decision.block ? { block: true, reason: `[${decision.rule}] ${decision.reason}` } : undefined;
  });

  pi.registerToolRenderer(calmResolver(() => managed() && session!.calm.enabled, (text) => (runtime ? new runtime.Text(text, 0, 0) : text)));

  pi.registerCommand("radian", {
    description: "Radian coordinator: status, mode, calm, approvals, decisions, integration, pause/cancel, retrospectives",
    handler: async (args, ctx) => {
      const text = await controller.command(args, ctx);
      ctx.ui.notify(text, text.startsWith("BLOCKED") ? "warning" : "info");
    },
  });

  return controller;
}

function toPlan(session: ProjectSession, params: Record<string, unknown>): Outcome<AssignmentPlan> {
  const role = params.role as Role;
  if (!ROLES.includes(role)) return refuse("CONFIG_INVALID", "unknown role");
  const hash = (p: unknown): string | undefined => (typeof p === "string" ? artifactHash(session.repo.root, p) : undefined);
  const plan = hash(params.planPath);
  if (!plan) return refuse("APPROVAL_MISSING", "plan artifact is missing");
  const candidateCheck = params.candidateCheck === true;
  const base = typeof params.baseCandidate === "string" && /^[0-9a-f]{40,64}$/.test(params.baseCandidate) ? { kind: "commit" as const, commit: params.baseCandidate } : { kind: "target" as const };
  const writeRoots = candidateCheck ? [""] : role === "reviewer" || role === "scout" ? [] : ((params.writeRoots as string[] | undefined) ?? []);
  if (writeRoots.some((w) => w !== "" && !safeRelative(w))) return refuse("PATH_INVALID", "write roots must be repository-relative");
  const selection = typeof params.ruleId === "string" && typeof params.profile === "string" ? { rule: { id: params.ruleId, profile: params.profile, rationale: String(params.rationale ?? "") } } : {};
  const artifacts: AssignmentPlan["artifacts"] = { plan };
  const spec = hash(params.specPath);
  const brief = hash(params.briefPath);
  if (spec) artifacts.spec = spec;
  if (brief) artifacts.brief = brief;
  const out: AssignmentPlan = {
    task: String(params.task),
    role,
    purpose: candidateCheck ? "candidate-check" : "assignment",
    objective: String(params.objective),
    acceptanceCriteria: (params.acceptanceCriteria as string[] | undefined) ?? [],
    nonGoals: (params.nonGoals as string[] | undefined) ?? [],
    writeRoots,
    operations: ROLE_OPS[role],
    selection,
    newCandidateRound: params.newCandidateRound === true && role === "developer",
    base,
    artifacts,
  };
  if (Array.isArray(params.requiredChecks)) out.requiredChecks = params.requiredChecks as AssignmentPlan["requiredChecks"];
  return success(out);
}

function outcomeText(outcome: AssignmentOutcome): string {
  switch (outcome.state) {
    case "completed":
      return `Assignment ${outcome.assignment} completed: ${outcome.result.summary.slice(0, 300)}${outcome.delivery ? ` (delivery ${outcome.delivery.commit.slice(0, 12)})` : ""}; ${outcome.result.findings.length} finding(s).`;
    case "blocked":
      return `Assignment ${outcome.assignment ?? "(not created)"} blocked — ${outcome.blocker.code}: ${outcome.blocker.message}${outcome.decisionId ? ` (decision ${outcome.decisionId})` : ""}`;
    case "failed":
      return `Assignment ${outcome.assignment} failed: ${outcome.reason}; termination ${outcome.termination}.`;
  }
}

export function statusText(session: ProjectSession): string {
  const lines = [`Radian ${session.mode.mode.toUpperCase()} · project ${session.binding.project} · target ${session.target?.ref ?? "(not registered)"}${session.calm.enabled ? " · calm" : ""}`];
  const state = session.run?.store.state;
  if (!state) lines.push("No active run (/radian start).");
  else {
    lines.push(`Run ${state.run.id}: ${state.run.status} · harness ${state.run.harness.version}@${state.run.harness.revision.slice(0, 12)}`);
    for (const task of Object.values(state.tasks)) lines.push(`- task ${task.id} "${task.title}": ${task.phase}, round ${task.roundsUsed}/${task.maxRounds}`);
    for (const a of Object.values(state.assignments)) lines.push(`  - ${a.role} ${a.id}: ${a.status} (${a.profile.runtime}/${a.profile.model}/${a.profile.effort})`);
    const open = Object.values(state.decisions).filter((d) => d.status === "open");
    for (const d of open) lines.push(`  ? decision ${d.id} (${d.kind}): ${d.prompt.slice(0, 160)}`);
  }
  lines.push(capabilityText(session).split("\n")[0]!);
  return lines.join("\n");
}

export function capabilityText(session: ProjectSession): string {
  const registry = new CapabilityRegistry(session.project.state);
  const unverified = CAPABILITIES.filter((c) => registry.latest(c)?.status !== "verified");
  return `Runtime capabilities: ${CAPABILITIES.length - unverified.length}/${CAPABILITIES.length} with recorded verification evidence (version-bound; rechecked at every launch). Worker launches stay disabled until every required capability is verified.\n${unverified.map((c) => `  unverified: ${c}`).join("\n")}`;
}
