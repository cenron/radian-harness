// Radian's Pi coordinator interface. A thin integration layer over the
// coordinator services: it installs the managed editor (Shift+Tab Plan/Build),
// the Calm renderer, the coordinator tool guard, status/widgets, user commands,
// and model-callable tools. Approval, decision, integration, round-grant,
// recovery, and retrospective decisions are made only by the user and require
// an interactive terminal plus an explicit confirmation of the exact
// artifact/candidate; without an interactive UI they are refused. The
// coordinator may *request* the PRD/spec, plan ("start"), and integration
// decisions (proposal 0016): Radian renders that dialog from disk and records
// only the user's own choice. No tool can record a decision by itself.

import path from "node:path";
import { type Blocker, type Outcome, refuse, success } from "../contracts/blockers.ts";
import { type Operation } from "../contracts/authority.ts";
import { ROLES, type Role } from "../contracts/identity.ts";
import { isWithin, safeRelative } from "../contracts/paths.ts";
import { loadAndResolve } from "../config/resolve.ts";
import { CapacityLedger } from "../state/capacity.ts";
import { readJsonIfExists } from "../state/fsutil.ts";
import { loadRunDir } from "../state/run-store.ts";
import { readConfined } from "../util/confined-fs.ts";
import { type Discovery, type WorkspaceInfo, discover, loadWorkspace } from "../workspace/discovery.ts";
import { projectPaths, workspacePaths } from "../workspace/layout.ts";
import { createActivation, releaseViewLock } from "./activation.ts";
import { applyProjectPlan, planAddProject, planNewProject, recoverProjectOperation, renderProjectPlan } from "../workspace/projects.ts";
import { controlledGitEnv, gitArgv, locateGit } from "../git/exec.ts";
import { spawnSync } from "node:child_process";
import { type DelegateTools, READ_TOOL_NAMES, type ReadScope, readToolDefinitions } from "./read-tools.ts";
import { deliverNotice, processRuntime, takeInbox } from "./workspace-runtime.ts";
import type { AssignmentOutcome, AssignmentPlan } from "../coordinator/orchestrator.ts";
import { readMetrics } from "../coordinator/metrics.ts";
import { Retrospectives } from "../coordinator/retrospective.ts";
import type { Delivery } from "../git/delivery.ts";
import { git } from "../git/exec.ts";
import { type InspectRequest, inspectArgv } from "../git/inspect.ts";
import { succeeded } from "../util/proc.ts";
import { HumanChannel } from "../state/approvals.ts";
import { calmResolver } from "./calm.ts";
import { managedEditorFactory } from "./editor.ts";
import { guardToolCall } from "./guard.ts";
import type { HostBashOperations, HostContext, HostRuntime, HostToolDefinition, PiHost } from "./pi-host.ts";
import { PLANNING_DIR, type ProjectSession, artifactContent, artifactHash, shortHash } from "./session.ts";
import { CHOICE, artifactExcerpt, artifactTitle, coordinatorNote, openTasks, profileLines } from "./guided.ts";
import { parseCheckDefinitions } from "../coordinator/orchestrator.ts";
import { approvalValidity, requireApproval } from "../state/approvals.ts";
import { writeConfined } from "../util/confined-fs.ts";

export const RADIAN_TOOLS = ["radian_status", "radian_git_inspect", "radian_write_artifact", "radian_dispatch", "radian_assemble", "radian_request_approval", "radian_request_start", "radian_request_integration"] as const;

/** Bounded model-facing output for Git inspection. */
const INSPECT_MAX_TEXT = 64 * 1024;

export interface ControllerOptions {
  loadRuntime: () => Promise<HostRuntime>;
  /** Open a registered project's session from its root (direct entry or a workspace selection). */
  openSession: (projectRoot: string) => Promise<Outcome<ProjectSession>>;
  startRun: (session: ProjectSession) => Promise<Outcome<NonNullable<ProjectSession["run"]>>>;
  /** Actor label recorded on human decisions (private local state). */
  actorId?: string;
  /** Workspace discovery (tests may inject one). */
  discover?: (cwd: string) => Discovery;
}

const MODIFYING_OPS: Operation[] = ["read", "edit", "shell", "run-checks", "install-locked-dependencies", "deliver-changes", "write-report", "network-outbound"];
const ROLE_OPS: Record<Role, Operation[]> = {
  developer: MODIFYING_OPS,
  tester: MODIFYING_OPS,
  reviewer: ["read", "git-inspect", "write-report"],
  scout: ["read", "shell", "network-outbound", "write-report"],
};

/**
 * What this Pi extension runtime shows and may act on. A view is fixed for
 * the runtime's lifetime: selecting another project replaces the runtime.
 */
export type View =
  | { kind: "unmanaged" }
  | { kind: "blocked"; blocker: Blocker; workspaceRoot: string | undefined }
  | { kind: "dashboard"; workspace: WorkspaceInfo; generation: number }
  | { kind: "project"; project: ProjectSession; workspace: WorkspaceInfo | undefined; direct: boolean; generation: number; contextId?: string };

export interface RadianController {
  readonly session: () => ProjectSession | undefined;
  readonly view: () => View;
  readonly lastInputSource: () => string | undefined;
  toggleMode(ctx: HostContext): Promise<void>;
  command(args: string, ctx: HostContext): Promise<string>;
  projectsCommand(args: string, ctx: HostContext): Promise<string>;
  workspaceCommand(args: string, ctx: HostContext): Promise<string>;
  newProjectCommand(args: string, ctx: HostContext): Promise<string>;
  addProjectCommand(args: string, ctx: HostContext): Promise<string>;
}

function blockerText(b: Blocker): string {
  return `BLOCKED ${b.code}: ${b.message}${b.nextAction ? ` — ${b.nextAction}` : ""}`;
}

const NO_PROJECT = (what: string) => blockerText({ code: "NO_PROJECT_SELECTED", message: `${what} needs a selected project`, nextAction: "Select one with /projects, or create one with /new-project." });

/** The project and generation a call captured when it started. */
function projectOf(view: View): ProjectSession | undefined {
  return view.kind === "project" ? view.project : undefined;
}

function workspaceRootOf(view: View): string | undefined {
  if (view.kind === "dashboard") return view.workspace.root;
  if (view.kind === "project") return view.workspace?.root ?? view.project.binding.workspaceRoot;
  if (view.kind === "blocked") return view.workspaceRoot;
  return undefined;
}

export function registerRadian(pi: PiHost, options: ControllerOptions): RadianController {
  let view: View = { kind: "unmanaged" };
  let runtime: HostRuntime | undefined;
  let lastInputSource: string | undefined;
  let toolsRegistered = false;
  let skillRoots: string[] = [];
  const deliveries = new Map<string, Delivery>();
  const actor = options.actorId ?? "local-user";
  const discoverAt = options.discover ?? discover;

  const managed = () => view.kind === "project";
  const session = () => projectOf(view);

  /** A view is current while no other activation happened in this process since it started. */
  const current = (v: View): boolean => v.kind !== "dashboard" && v.kind !== "project" ? true : v.generation === processRuntime().generation;

  const updateStatus = (ctx: HostContext): void => {
    const v = view;
    if (v.kind === "unmanaged") return;
    if (v.kind === "blocked") {
      ctx.ui.setStatus("radian", `BLOCKED · ${v.blocker.code}`);
      ctx.ui.setWidget("radian", [`Radian workspace blocked: ${v.blocker.message}`, ...(v.blocker.nextAction ? [v.blocker.nextAction] : [])]);
      return;
    }
    const wsName = v.kind === "dashboard" ? path.basename(v.workspace.root) : v.workspace ? path.basename(v.workspace.root) : undefined;
    if (v.kind === "dashboard") {
      ctx.ui.setStatus("radian", `WORKSPACE · no project selected${wsName ? ` · ${wsName}` : ""}`);
      ctx.ui.setWidget("radian", [`Workspace ${wsName}: ${v.workspace.projects.length} registered project(s). /projects to list or select, /new-project to create.`]);
      void capacityLine(v.workspace.root).then((cap) => {
        if (view === v) ctx.ui.setStatus("radian", `WORKSPACE · no project selected${wsName ? ` · ${wsName}` : ""} · ${cap}`);
      });
      return;
    }
    const s = v.project;
    const mode = s.mode.mode.toUpperCase();
    const live = s.run?.coordinator.liveAssignments() ?? [];
    const calm = s.calm.enabled ? " · calm" : "";
    const label = v.workspace ? ` · ${projectLabel(v.workspace, s.binding.project)}` : "";
    const base = `${mode}${label}${live.length ? ` · ${live.length} live worker(s)` : ""}${calm}`;
    ctx.ui.setStatus("radian", base);
    void capacityLine(s.binding.workspaceRoot).then((cap) => {
      if (view === v) ctx.ui.setStatus("radian", `${base} · ${cap}`);
    });
    const lines: string[] = [];
    const state = s.run?.store.state;
    if (state) {
      for (const task of Object.values(state.tasks)) lines.push(`task ${task.id}: ${task.phase}, round ${task.roundsUsed}/${task.maxRounds}`);
      for (const a of Object.values(state.assignments)) {
        if (["retired", "cancelled"].includes(a.status)) continue;
        lines.push(`  ${a.role} ${a.id}: ${a.status}`);
      }
      for (const d of Object.values(state.decisions)) if (d.status === "open") lines.push(`decision ${d.id}: ${d.prompt.slice(0, 120)}`);
    }
    ctx.ui.setWidget("radian", lines.length ? lines : undefined);
  };

  /** Explicit human confirmation from an interactive terminal; never fabricated, and refused if the view changed meanwhile. */
  const humanConfirm = async (v: View, ctx: HostContext, title: string, details: string, origin: string): Promise<Outcome<HumanChannel>> => {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      return refuse("NONINTERACTIVE_APPROVAL_REQUIRED", "this decision requires an interactive Pi terminal", "Open the project in interactive Pi and run the command there.");
    }
    if (lastInputSource !== undefined && lastInputSource !== "interactive") {
      return refuse("APPROVAL_NOT_HUMAN", "decisions must come from interactive user input, not RPC or extension input");
    }
    const confirmed = await ctx.ui.confirm(title, details);
    if (!current(v)) return refuse("STALE_GENERATION", "the selected project changed while the confirmation was open; nothing was recorded", "Select the project again and repeat the command.");
    if (!confirmed) return refuse("APPROVAL_MISSING", "the user declined");
    return success(HumanChannel.fromUserInput("user-ui", actor, origin));
  };

  /**
   * A guided decision the coordinator requested (proposal 0016). The dialog
   * text is built by Radian; Cancel is the initial selection, so Enter alone
   * or Escape records nothing. One dialog at a time; a declined request is not
   * reopened until the user's next own input.
   */
  let guidedOpen = false;
  const declined = new Set<string>();
  type Guided = { kind: "approved"; channel: HumanChannel } | { kind: "changes"; note: string } | { kind: "declined" };
  const guidedPrecheck = (ctx: HostContext): Outcome<true> => {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      return refuse("NONINTERACTIVE_APPROVAL_REQUIRED", "this decision requires an interactive Pi terminal", "Ask the user to open the project in interactive Pi.");
    }
    if (lastInputSource !== undefined && lastInputSource !== "interactive") {
      return refuse("APPROVAL_NOT_HUMAN", "decisions must follow the user's own interactive input, not RPC or extension input");
    }
    if (guidedOpen) return refuse("DECISION_OPEN", "another Radian decision dialog is already open", "Wait for the user to answer it.");
    return success(true);
  };
  const guidedDecision = async (v: View, ctx: HostContext, request: { key: string; title: string; body: string[]; approve: string; view?: () => string; origin: string }): Promise<Outcome<Guided>> => {
    const ready = guidedPrecheck(ctx);
    if (!ready.ok) return ready;
    if (declined.has(request.key)) return refuse("APPROVAL_MISSING", "the user declined this request; it is not reopened until they reply", "Ask the user what they want changed, then request again.");
    guidedOpen = true;
    try {
      const options = [CHOICE.cancel, ...(request.view ? [CHOICE.view] : []), CHOICE.changes, request.approve];
      const text = [request.title, "", ...request.body].join("\n");
      for (;;) {
        const choice = await ctx.ui.select(text, options);
        if (!current(v)) return refuse("STALE_GENERATION", "the selected project changed while the dialog was open; nothing was recorded", "Select the project again and repeat the request.");
        if (choice === CHOICE.view && request.view) {
          await ctx.ui.select(request.view(), ["Back"]);
          if (!current(v)) return refuse("STALE_GENERATION", "the selected project changed while the dialog was open; nothing was recorded", "Select the project again and repeat the request.");
          continue;
        }
        if (choice === request.approve) return success({ kind: "approved", channel: HumanChannel.fromUserInput("user-ui", actor, request.origin) });
        if (choice === CHOICE.changes) {
          const note = (await ctx.ui.input?.("What should change?", "Describe the change"))?.trim() ?? "";
          if (!current(v)) return refuse("STALE_GENERATION", "the selected project changed while the dialog was open; nothing was recorded", "Select the project again and repeat the request.");
          return success({ kind: "changes", note });
        }
        declined.add(request.key);
        return success({ kind: "declined" });
      }
    } finally {
      guidedOpen = false;
    }
  };

  /** Shared wording for a guided result that did not approve. */
  const notApproved = (result: Guided, what: string): string =>
    result.kind === "changes" ? `The user requested changes to the ${what}; nothing was recorded. Their note: ${result.note || "(none given; ask them)"}` : `The user did not approve the ${what}; nothing was recorded. Ask what they want before requesting again.`;

  /** The approved spec or brief currently backing a task, if any. */
  const currentRequirement = (s: ProjectSession, state: NonNullable<ProjectSession["run"]>["store"]["state"], task: string): Outcome<{ kind: "spec" | "brief"; path: string; hash: string }> => {
    let stale: string | undefined;
    for (const kind of ["spec", "brief"] as const) {
      const latest = Object.values(state.approvals).filter((a) => a.task === task && a.kind === kind).at(-1);
      if (!latest) continue;
      const hash = artifactHash(s.repo.root, latest.artifact.path);
      const validity = approvalValidity(state, { task, kind }, { artifactHash: hash ?? "" });
      if (validity.state === "valid") return success({ kind, path: latest.artifact.path, hash: latest.artifact.hash });
      if (validity.state === "stale") stale = `${kind} approval is stale: ${validity.reason}`;
    }
    return stale ? refuse("APPROVAL_STALE", stale, "Request a new PRD approval with radian_request_approval.") : refuse("APPROVAL_MISSING", "the task has no approved PRD/spec or brief", "Request one with radian_request_approval first.");
  };

  const requireRun = async (s: ProjectSession): Promise<Outcome<NonNullable<ProjectSession["run"]>>> => (s.run ? success(s.run) : options.startRun(s));

  const setMode = async (v: View, ctx: HostContext, mode: "plan" | "build"): Promise<string> => {
    const s = projectOf(v);
    if (!s) return NO_PROJECT("Plan/Build mode");
    const previous = s.mode.mode;
    s.mode.set(mode);
    let note = "";
    if (mode === "plan" && previous === "build") {
      const live = (s.run?.coordinator.liveAssignments() ?? []).filter((a) => a.role === "developer" || a.role === "tester");
      if (live.length > 0) {
        if (ctx.mode === "tui" && ctx.hasUI && (await ctx.ui.confirm("Pause live modifying workers?", `${live.length} worker(s) are still running. Plan mode already blocks new modifying dispatch. Pausing stops them and preserves their work.`))) {
          for (const worker of live) await s.run!.coordinator.pause(worker.assignment, "user switched to Plan");
          note = ` Paused ${live.length} worker(s); their work is preserved.`;
        } else {
          note = ` ${live.length} modifying worker(s) are still running; Plan only blocks new dispatch.`;
        }
      }
    }
    updateStatus(ctx);
    return `Mode: ${mode.toUpperCase()} for ${s.binding.project}. Mode changes never approve or start work.${note}`;
  };

  const controller: RadianController = {
    session,
    view: () => view,
    lastInputSource: () => lastInputSource,
    async toggleMode(ctx) {
      const v = view;
      const s = projectOf(v);
      if (!s) return;
      const message = await setMode(v, ctx, s.mode.mode === "plan" ? "build" : "plan");
      ctx.ui.notify(message, "info");
    },
    async command(args, ctx) {
      const v = view;
      if (v.kind === "unmanaged") return "Radian is inactive: this directory is not a Radian workspace or registered project.";
      if (v.kind === "blocked") return blockerText(v.blocker);
      const words = args.trim().split(/\s+/).filter(Boolean);
      const [sub = "status", ...rest] = words;
      const s = projectOf(v);
      if (!s) {
        if (sub === "status") return workspaceStatusText(v.kind === "dashboard" ? v.workspace : undefined);
        return NO_PROJECT(`/radian ${sub}`);
      }
      switch (sub) {
        case "status":
          return statusText(s);
        case "mode": {
          const target = rest[0];
          if (target !== "plan" && target !== "build") return `Mode: ${s.mode.mode.toUpperCase()} (use /radian mode plan|build or Shift+Tab)`;
          return setMode(v, ctx, target);
        }
        case "calm": {
          const value = rest[0] === "on" ? true : rest[0] === "off" ? false : !s.calm.enabled;
          s.calm.set(value);
          updateStatus(ctx);
          return `Calm ${value ? "on" : "off"}: presentation only — execution, context, approvals, and logs are unchanged.`;
        }
        case "start": {
          const run = await requireRun(s);
          return run.ok ? `Run ${run.value.store.state.run.id} is active.` : blockerText(run.blocker);
        }
        case "task": {
          if (rest[0] !== "add" || rest.length < 2) return "Usage: /radian task add <title>";
          const run = await requireRun(s);
          if (!run.ok) return blockerText(run.blocker);
          const before = new Set(Object.keys(run.value.store.state.tasks));
          const added = await run.value.store.addTask(rest.slice(1).join(" "), s.config.harness.assignment.candidateRounds);
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
          const run = await requireRun(s);
          if (!run.ok) return blockerText(run.blocker);
          const hash = artifactHash(s.repo.root, artifact);
          if (!hash) return `BLOCKED APPROVAL_MISSING: artifact ${artifact} is missing`;
          let details = `${sub === "approve" ? "Approve" : "Reject"} ${kind} for task ${task} in project ${s.binding.project}\nartifact ${artifact} (content ${shortHash(hash)})`;
          let integration: { candidate: { commit: string; tree: string; base: string }; target: { ref: string; commit: string } } | undefined;
          if (kind === "integration") {
            const summary = await run.value.coordinator.integrationSummary(task, run.value.coordinator.evidence(task).requiredChecks ?? []);
            if (!summary.ok) return blockerText(summary.blocker);
            integration = { candidate: summary.value.candidate, target: summary.value.target };
            details += `\ncandidate ${summary.value.candidate.commit.slice(0, 12)} onto ${summary.value.target.ref} at ${summary.value.target.commit.slice(0, 12)}\nchecks: ${summary.value.checks.map((c) => `${c.id}=${c.outcome}`).join(", ") || "none"}\nreview: ${summary.value.review ? `${summary.value.review.blockingFindings} blocking of ${summary.value.review.findings}` : "none"}\nrisks: ${summary.value.risks.join("; ") || "none"}\ngaps: ${summary.value.gaps.join("; ") || "none"}`;
            if (sub === "approve" && !summary.value.ready) return `BLOCKED CANDIDATE_MISMATCH: not ready for integration (${summary.value.gaps.join("; ")})`;
          }
          const channel = await humanConfirm(v, ctx, `Radian ${sub} ${kind}`, details, `/radian ${sub} ${kind}`);
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
          const run = await requireRun(s);
          if (!run.ok) return blockerText(run.blocker);
          const decision = run.value.store.state.decisions[decisionId];
          if (!decision) return "BLOCKED INVALID_TRANSITION: unknown decision";
          const channel = await humanConfirm(v, ctx, "Radian decision", `${decision.prompt}\n\nAnswer: ${answer.join(" ")}`, "/radian decide");
          if (!channel.ok) return blockerText(channel.blocker);
          const resolved = await run.value.store.resolveDecision(channel.value, decisionId, answer.join(" "));
          updateStatus(ctx);
          return resolved.ok ? `Decision ${decisionId} resolved. Resume starts a fresh attempt.` : blockerText(resolved.blocker);
        }
        case "integrate": {
          const [task] = rest;
          if (!task) return "Usage: /radian integrate <task>";
          const run = await requireRun(s);
          if (!run.ok) return blockerText(run.blocker);
          const evidence = run.value.coordinator.evidence(task);
          const required = evidence.requiredChecks ?? [];
          if (required.length === 0) return "BLOCKED CANDIDATE_MISMATCH: no required checks were recorded for this task";
          const approval = Object.values(run.value.store.state.approvals).filter((a) => a.task === task && a.kind === "integration" && a.decision === "approved").at(-1);
          if (!approval) return "BLOCKED APPROVAL_MISSING: integration approval is required (/radian approve integration ...)";
          const channel = await humanConfirm(v, ctx, "Radian integrate", `Fast-forward ${s.target?.ref ?? "target"} of project ${s.binding.project} to the approved candidate for ${task}?`, "/radian integrate");
          if (!channel.ok) return blockerText(channel.blocker);
          const integrated = await run.value.coordinator.integrate(channel.value, task, required, { path: approval.artifact.path });
          updateStatus(ctx);
          return integrated.ok ? `Integrated ${task}: ${integrated.value.from.slice(0, 12)} → ${integrated.value.to.slice(0, 12)}.` : blockerText(integrated.blocker);
        }
        case "pause":
        case "cancel": {
          const [assignment] = rest;
          if (!assignment) return `Usage: /radian ${sub} <assignment>`;
          const run = await requireRun(s);
          if (!run.ok) return blockerText(run.blocker);
          const done = sub === "pause" ? await run.value.coordinator.pause(assignment, "user request") : await run.value.coordinator.cancel(assignment);
          updateStatus(ctx);
          return done.ok ? `${sub === "pause" ? "Paused" : "Cancelled"} ${assignment}; termination ${done.value.termination}. Work is preserved.` : blockerText(done.blocker);
        }
        case "grant-rounds":
        case "authorize-recovery": {
          const [target, n] = rest;
          if (!target) return `Usage: /radian ${sub} <${sub === "grant-rounds" ? "task> <n" : "assignment"}>`;
          const run = await requireRun(s);
          if (!run.ok) return blockerText(run.blocker);
          const channel = await humanConfirm(v, ctx, `Radian ${sub}`, sub === "grant-rounds" ? `Grant ${n ?? "1"} more candidate round(s) to ${target}?` : `Authorize one more attempt for ${target}?`, `/radian ${sub}`);
          if (!channel.ok) return blockerText(channel.blocker);
          const decisionId = `dec_${sub}-${Date.now()}`;
          const done = sub === "grant-rounds" ? await run.value.store.grantRounds(channel.value, target, Number(n ?? "1"), decisionId) : await run.value.store.authorizeRecovery(channel.value, target, decisionId);
          return done.ok ? `Recorded human decision ${decisionId}.` : blockerText(done.blocker);
        }
        case "retro": {
          const run = await requireRun(s);
          if (!run.ok) return blockerText(run.blocker);
          const retros = new Retrospectives(s.project.state);
          if (rest[0] === "decide") {
            const [, id, verdict, ...note] = rest;
            if (!id || (verdict !== "approve" && verdict !== "reject")) return "Usage: /radian retro decide <id> approve|reject [note]";
            const channel = await humanConfirm(v, ctx, "Radian retrospective decision", `${verdict} retrospective ${id}? Approval only schedules a separate harness task.`, "/radian retro decide");
            if (!channel.ok) return blockerText(channel.blocker);
            const decided = retros.decide(channel.value, id, verdict === "approve" ? "approved-for-separate-task" : "rejected", note.join(" ") || "no note");
            return decided.ok ? `Retrospective ${id}: ${decided.value.status}.` : blockerText(decided.blocker);
          }
          const records = readMetrics(path.join(s.project.state, "metrics", "events.jsonl"));
          const created = retros.create(records, { problem: "On-demand review of recent runs", change: "To be written by the user from the evidence below", expectedBenefit: "n/a until specified", regressionRisk: "n/a until specified", evaluation: "Compare per-version summaries on comparable tasks", rollback: "Do not adopt; keep the current harness version" });
          return created.ok ? `Retrospective ${created.value.id} written privately (${created.value.observations.length} observation(s)); status proposed.` : blockerText(created.blocker);
        }
        default:
          return "Radian commands: status, mode plan|build, calm on|off, start, task add <title>, approve|reject <kind> <task> <path>, decide <id> <answer>, integrate <task>, pause|cancel <assignment>, grant-rounds <task> <n>, authorize-recovery <assignment>, retro [decide …]. Workspace: /projects, /workspace, /new-project, /add-project.";
      }
    },
    async projectsCommand(args, ctx) {
      const v = view;
      if (v.kind === "unmanaged") return "Radian is inactive here.";
      // Navigation stays available from a conversation whose project became unavailable (the workspace itself is valid).
      if (v.kind === "blocked" && (!v.workspaceRoot || !loadWorkspace(v.workspaceRoot).ok)) return blockerText(v.blocker);
      const root = workspaceRootOf(v)!;
      const loaded = loadWorkspace(root);
      if (!loaded.ok) return blockerText(loaded.blocker);
      const name = args.trim();
      if (!name) return projectListText(loaded.value, projectOf(v)?.binding.project);
      return selectProject(v, loaded.value, name, ctx);
    },
    async newProjectCommand(args, ctx) {
      const v = view;
      const root = setupRoot(v);
      if (!root.ok) return blockerText(root.blocker);
      const words = args.trim().split(/\s+/).filter(Boolean);
      if (words[0] === "--recover") {
        const recovered = await recoverProjectOperation(root.value);
        if (!recovered.ok) return blockerText(recovered.blocker);
        return recovered.value ? `Recovered: ${recovered.value.name} is registered (${recovered.value.target}). Select it with /projects ${recovered.value.name}.` : "No interrupted project operation.";
      }
      const name = words[0];
      const branchAt = words.indexOf("--branch");
      const branch = branchAt >= 0 ? words[branchAt + 1] : undefined;
      if (!name || name.startsWith("--") || (branchAt >= 0 && !branch)) return "Usage: /new-project <name> [--branch <branch>]   (or /new-project --recover)";
      const planned = planNewProject(root.value, name, branch ? { branch } : {});
      if (!planned.ok) return blockerText(planned.blocker);
      const confirmed = await setupConfirm(v, ctx, "Create project", renderProjectPlan(planned.value));
      if (!confirmed.ok) return blockerText(confirmed.blocker);
      const applied = await applyProjectPlan(planned.value, planned.value.hash);
      if (!applied.ok) return blockerText(applied.blocker);
      return activateAfterSetup(v, root.value, applied.value.name, `Created ${applied.value.name} (${applied.value.target} at ${applied.value.commit?.slice(0, 12)}) and registered it.`, ctx);
    },
    async addProjectCommand(args, ctx) {
      const v = view;
      const root = setupRoot(v);
      if (!root.ok) return blockerText(root.blocker);
      const words = args.trim().split(/\s+/).filter(Boolean);
      const input = words[0];
      const targetAt = words.indexOf("--target");
      let target = targetAt >= 0 ? words[targetAt + 1] : undefined;
      if (!input || input.startsWith("--") || (targetAt >= 0 && !target)) return "Usage: /add-project <path> --target refs/heads/<branch>";
      if (!target) {
        // An existing repository needs an explicit, commit-backed protected target: ask, never assume.
        const branches = await localBranches(path.resolve(root.value, input));
        if (!ctx.hasUI || branches.length === 0) return blockerText({ code: "CONFIG_INVALID", message: "an explicit protected target branch is required", nextAction: "Pass --target refs/heads/<branch>; Radian never assumes main for an existing repository." });
        const choice = await ctx.ui.select("Protected target branch for " + input, branches);
        if (!choice) return "Cancelled; nothing was registered.";
        target = choice;
      }
      const planned = await planAddProject(root.value, input, target);
      if (!planned.ok) return blockerText(planned.blocker);
      const confirmed = await setupConfirm(v, ctx, "Register project", renderProjectPlan(planned.value));
      if (!confirmed.ok) return blockerText(confirmed.blocker);
      const applied = await applyProjectPlan(planned.value, planned.value.hash);
      if (!applied.ok) return blockerText(applied.blocker);
      return activateAfterSetup(v, root.value, applied.value.name, `Registered ${applied.value.name} with protected target ${applied.value.target}.`, ctx);
    },
    async workspaceCommand(_args, ctx) {
      const v = view;
      if (v.kind === "unmanaged") return "Radian is inactive here.";
      if (v.kind === "blocked" && (!v.workspaceRoot || !loadWorkspace(v.workspaceRoot).ok)) return blockerText(v.blocker);
      if (v.kind === "dashboard") return workspaceStatusText(v.workspace);
      return returnToDashboard(v, ctx);
    },
  };

  /** Workspace-level setup commands need a valid workspace (not direct entry, not an invalid workspace). */
  const setupRoot = (v: View): Outcome<string> => {
    if (v.kind === "unmanaged") return refuse("WORKSPACE_BLOCKED", "Radian is inactive here");
    if (v.kind === "project" && v.direct) return refuse("SESSION_BUSY", "project setup runs from the workspace root", "Start Pi at the workspace root.");
    const root = workspaceRootOf(v);
    if (!root) return refuse("WORKSPACE_BLOCKED", "no workspace is available here");
    const loaded = loadWorkspace(root);
    return loaded.ok ? success(root) : refuse(loaded.blocker.code, loaded.blocker.message);
  };

  /**
   * Explicit confirmation of an exact setup plan from the user's own interface
   * (interactive terminal or an RPC client's dialog), never from extension
   * input. Setup is not a product approval and starts no work.
   */
  const setupConfirm = async (v: View, ctx: HostContext, title: string, details: string): Promise<Outcome<true>> => {
    if (!ctx.hasUI) return refuse("NONINTERACTIVE_APPROVAL_REQUIRED", "project setup must be confirmed in Pi's interface");
    if (lastInputSource === "extension") return refuse("APPROVAL_NOT_HUMAN", "project setup must come from your own input, not an extension");
    const confirmed = await ctx.ui.confirm(title, details);
    if (!current(v)) return refuse("STALE_GENERATION", "the view changed while the confirmation was open; nothing was changed");
    return confirmed ? success(true) : refuse("APPROVAL_MISSING", "not confirmed; nothing was changed");
  };

  /** Request activation only after a successful registration; a failed activation keeps the project. */
  const activateAfterSetup = async (v: View, root: string, name: string, done: string, ctx: HostContext): Promise<string> => {
    const loaded = loadWorkspace(root);
    if (!loaded.ok) return `${done} Activation was not attempted: ${loaded.blocker.message}`;
    const result = await activation.select(v, loaded.value, name, ctx);
    if (result === "") return "";
    return `${done} It was not activated: ${result.replace(/^BLOCKED /, "")} Select it later with /projects ${name}.`;
  };

  /** Selecting another project replaces the conversation (W05). */
  const selectProject = async (v: View, ws: WorkspaceInfo, name: string, ctx: HostContext): Promise<string> => activation.select(v, ws, name, ctx);
  const returnToDashboard = async (v: View, ctx: HostContext): Promise<string> => activation.dashboard(v, ctx);

  const activation = createActivation({
    pi,
    options,
    viewOf: () => view,
    blockerText,
  });

  /** The read scope captured at the start of a tool call. */
  const scopeAt = (): Outcome<ReadScope> => {
    const v = view;
    if (v.kind === "project") return success({ kind: "project", root: v.project.repo.root, deny: [], skillRoots });
    if (v.kind === "dashboard") return success({ kind: "dashboard", root: v.workspace.root, deny: [path.join(v.workspace.root, ".radian")], skillRoots });
    if (v.kind === "blocked") return refuse("WORKSPACE_BLOCKED", v.blocker.message);
    return refuse("PROJECT_UNAVAILABLE", "Radian is inactive here");
  };

  const toolText = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });

  const registerTools = (rt: HostRuntime): void => {
    if (toolsRegistered) return;
    toolsRegistered = true;
    const T = rt.Type;
    pi.registerTool({
      name: "radian_status",
      label: "Radian status",
      description: "Read Radian's status: the workspace and its projects when no project is selected, otherwise the selected project's run, tasks, assignments, and decisions. Read-only.",
      parameters: T.Object({}),
      execute: async () => {
        const v = view;
        const s = projectOf(v);
        return toolText(s ? statusText(s) : v.kind === "dashboard" ? workspaceStatusText(v.workspace) : v.kind === "blocked" ? blockerText(v.blocker) : "Radian inactive.");
      },
    });
    pi.registerTool({
      name: "radian_git_inspect",
      label: "Inspect Git (read-only)",
      description: "Read-only Git inspection of the selected project: status, log, diff, or show. Revisions must be exact commit ids (use log to find them); paths are repository-relative. Runs a fixed argument vector with hooks, pagers, external diff, textconv, filters, and fsmonitor disabled. There is no shell.",
      parameters: T.Object({
        op: T.Union(["status", "log", "diff", "show"].map((op) => T.Literal(op))),
        from: T.Optional(T.String({ description: "diff: exact commit id" })),
        to: T.Optional(T.String({ description: "diff: exact commit id (default: working tree)" })),
        paths: T.Optional(T.Array(T.String(), { description: "diff: repository-relative paths" })),
        rev: T.Optional(T.String({ description: "log/show: exact commit id" })),
        path: T.Optional(T.String({ description: "show: repository-relative file at rev" })),
        max: T.Optional(T.Number({ description: "log: 1-200 entries (default 20)" })),
      }),
      execute: async (_id, params) => {
        const s = session();
        if (!s) throw new Error(NO_PROJECT("radian_git_inspect"));
        const request = inspectRequest(params);
        if (!request.ok) return toolText(blockerText(request.blocker));
        const argv = inspectArgv(request.value);
        if (!argv.ok) return toolText(blockerText(argv.blocker));
        const result = await git(s.repo.ctx, argv.value, { timeoutMs: 15_000, maxOutputBytes: 4 * 1024 * 1024 });
        if (!succeeded(result)) return toolText(`BLOCKED GIT_FAILURE: git ${request.value.op} did not complete (${result.timedOut ? "timed out" : result.outputLimitExceeded ? "output too large" : `exit ${result.code}`})`);
        const text = result.stdout.toString("utf8");
        return toolText(text.length > INSPECT_MAX_TEXT ? `${text.slice(0, INSPECT_MAX_TEXT)}\n[truncated: narrow the paths or revisions]` : text || "(no output)");
      },
    });
    pi.registerTool({
      name: "radian_write_artifact",
      label: "Write planning artifact",
      description: "Write a PRD/spec, brief, or plan draft under the selected project's .radian/planning/ for human review. Writing never approves it; ask the user to decide with radian_request_approval (PRD/spec or brief) or radian_request_start (plan).",
      parameters: T.Object({ path: T.String({ description: "Path relative to .radian/planning/" }), content: T.String() }),
      execute: async (_id, params) => {
        const s = session();
        if (!s) throw new Error(NO_PROJECT("radian_write_artifact"));
        const relative = String(params.path ?? "");
        if (!safeRelative(relative)) throw new Error("path must be relative inside .radian/planning/");
        // Kernel-enforced: no link anywhere from the project root to the destination (src/util/confined-fs.ts).
        const written = writeConfined(s.repo.root, `${PLANNING_DIR.split(path.sep).join("/")}/${relative}`, String(params.content ?? ""));
        if (!written.ok) throw new Error(blockerText(written.blocker));
        return toolText(`Wrote ${path.join(".radian", "planning", relative)} in project ${s.binding.project} (draft; not approved until the user approves it in a Radian dialog).`);
      },
    });
    pi.registerTool({
      name: "radian_dispatch",
      label: "Dispatch a worker",
      description: "Dispatch a registered worker assignment for an approved task in the selected project. Requires Build mode for modifying roles, current approvals, healthy supervision, capacity, and verified runtime capabilities; otherwise returns a blocker. Runs in the background and reports its outcome to that project.",
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
        checkOutputRoots: T.Optional(T.Array(T.String(), { description: "candidate checks: untracked build/output directories the check may write; source, tests, and config stay read-only" })),
        requiredChecks: T.Optional(T.Array(T.Object({ id: T.String(), description: T.String(), argv: T.Array(T.String()) }))),
        newCandidateRound: T.Optional(T.Boolean({ description: "Ignored (legacy). Candidate cycles are derived from the task's durable state: work after an assembled candidate starts the next cycle." })),
        baseCandidate: T.Optional(T.String()),
        ruleId: T.Optional(T.String()),
        profile: T.Optional(T.String()),
        rationale: T.Optional(T.String()),
      }),
      execute: async (_id, params) => {
        const s = session();
        if (!s) return toolText(NO_PROJECT("radian_dispatch"));
        const run = await requireRun(s);
        if (!run.ok) return toolText(blockerText(run.blocker));
        const planned = toPlan(s, params);
        if (!planned.ok) return toolText(blockerText(planned.blocker));
        const owner = { workspaceRoot: s.binding.workspaceRoot, project: s.binding.project };
        void run.value.coordinator.runAssignment(planned.value).then((outcome) => {
          const text = outcomeText(outcome);
          if (outcome.state === "completed") {
            if (outcome.delivery) deliveries.set(outcome.assignment, outcome.delivery);
            if (planned.value.role === "reviewer" && planned.value.base.kind === "commit") run.value.coordinator.recordReview(planned.value.task, planned.value.base.commit, outcome.result);
          }
          deliverNotice({ ...owner, text, level: outcome.state === "completed" ? "info" : "warning" });
        });
        return toolText(`Dispatch requested for ${planned.value.role} on ${planned.value.task} in project ${s.binding.project}; the outcome will be reported to that project.`);
      },
    });
    pi.registerTool({
      name: "radian_assemble",
      label: "Assemble candidate",
      description: "Combine completed developer/tester deliveries for a task in the selected project into one exact candidate.",
      parameters: T.Object({ task: T.String(), assignments: T.Array(T.String()), mergeBase: T.String() }),
      execute: async (_id, params) => {
        const s = session();
        if (!s) return toolText(NO_PROJECT("radian_assemble"));
        const run = await requireRun(s);
        if (!run.ok) return toolText(blockerText(run.blocker));
        const list = (params.assignments as string[]).map((a) => deliveries.get(a));
        if (list.some((d) => d === undefined)) return toolText("BLOCKED CANDIDATE_MISMATCH: unknown delivery");
        const candidate = await run.value.coordinator.assemble(String(params.task), list as Delivery[], String(params.mergeBase));
        return toolText(candidate.ok ? `Candidate ${candidate.value.commit} (round ${candidate.value.round}) on ${candidate.value.base.slice(0, 12)}.` : blockerText(candidate.blocker));
      },
    });
    const STALE_DURING_DIALOG = (what: string) => toolText(blockerText({ code: "APPROVAL_STALE", message: `the ${what} changed while the dialog was open; nothing was recorded`, nextAction: "Request the decision again so the user sees the current content." }));
    const displayArg = (a: string) => (/[\s"'\\]/.test(a) || a === "" ? JSON.stringify(a) : a);
    const labelOf = (v: View, s: ProjectSession) => (v.kind === "project" && v.workspace ? projectLabel(v.workspace, s.binding.project) : s.binding.project);
    pi.registerTool({
      name: "radian_request_approval",
      label: "Request PRD approval",
      description: "Ask the user to approve a PRD/spec or brief draft in a Radian dialog. Radian shows the file, its content hash, and the task; only the user's choice records an approval. If the project has no open task for this work, approval creates one titled from the draft. With open tasks, pass `task` (an id from radian_status) or `newTask: true`. Never invent task ids.",
      exposure: "model-only",
      parameters: T.Object({
        kind: T.Union([T.Literal("spec"), T.Literal("brief")]),
        path: T.String({ description: "Repository-relative path, for example .radian/planning/spec.md" }),
        task: T.Optional(T.String({ description: "Existing task id from radian_status" })),
        newTask: T.Optional(T.Boolean({ description: "Create a new task even though other tasks are open" })),
        title: T.Optional(T.String({ description: "Title for a new task (default: the draft's first heading)" })),
        lightweight: T.Optional(T.Boolean({ description: "brief only: the lightweight-brief path for a small fix" })),
        note: T.Optional(T.String({ description: "Short note shown to the user, labelled as yours" })),
      }),
      execute: async (_id, params, _signal, _update, ctx) => {
        const v = view;
        const s = projectOf(v);
        if (!s) return toolText(NO_PROJECT("radian_request_approval"));
        const ready = guidedPrecheck(ctx);
        if (!ready.ok) return toolText(blockerText(ready.blocker));
        const kind = params.kind === "spec" || params.kind === "brief" ? params.kind : undefined;
        if (!kind) return toolText(blockerText({ code: "CONFIG_INVALID", message: "kind must be spec or brief" }));
        const relative = String(params.path ?? "");
        if (!safeRelative(relative)) return toolText("BLOCKED PATH_INVALID: artifact path must be repository-relative");
        const content = artifactContent(s.repo.root, relative);
        const hash = artifactHash(s.repo.root, relative);
        if (content === undefined || !hash) return toolText(`BLOCKED APPROVAL_MISSING: artifact ${relative} is missing or unreadable`);
        const run = await requireRun(s);
        if (!run.ok) return toolText(blockerText(run.blocker));
        const state = run.value.store.state;
        const open = openTasks(state);
        const listed = open.map((t) => `${t.id} "${t.title}"`).join(", ");
        let task: { id: string | undefined; title: string };
        if (typeof params.task === "string" && params.task !== "") {
          const known = state.tasks[params.task];
          if (!known) return toolText(blockerText({ code: "INVALID_TRANSITION", message: `unknown task '${params.task}'`, nextAction: open.length ? `Use one of: ${listed}; or pass newTask: true.` : "Omit task: approval creates it." }));
          task = { id: known.id, title: known.title };
        } else {
          if (open.length > 0 && params.newTask !== true) return toolText(blockerText({ code: "TASK_REQUIRED", message: `this project has open tasks (${listed}); name the task this draft belongs to`, nextAction: "Pass task: <id>, or newTask: true for separate work." }));
          const given = typeof params.title === "string" ? artifactTitle(`# ${params.title}`, relative) : undefined;
          task = { id: undefined, title: given ?? artifactTitle(content, relative) };
        }
        const lightweight = kind === "brief" && params.lightweight === true;
        const decision = await guidedDecision(v, ctx, {
          key: `approval:${kind}:${relative}:${hash}:${task.id ?? "new"}`,
          title: `Radian · approve ${kind === "spec" ? "PRD/spec" : "brief"} · project ${labelOf(v, s)}`,
          body: [
            task.id ? `Task: "${task.title}" (${task.id})` : `Task: creates task "${task.title}"`,
            `File: ${relative} · content ${shortHash(hash)} · ${Buffer.byteLength(content)} bytes · ${content.split(/\r?\n/).length} lines`,
            ...(lightweight ? ["Path: lightweight brief for a small fix"] : []),
            ...coordinatorNote(params.note),
            "",
            "Approve records your decision for exactly this content; any later edit makes it stale.",
          ],
          approve: CHOICE.approve,
          view: () => `${relative} (content ${shortHash(hash)})\n\n${artifactExcerpt(content)}`,
          origin: "radian_request_approval",
        });
        if (!decision.ok) return toolText(blockerText(decision.blocker));
        if (decision.value.kind !== "approved") return toolText(notApproved(decision.value, kind === "spec" ? "PRD/spec" : "brief"));
        if (artifactHash(s.repo.root, relative) !== hash) return STALE_DURING_DIALOG(relative);
        let taskId = task.id;
        if (!taskId) {
          const before = new Set(Object.keys(run.value.store.state.tasks));
          const added = await run.value.store.addTask(task.title, s.config.harness.assignment.candidateRounds);
          if (!added.ok) return toolText(blockerText(added.blocker));
          taskId = Object.keys(added.value.tasks).find((t) => !before.has(t));
          if (!taskId) return toolText("BLOCKED STATE_CORRUPT: the new task was not recorded");
        }
        const recorded = await run.value.store.recordApproval(decision.value.channel, { kind, task: taskId, artifact: { path: relative, hash }, decision: "approved", ...(lightweight ? { lightweight: true as const } : {}) });
        updateStatus(ctx);
        if (!recorded.ok) return toolText(blockerText(recorded.blocker));
        return toolText(`${kind} approved for task ${taskId} "${task.title}" (content ${shortHash(hash)}). Next: write the plan with a radian-checks block, then ask the user to start with radian_request_start (task ${taskId}).`);
      },
    });
    pi.registerTool({
      name: "radian_request_start",
      label: "Request start",
      description: "Ask the user to start a task: a Radian dialog shows the plan's content hash, its declared radian-checks commands, the approved PRD/spec or brief, and the worker profiles. Approval records the plan approval and switches this project to Build; then dispatch the plan's assignments with radian_dispatch. Requires a current PRD/spec or brief approval and a radian-checks block in the plan.",
      exposure: "model-only",
      parameters: T.Object({
        task: T.String({ description: "Task id from radian_status" }),
        planPath: T.String({ description: "Repository-relative plan path, for example .radian/planning/plan.md" }),
        note: T.Optional(T.String({ description: "Short note shown to the user, labelled as yours" })),
      }),
      execute: async (_id, params, _signal, _update, ctx) => {
        const v = view;
        const s = projectOf(v);
        if (!s) return toolText(NO_PROJECT("radian_request_start"));
        const ready = guidedPrecheck(ctx);
        if (!ready.ok) return toolText(blockerText(ready.blocker));
        const planPath = String(params.planPath ?? "");
        if (!safeRelative(planPath)) return toolText("BLOCKED PATH_INVALID: plan path must be repository-relative");
        const run = await requireRun(s);
        if (!run.ok) return toolText(blockerText(run.blocker));
        const state = run.value.store.state;
        const task = state.tasks[String(params.task ?? "")];
        if (!task) return toolText(blockerText({ code: "INVALID_TRANSITION", message: `unknown task '${String(params.task ?? "")}'`, nextAction: "Use a task id from radian_status; tasks are created when the user approves a PRD." }));
        const requirement = currentRequirement(s, state, task.id);
        if (!requirement.ok) return toolText(blockerText(requirement.blocker));
        const content = artifactContent(s.repo.root, planPath);
        const hash = artifactHash(s.repo.root, planPath);
        if (content === undefined || !hash) return toolText(`BLOCKED APPROVAL_MISSING: plan ${planPath} is missing or unreadable`);
        const checks = parseCheckDefinitions(content);
        if (!checks.ok) return toolText(blockerText(checks.blocker));
        if (Object.keys(checks.value).length === 0) return toolText(blockerText({ code: "APPROVAL_MISSING", message: "the plan declares no required checks in a radian-checks block", nextAction: 'Add a fenced radian-checks block, one `id: ["argv", ...]` per line, then request the start again.' }));
        const decision = await guidedDecision(v, ctx, {
          key: `start:${task.id}:${planPath}:${hash}`,
          title: `Radian · start "${task.title}" (${task.id}) · project ${labelOf(v, s)}`,
          body: [
            `Plan: ${planPath} · content ${shortHash(hash)}`,
            `${requirement.value.kind === "spec" ? "PRD/spec" : "Brief"} approved: ${requirement.value.path} · content ${shortHash(requirement.value.hash)}`,
            "Required checks (the exact commands Radian will run):",
            ...Object.entries(checks.value).map(([id, argv]) => `  ${id}: ${argv.map(displayArg).join(" ")}`),
            ...profileLines(s.config.dispatch),
            ...coordinatorNote(params.note),
            "",
            "Approve records the plan approval for exactly this content and switches this project to Build. Workers start only if every dispatch gate passes.",
          ],
          approve: CHOICE.approve,
          view: () => `${planPath} (content ${shortHash(hash)})\n\n${artifactExcerpt(content)}`,
          origin: "radian_request_start",
        });
        if (!decision.ok) return toolText(blockerText(decision.blocker));
        if (decision.value.kind !== "approved") return toolText(notApproved(decision.value, "start (plan)"));
        if (artifactHash(s.repo.root, planPath) !== hash) return STALE_DURING_DIALOG(planPath);
        const still = currentRequirement(s, run.value.store.state, task.id);
        if (!still.ok || still.value.hash !== requirement.value.hash) return STALE_DURING_DIALOG(requirement.value.path);
        const recorded = await run.value.store.recordApproval(decision.value.channel, { kind: "plan", task: task.id, artifact: { path: planPath, hash }, decision: "approved" });
        if (!recorded.ok) return toolText(blockerText(recorded.blocker));
        await setMode(v, ctx, "build");
        return toolText(`plan approved for task ${task.id} (content ${shortHash(hash)}); project ${labelOf(v, s)} is now in BUILD. Dispatch the plan's assignments now with radian_dispatch (task ${task.id}, planPath ${planPath}, ${requirement.value.kind}Path ${requirement.value.path}). Dispatch is still refused while runtime capabilities are unverified.`);
      },
    });
    pi.registerTool({
      name: "radian_request_integration",
      label: "Request merge",
      description: "Ask the user to approve and merge a task's verified candidate. Radian computes the integration summary (candidate, target, checks, review, risks, gaps); a summary that is not ready is not shown for approval. Approval records the integration approval for exactly that candidate and target, then fast-forwards the target through the normal integration checks.",
      exposure: "model-only",
      parameters: T.Object({
        task: T.String({ description: "Task id from radian_status" }),
        note: T.Optional(T.String({ description: "Short note shown to the user, labelled as yours" })),
      }),
      execute: async (_id, params, _signal, _update, ctx) => {
        const v = view;
        const s = projectOf(v);
        if (!s) return toolText(NO_PROJECT("radian_request_integration"));
        const ready = guidedPrecheck(ctx);
        if (!ready.ok) return toolText(blockerText(ready.blocker));
        const run = await requireRun(s);
        if (!run.ok) return toolText(blockerText(run.blocker));
        const task = run.value.store.state.tasks[String(params.task ?? "")];
        if (!task) return toolText(blockerText({ code: "INVALID_TRANSITION", message: `unknown task '${String(params.task ?? "")}'`, nextAction: "Use a task id from radian_status." }));
        const required = run.value.coordinator.evidence(task.id).requiredChecks ?? [];
        if (required.length === 0) return toolText("BLOCKED CANDIDATE_MISMATCH: no required checks were recorded for this task");
        // The task's latest plan decision must still be a valid approval (a later rejection or edit makes it unusable).
        const latestPlan = Object.values(run.value.store.state.approvals).filter((a) => a.task === task.id && a.kind === "plan").at(-1);
        const planHash = latestPlan ? artifactHash(s.repo.root, latestPlan.artifact.path) : undefined;
        const planValid = requireApproval(run.value.store.state, { task: task.id, kind: "plan" }, { artifactHash: planHash ?? "" });
        if (!latestPlan || !planHash || !planValid.ok) return toolText(blockerText(planValid.ok ? { code: "APPROVAL_MISSING", message: "the task has no current plan approval" } : planValid.blocker));
        const plan = planValid.value;
        const summary = await run.value.coordinator.integrationSummary(task.id, required);
        if (!summary.ok) return toolText(blockerText(summary.blocker));
        const sv = summary.value;
        if (!sv.ready) return toolText(`BLOCKED CANDIDATE_MISMATCH: not ready for integration (${sv.gaps.join("; ")})`);
        const decision = await guidedDecision(v, ctx, {
          key: `integration:${task.id}:${sv.candidate.commit}:${sv.target.commit}`,
          title: `Radian · merge "${task.title}" (${task.id}) · project ${labelOf(v, s)}`,
          body: [
            `Candidate ${sv.candidate.commit.slice(0, 12)} (tree ${sv.candidate.tree.slice(0, 12)}) onto ${sv.target.ref} at ${sv.target.commit.slice(0, 12)}`,
            `Checks: ${sv.checks.map((c) => `${c.id}=${c.outcome}`).join(", ") || "none"}`,
            `Review: ${sv.review ? `${sv.review.blockingFindings} blocking of ${sv.review.findings} finding(s)` : "none"}`,
            `Risks: ${sv.risks.join("; ") || "none"}`,
            `Gaps: ${sv.gaps.join("; ") || "none"}`,
            ...coordinatorNote(params.note),
            "",
            `Approve and merge records the integration approval for exactly this candidate and target, then fast-forwards ${sv.target.ref}. The target is rechecked first; drift or dirty state refuses.`,
          ],
          approve: CHOICE.merge,
          origin: "radian_request_integration",
        });
        if (!decision.ok) return toolText(blockerText(decision.blocker));
        if (decision.value.kind !== "approved") return toolText(notApproved(decision.value, "merge"));
        if (artifactHash(s.repo.root, plan.artifact.path) !== planHash) return STALE_DURING_DIALOG(plan.artifact.path);
        const recorded = await run.value.store.recordApproval(decision.value.channel, { kind: "integration", task: task.id, artifact: { path: plan.artifact.path, hash: planHash }, decision: "approved", candidate: sv.candidate, target: sv.target });
        if (!recorded.ok) return toolText(blockerText(recorded.blocker));
        const integrated = await run.value.coordinator.integrate(decision.value.channel, task.id, required, { path: plan.artifact.path });
        updateStatus(ctx);
        return toolText(integrated.ok ? `Integrated ${task.id}: ${integrated.value.from.slice(0, 12)} → ${integrated.value.to.slice(0, 12)}.` : blockerText(integrated.blocker));
      },
    });
    const delegates: DelegateTools = {};
    if (rt.createGrepToolDefinition) delegates.grep = rt.createGrepToolDefinition;
    if (rt.createFindToolDefinition) delegates.find = rt.createFindToolDefinition;
    for (const tool of readToolDefinitions(T, scopeAt, delegates)) pi.registerTool(tool as unknown as HostToolDefinition);
  };

  /** Names of read tools whose active registration is Radian's own (checked at every call). */
  const ownedReadTools = (): ReadonlySet<string> | undefined => {
    const all = pi.getAllTools?.();
    if (!all) return undefined;
    const ours = all.find((t) => t.name === "radian_status")?.sourceInfo?.path;
    return new Set(READ_TOOL_NAMES.filter((name) => {
      const active = all.filter((t) => t.name === name).at(-1);
      return ours !== undefined && active?.sourceInfo?.path === ours;
    }));
  };

  const projectContextFiles = (root: string): Array<{ path: string; content: string }> | undefined => {
    if (!runtime?.loadProjectContextFiles || !runtime.getAgentDir) return undefined;
    // The files Pi would load at the project root; files inside the project are re-read without following links.
    return runtime.loadProjectContextFiles({ cwd: root, agentDir: runtime.getAgentDir() }).flatMap((file) => {
      if (!isWithin(file.path, root)) return [file];
      const reread = readConfined(root, path.relative(root, file.path).split(path.sep).join("/"));
      return reread.ok ? [{ path: file.path, content: reread.value }] : [];
    });
  };

  const install = async (ctx: HostContext): Promise<void> => {
    const v = view;
    if (v.kind === "unmanaged") return;
    runtime ??= await options.loadRuntime();
    registerTools(runtime);
    // Declare exactly the tools this state allows; the guard still refuses anything else.
    pi.setActiveTools?.(v.kind === "project" ? [...RADIAN_TOOLS, ...READ_TOOL_NAMES] : v.kind === "dashboard" ? ["radian_status", "read", "ls"] : []);
    const rt = processRuntime();
    if (v.kind === "dashboard" || v.kind === "project") {
      const project = v.kind === "project" ? v.project.binding.project : undefined;
      const ws = workspaceRootOf(v);
      rt.active = {
        workspaceRoot: ws,
        project,
        generation: v.generation,
        notify: (notice) => {
          if (view !== v) return;
          ctx.ui.notify(notice.project === project ? notice.text : `Radian (${notice.project}): ${notice.text}`, notice.level);
          if (notice.project === project) pi.sendMessage({ customType: "radian-outcome", content: notice.text, display: true }, { triggerTurn: false });
          updateStatus(ctx);
        },
      };
      if (project && ws) for (const notice of takeInbox(ws, project)) rt.active.notify(notice);
    }
    if (v.kind === "project" && ctx.mode === "tui" && ctx.hasUI) ctx.ui.setEditorComponent(managedEditorFactory(runtime, () => void controller.toggleMode(ctx)));
    updateStatus(ctx);
  };

  pi.on("input", (event) => {
    lastInputSource = event.source;
    // The user spoke again: requests they declined may be asked once more.
    if (event.source === "interactive") declined.clear();
    return undefined;
  });

  pi.on("session_start", async (event, ctx) => {
    const found = discoverAt(ctx.cwd);
    view = await activation.resolve(found, ctx, event.reason);
    await install(ctx);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const v = view;
    if (v.kind === "unmanaged") return;
    if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setEditorComponent(undefined);
    ctx.ui.setStatus("radian", undefined);
    ctx.ui.setWidget("radian", undefined);
    const rt = processRuntime();
    if (rt.active && (v.kind === "dashboard" || v.kind === "project") && rt.active.generation === v.generation) rt.active = undefined;
    view = { kind: "unmanaged" };
    // This process no longer shows the project's conversation; its execution owner stays.
    if (v.kind === "project") releaseViewLock(v.project.binding.workspaceRoot, v.project.binding.project);
    // Only a real quit ends execution ownership; switching or reloading replaces the view.
    if ((event.reason ?? "quit") === "quit") await shutdownOwners();
  });

  pi.on("before_agent_start", (event) => {
    const v = view;
    skillRoots = (event.systemPromptOptions.skills ?? []).map((skill) => skill.baseDir);
    const sections = (event.systemPromptOptions.sections ??= {});
    if (v.kind === "project") {
      const files = projectContextFiles(v.project.repo.root);
      if (files) event.systemPromptOptions.contextFiles = files;
      event.systemPromptOptions.cwd = v.project.repo.root;
      sections.radian = `Radian project: ${v.workspace ? projectLabel(v.workspace, v.project.binding.project) : v.project.binding.project} (mode ${v.project.mode.mode.toUpperCase()}). Paths are relative to this project's root. Coordinator tools act only on this project.`;
    } else if (v.kind === "dashboard") {
      sections.radian = "Radian workspace dashboard: no project is selected. Only workspace status and confined workspace reads are available; the user selects a project with /projects or creates one with /new-project.";
    } else if (v.kind === "blocked") {
      sections.radian = `This Radian workspace is blocked (${v.blocker.message}); no tool will run until the user fixes it.`;
    }
    return undefined;
  });

  pi.on("user_bash", () => {
    // The user's own `!` commands stay a deliberate user control; in a selected project they run at its root.
    const v = view;
    if (v.kind !== "project" || v.direct || !runtime?.createLocalBashOperations) return undefined;
    const local = runtime.createLocalBashOperations();
    const root = v.project.repo.root;
    return { operations: { exec: (command: string, _cwd: string, opts: Parameters<HostBashOperations["exec"]>[2]) => local.exec(command, root, opts) } };
  });

  pi.on("tool_call", (event, ctx) => {
    const v = view;
    if (v.kind === "unmanaged") return undefined;
    const s = projectOf(v);
    const owned = ownedReadTools();
    const options: Parameters<typeof guardToolCall>[1] = {
      state: v.kind === "project" ? "project" : v.kind,
      projectRoot: s?.repo.root ?? workspaceRootOf(v) ?? ctx.cwd,
      planningRoots: s?.planningRoots ?? [],
      radianTools: new Set(RADIAN_TOOLS),
    };
    if (v.kind === "blocked") options.blockedReason = v.blocker.message;
    if (owned) options.ownedReadTools = owned;
    const decision = guardToolCall(event, options, ctx.cwd);
    return decision.block ? { block: true, reason: `[${decision.rule}] ${decision.reason}` } : undefined;
  });

  pi.registerToolRenderer(calmResolver(() => managed() && session()!.calm.enabled, (text) => (runtime ? new runtime.Text(text, 0, 0) : text)));

  // After a successful switch the old context is stale and the new runtime reports instead (empty text).
  const notifyResult = (ctx: HostContext, text: string) => {
    if (!text) return;
    try {
      ctx.ui.notify(text, text.startsWith("BLOCKED") ? "warning" : "info");
    } catch {
      // A replaced runtime's context; the replacement view already reported.
    }
  };
  pi.registerCommand("radian", {
    description: "Radian coordinator for the selected project: status, mode, calm, approvals, decisions, integration, pause/cancel, retrospectives",
    handler: async (args, ctx) => notifyResult(ctx, await controller.command(args, ctx)),
  });
  pi.registerCommand("projects", {
    description: "List the workspace's registered projects, or select one: /projects <name>",
    handler: async (args, ctx) => notifyResult(ctx, await controller.projectsCommand(args, ctx)),
  });
  pi.registerCommand("new-project", {
    description: "Create a minimal Git + Radian project in this workspace (previewed and confirmed): /new-project <name> [--branch <branch>]",
    handler: async (args, ctx) => notifyResult(ctx, await controller.newProjectCommand(args, ctx)),
  });
  pi.registerCommand("add-project", {
    description: "Register an existing repository in this workspace with an explicit protected target: /add-project <path> --target refs/heads/<branch>",
    handler: async (args, ctx) => notifyResult(ctx, await controller.addProjectCommand(args, ctx)),
  });
  pi.registerCommand("workspace", {
    description: "Return to the workspace dashboard (background work continues)",
    handler: async (args, ctx) => notifyResult(ctx, await controller.workspaceCommand(args, ctx)),
  });

  return controller;
}

/** Stop process-wide execution ownership on a real quit, under verified/unknown ownership rules. */
async function shutdownOwners(): Promise<void> {
  const rt = processRuntime();
  const owners = [...rt.owners.values()];
  rt.owners.clear();
  for (const s of owners) {
    releaseViewLock(s.binding.workspaceRoot, s.binding.project);
    const run = s.run;
    if (!run) continue;
    // Stop renewal and monitoring first, so nothing renews a released lease or reports a loss for an orderly exit.
    run.safety?.stop();
    // With live workers, leave the watcher fed by nothing: losing coordination stops owned work.
    if (run.coordinator.liveAssignments().length === 0) run.supervision.release();
    else run.supervision.dropHeartbeat();
    await run.lease.release();
  }
}

/** Local branches with commits, offered as explicit protected-target choices (read-only, controlled Git). */
async function localBranches(repoRoot: string): Promise<string[]> {
  const gitPath = locateGit();
  if (!gitPath) return [];
  const out = spawnSync(gitPath, gitArgv(["for-each-ref", "--format=%(refname)", "refs/heads"]), { cwd: repoRoot, env: controlledGitEnv(), encoding: "utf8", timeout: 10_000 });
  return out.status === 0 ? out.stdout.split("\n").filter(Boolean) : [];
}

async function capacityLine(workspaceRoot: string): Promise<string> {
  try {
    const reservations = await new CapacityLedger(workspacePaths(workspaceRoot).state).list();
    let ceiling = 3;
    const configured = loadAndResolve({ workspaceRoot });
    if (configured.ok) ceiling = configured.value.harness.concurrency.maxActiveWorkers;
    return `${reservations.length}/${ceiling} workers`;
  } catch {
    return "capacity unknown";
  }
}

function projectLabel(ws: WorkspaceInfo, project: string): string {
  return ws.projects.find((p) => p.project === project)?.name ?? project;
}

export function projectListText(ws: WorkspaceInfo, selected: string | undefined): string {
  if (ws.projects.length === 0) return `Workspace ${path.basename(ws.root)} has no registered projects. Create one with /new-project <name> or register an existing repository with /add-project <path>.`;
  const lines = [`Projects in ${path.basename(ws.root)} (explicitly registered):`];
  for (const p of ws.projects) {
    const run = activeRunLabel(ws.root, p.project);
    lines.push(`${p.project === selected ? "*" : " "} ${p.name}${p.presence !== "present" ? ` [${p.presence}]` : ""}${p.target ? ` · target ${p.target}` : " · no target"}${run ? ` · ${run}` : ""}`);
  }
  lines.push("Select with /projects <name>; return here with /workspace.");
  return lines.join("\n");
}

function activeRunLabel(workspaceRoot: string, project: string): string | undefined {
  const active = readJsonIfExists(path.join(projectPaths(workspaceRoot, project).state, "active-run.json"));
  if (active.state !== "ok") return undefined;
  const run = loadRunDir(path.join(projectPaths(workspaceRoot, project).state, "runs", (active.value as { run: string }).run));
  if (!run.ok) return "run state unreadable";
  const blocked = Object.values(run.value.state.decisions).filter((d) => d.status === "open").length;
  return `run ${run.value.state.run.status}${blocked ? `, ${blocked} open decision(s)` : ""}`;
}

export function workspaceStatusText(ws: WorkspaceInfo | undefined): string {
  if (!ws) return "Radian workspace status unavailable.";
  return [`Radian workspace ${path.basename(ws.root)} · no project selected`, projectListText(ws, undefined)].join("\n");
}

/** Map validated tool parameters onto a fixed inspection operation; Git options are not representable. */
function inspectRequest(params: Record<string, unknown>): Outcome<InspectRequest> {
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  switch (params.op) {
    case "status":
      return success({ op: "status" });
    case "log": {
      const request: InspectRequest = { op: "log", max: typeof params.max === "number" ? params.max : 20 };
      const rev = text(params.rev);
      if (rev !== undefined) request.rev = rev;
      return success(request);
    }
    case "diff": {
      const from = text(params.from);
      if (from === undefined) return refuse("CONFIG_INVALID", "diff requires an exact 'from' commit id");
      const request: InspectRequest = { op: "diff", from };
      const to = text(params.to);
      if (to !== undefined) request.to = to;
      if (Array.isArray(params.paths)) request.paths = params.paths.map(String);
      return success(request);
    }
    case "show": {
      const rev = text(params.rev);
      if (rev === undefined) return refuse("CONFIG_INVALID", "show requires an exact 'rev' commit id");
      const request: InspectRequest = { op: "show", rev };
      const file = text(params.path);
      if (file !== undefined) request.path = file;
      return success(request);
    }
    default:
      return refuse("CONFIG_INVALID", "unknown Git inspection operation");
  }
}

function toPlan(session: ProjectSession, params: Record<string, unknown>): Outcome<AssignmentPlan> {
  const role = params.role as Role;
  if (!ROLES.includes(role)) return refuse("CONFIG_INVALID", "unknown role");
  const hash = (p: unknown): string | undefined => (typeof p === "string" ? artifactHash(session.repo.root, p) : undefined);
  const plan = hash(params.planPath);
  if (!plan) return refuse("APPROVAL_MISSING", "plan artifact is missing");
  const candidateCheck = params.candidateCheck === true;
  const base = typeof params.baseCandidate === "string" && /^[0-9a-f]{40,64}$/.test(params.baseCandidate) ? { kind: "commit" as const, commit: params.baseCandidate } : { kind: "target" as const };
  // Exact-candidate checks never get a writable source tree: only declared output roots (validated by the coordinator).
  const requestedRoots = candidateCheck ? ((params.checkOutputRoots as string[] | undefined) ?? []) : role === "reviewer" || role === "scout" ? [] : ((params.writeRoots as string[] | undefined) ?? []);
  // A directory root may be written with trailing slashes ("scenes/"). Stripping them never widens
  // a root: a value that is only slashes stays as given and is refused, not turned into "" (whole checkout).
  const writeRoots = requestedRoots.map((w) => {
    const root = String(w);
    const stripped = root.replace(/\/+$/, "");
    return stripped === "" ? root : stripped;
  });
  const badRoot = writeRoots.findIndex((w) => w !== "" && !safeRelative(w));
  if (badRoot >= 0) return refuse("PATH_INVALID", `write root ${JSON.stringify(String(requestedRoots[badRoot]))} must be a repository-relative path without '.', '..', or empty components`, "Use paths such as scenes or src/app; \"\" means the whole checkout.");
  if (candidateCheck && writeRoots.includes("")) return refuse("PATH_OUTSIDE_SCOPE", "a candidate check cannot write the whole checkout");
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
    base,
    artifacts,
  };
  if (Array.isArray(params.requiredChecks)) out.requiredChecks = params.requiredChecks as AssignmentPlan["requiredChecks"];
  return success(out);
}

function outcomeText(outcome: AssignmentOutcome): string {
  switch (outcome.state) {
    case "completed":
      return `Assignment ${outcome.assignment} completed: ${outcome.result.summary.slice(0, 300)}${outcome.delivery ? ` (delivery ${outcome.delivery.commit.slice(0, 12)})` : ""}${outcome.checks ? `; coordinator-bound checks: ${outcome.checks.map((c) => `${c.id}=${c.outcome}`).join(", ") || "none"}` : ""}; ${outcome.result.findings.length} finding(s).`;
    case "blocked":
      return `Assignment ${outcome.assignment ?? "(not created)"} blocked — ${outcome.blocker.code}: ${outcome.blocker.message}${outcome.decisionId ? ` (decision ${outcome.decisionId})` : ""}`;
    case "failed":
      return `Assignment ${outcome.assignment} failed: ${outcome.reason}; termination ${outcome.termination}.`;
  }
}

export function statusText(session: ProjectSession): string {
  const lines = [`Radian ${session.mode.mode.toUpperCase()} · project ${session.binding.project} · target ${session.target?.ref ?? "(not registered)"}${session.calm.enabled ? " · calm" : ""}`];
  const state = session.run?.store.state;
  if (!state) lines.push("No active run yet; one opens automatically when the user approves a draft.");
  else {
    lines.push(`Run ${state.run.id}: ${state.run.status} · harness ${state.run.harness.version}@${state.run.harness.revision.slice(0, 12)}`);
    for (const task of Object.values(state.tasks)) lines.push(`- task ${task.id} "${task.title}": ${task.phase}, round ${task.roundsUsed}/${task.maxRounds}`);
    for (const a of Object.values(state.assignments)) lines.push(`  - ${a.role} ${a.id}: ${a.status} (${a.profile.runtime}/${a.profile.model}/${a.profile.effort})`);
    const open = Object.values(state.decisions).filter((d) => d.status === "open");
    for (const d of open) lines.push(`  ? decision ${d.id} (${d.kind}): ${d.prompt.slice(0, 160)}`);
  }
  return lines.join("\n");
}
