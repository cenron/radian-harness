// Per-attempt runtime session: preflight → owned Herdr pane → launcher starts
// the runtime's normal interactive session (exact model, effort, role system
// prompt, tool limits, first task message) → binding → stop.
//
// Ordering guarantees:
// - The proposal 0015 pairing (Anthropic models through Claude Code only) is
//   rechecked before launch preparation and again before the pane is created.
// - The watcher learns about the attempt before the pane exists, and the
//   launcher registers the runtime process before binding is confirmed.
// - Workers use the user's own runtime logins; API-key, custom-endpoint, and
//   proxy variables are removed from their environment.
// There is no OS sandbox and no capability gate (isolation is deferred past the MVP).

import { existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { type Blocker, type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { ResolvedAuthority } from "../contracts/authority.ts";
import type { AssignmentIdentity } from "../contracts/identity.ts";
import type { SealedBrief } from "../contracts/brief.ts";
import { type ResolvedProfile, recheckResolvedProfile } from "../config/provider-policy.ts";
import { RUNTIME_FACTS } from "../config/runtimes.ts";
import type { ProcessOps } from "../isolation/processes.ts";
import { SupervisionRegistry } from "../isolation/registry.ts";
import type { SupervisionClient } from "../isolation/supervision.ts";
import { terminateOwned, type TerminationOutcome } from "../isolation/terminate.ts";
import { type CheckRun, type LaunchSpec, writeSpec } from "../isolation/launcher.ts";
import { psProbe } from "../util/process-identity.ts";
import { ensureDir } from "../state/fsutil.ts";
import type { RuntimeAdapter, RuntimeInstall } from "./contract.ts";
import { workerEnv } from "./env.ts";
import type { HerdrTransport } from "./herdr.ts";

export interface SessionDeps {
  adapters: Record<string, RuntimeAdapter>;
  transport: HerdrTransport;
  supervision: Pick<SupervisionClient, "health" | "watch" | "unwatch">;
  ops: ProcessOps;
  stateDir: string;
  /** Node executable and launcher entry used inside the pane. */
  launcherArgv: readonly string[];
  /** Coordinator's own pane, used as the explicit split parent. */
  parentPane: string;
  graceMs: number;
  /** Environment workers inherit (default: this process's), minus API-key/endpoint/proxy variables. */
  hostEnv?: NodeJS.ProcessEnv;
}

export interface AttemptRequest {
  identity: AssignmentIdentity;
  profile: ResolvedProfile;
  authority: ResolvedAuthority;
  brief: SealedBrief;
  briefText: string;
  /** The role guide, given to the runtime as its system prompt. */
  systemPrompt: string;
  /** Exact-candidate checks the launcher runs itself before the runtime. */
  checks?: { runs: CheckRun[]; timeoutMs: number };
  /**
   * Coordinator launch authorization (current approvals, mode, supervision).
   * Rechecked before preparation, before the pane is created, and at the last
   * boundary before the launcher command is delivered.
   */
  authorize?: () => Outcome<true>;
  /** Revision-bound start gate the launcher re-checks immediately before anything starts (W06/F03). */
  startGate?: { projectRoot: string; artifacts: Array<{ kind: string; path: string; hash: string }> };
}

export interface PreflightResult {
  adapter: RuntimeAdapter;
  install: RuntimeInstall;
  tools: string[];
}

export interface LaunchedAttempt {
  identity: AssignmentIdentity;
  sessionId: string;
  paneId: string;
  delivery: "sent" | "uncertain";
  specFile: string;
  resultFile: string;
  runtime: ResolvedProfile["runtime"];
  model: string;
}

export async function preflight(deps: SessionDeps, request: Pick<AttemptRequest, "identity" | "profile" | "authority">): Promise<Outcome<PreflightResult>> {
  const pairing = recheckResolvedProfile(request.profile);
  if (!pairing.ok) return pairing;
  const adapter = deps.adapters[request.profile.runtime];
  if (!adapter) return refuse("RUNTIME_UNAVAILABLE", "no adapter for runtime");
  if (request.identity.role !== request.authority.role) return refuse("AUTHORITY_INVALID", "identity role and authority role differ");
  if (!RUNTIME_FACTS[request.profile.runtime].efforts.includes(request.profile.effort)) return refuse("EFFORT_UNSUPPORTED", "effort is not supported by this runtime");
  const install = await adapter.detect();
  if (!install.ok) return install;
  const tools = adapter.toolsFor(request.identity.role, request.authority);
  if (!tools.ok) return tools;
  const health = deps.supervision.health();
  if (!health.ok) return health;
  return success({ adapter, install: install.value, tools: tools.value });
}

function writePrivate(file: string, content: string): void {
  ensureDir(path.dirname(file));
  writeFileSync(file, content, { mode: 0o400, flag: "wx" });
}

/**
 * Outcome of a launch. `started: "no"` is proven non-execution: nothing was
 * delivered to a pane (any created pane was closed). Once delivery of the
 * launcher command was attempted, a failure is `started: "uncertain"` and
 * carries the owned attempt: the caller must stop it (which revokes any
 * delayed launcher) and establish termination before it releases capacity,
 * worktree ownership, or watcher coverage.
 */
export type LaunchOutcome =
  | { ok: true; value: LaunchedAttempt }
  | { ok: false; blocker: Blocker; started: "no" }
  | { ok: false; blocker: Blocker; started: "uncertain"; attempt: LaunchedAttempt };

export async function launchAttempt(deps: SessionDeps, request: AttemptRequest): Promise<LaunchOutcome> {
  const prepared = await prepareLaunchAttempt(deps, request);
  if (!prepared.ok) return { ok: false, blocker: prepared.blocker, started: "no" };
  const { launched, argv } = prepared.value;
  const delivered = await deps.transport.runInPane(launched.paneId, argv);
  // An error or timeout here does not prove the command was not typed; the launcher may still start.
  if (!delivered.ok) return { ok: false, blocker: delivered.blocker, started: "uncertain", attempt: { ...launched, delivery: "uncertain" } };
  return { ok: true, value: { ...launched, delivery: delivered.value } };
}

/** Every step before delivery; a refusal here has started nothing. */
async function prepareLaunchAttempt(deps: SessionDeps, request: AttemptRequest): Promise<Outcome<{ launched: LaunchedAttempt; argv: string[] }>> {
  const ready = await preflight(deps, request);
  if (!ready.ok) return ready;
  const authorize = (): Outcome<true> => request.authorize?.() ?? success(true);
  const beforePreparation = authorize();
  if (!beforePreparation.ok) return beforePreparation;
  const { adapter, install } = ready.value;

  const a = request.authority;
  const briefFile = path.join(a.outputDir, `brief-${request.identity.attempt}.md`);
  const resultFile = path.join(a.outputDir, "result.json");
  // A retry of the same assignment: keep the previous attempt's result as evidence, never let it be read as this attempt's.
  if (existsSync(resultFile)) renameSync(resultFile, path.join(a.outputDir, `result.superseded-before-${request.identity.attempt}.json`));
  writePrivate(briefFile, `${request.briefText}\n\n<!-- radian brief ${request.brief.hash} -->\n`);
  const sessionId = randomUUID();
  const plan = adapter.buildLaunch({ identity: request.identity, profile: request.profile, authority: a, install, systemPrompt: request.systemPrompt, briefFile, resultFile, sessionId });
  if (!plan.ok) return plan;
  const env = workerEnv(deps.hostEnv ?? process.env, plan.value.env);

  const launchDir = path.join(deps.stateDir, "launch", request.identity.attempt);
  const spec: LaunchSpec = { schema: "radian.launch/2", identity: request.identity, stateDir: deps.stateDir, argv: plan.value.argv, env, cwd: plan.value.cwd };
  if (request.checks) spec.checks = { runs: request.checks.runs, timeoutMs: request.checks.timeoutMs, logDir: a.outputDir, env };
  if (request.startGate) spec.startGate = request.startGate;
  const specFile = path.join(launchDir, "spec.json");
  const hash = writeSpec(specFile, spec);

  // Recheck the pairing and the launch authorization before anything becomes visible.
  const late = recheckResolvedProfile(request.profile);
  if (!late.ok) return late;
  const beforePane = authorize();
  if (!beforePane.ok) return beforePane;
  await deps.supervision.watch({ assignment: request.identity.assignment, attempt: request.identity.attempt, ownedRoots: [a.worktree, a.outputDir, a.scratchDir], projectionDirs: [] });
  // The pane's own shell lives outside the worker's owned roots: a Herdr pane keeps its shell until
  // closed, and an unowned process inside an owned root would make every clean stop "unknown".
  // The launcher sets the runtime's working directory itself (spec.cwd).
  const pane = await deps.transport.createPane({ assignment: request.identity.assignment, attempt: request.identity.attempt, parentPane: deps.parentPane, cwd: launchDir });
  if (!pane.ok) {
    await deps.supervision.unwatch(request.identity.assignment);
    return pane;
  }
  await new SupervisionRegistry(deps.stateDir, request.identity.assignment).append({ kind: "resource", attempt: request.identity.attempt, resource: "pane", id: pane.value.paneId });
  // Last boundary: nothing has been typed into the pane yet, so a refusal here started nothing.
  const beforeDelivery = authorize();
  if (!beforeDelivery.ok) {
    await deps.transport.closePane(pane.value.paneId, "verified");
    await deps.supervision.unwatch(request.identity.assignment);
    return beforeDelivery;
  }
  return success({
    launched: { identity: request.identity, sessionId, paneId: pane.value.paneId, delivery: "uncertain", specFile, resultFile, runtime: request.profile.runtime, model: request.profile.model },
    argv: [...deps.launcherArgv, specFile, hash],
  });
}

export interface BindingEvidence {
  runtimeProcess: { pid: number; start: string };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long the interactive session must stay up after registration before it counts as bound. */
export const BINDING_STABLE_MS = 1_500;

/**
 * Binding: the launcher registered the runtime's interactive session process
 * for this exact attempt, and it has kept running for BINDING_STABLE_MS (an
 * interactive session waits for input; one that crashes on startup does not).
 * A session that exits, or never registers before the deadline, is never bound.
 */
export async function awaitBinding(deps: SessionDeps, launched: LaunchedAttempt, deadlineMs: number, _unused?: unknown, signal?: AbortSignal): Promise<Outcome<BindingEvidence>> {
  const registry = new SupervisionRegistry(deps.stateDir, launched.identity.assignment);
  let aliveSince: number | undefined;
  while (Date.now() < deadlineMs) {
    if (signal?.aborted) return refuse("BINDING_UNCONFIRMED", "the wait for binding was interrupted; the attempt is being stopped");
    const entries = registry.entries().filter((e) => e.attempt === launched.identity.attempt);
    const runtime = entries.find((e) => e.kind === "process" && e.label === "runtime");
    if (runtime && runtime.kind === "process" && !entries.some((e) => e.kind === "exited")) {
      const state = psProbe(runtime.identity.pid);
      if (state.state === "running" && state.start === runtime.identity.start) {
        aliveSince ??= Date.now();
        if (Date.now() - aliveSince >= BINDING_STABLE_MS) return success({ runtimeProcess: runtime.identity });
      } else aliveSince = undefined;
    }
    if (entries.some((e) => e.kind === "exited")) return refuse("BINDING_UNCONFIRMED", "the runtime session exited before it was bound");
    if (entries.some((e) => e.kind === "revoked") && !runtime) return refuse("BINDING_UNCONFIRMED", "the launch was revoked before the session started");
    await sleep(100);
  }
  return refuse("BINDING_UNCONFIRMED", launched.delivery === "uncertain" ? "launch delivery was uncertain and the session was not observed" : "the session did not start before the startup deadline", "Stop and reconcile the attempt; the launch is never resent automatically.");
}

/**
 * Stop an attempt: revoke any not-yet-started launcher first, then verify
 * termination; the pane is closed and the watch released only when
 * termination is verified. Idempotent: a repeated stop re-establishes the same
 * postcondition.
 */
export async function stopAttempt(deps: SessionDeps, launched: Pick<LaunchedAttempt, "identity" | "paneId">, authority: ResolvedAuthority): Promise<{ termination: TerminationOutcome; paneClosed: boolean }> {
  const registry = new SupervisionRegistry(deps.stateDir, launched.identity.assignment);
  await registry.revoke(launched.identity.attempt);
  const termination = await terminateOwned(deps.ops, {
    registered: registry.processes(launched.identity.attempt),
    ownedRoots: [authority.worktree, authority.outputDir, authority.scratchDir],
    unresolvedIntents: registry.unresolvedIntents(launched.identity.attempt).length,
    protectedPids: [process.pid],
    graceMs: deps.graceMs,
  });
  await registry.append({ kind: "terminated", attempt: launched.identity.attempt, postcondition: termination.postcondition, survivors: termination.survivors.length, discovered: termination.discovered });
  const closed = await deps.transport.closePane(launched.paneId, termination.postcondition);
  if (termination.postcondition === "verified") await deps.supervision.unwatch(launched.identity.assignment);
  return { termination, paneClosed: closed.ok };
}
