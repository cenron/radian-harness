// Worker driver: the narrow interface the orchestrator uses to run one attempt.
// The production driver composes the runtime session (preflight, an owned pane
// running the runtime's interactive session, binding, completion when the
// worker writes its result, verified stop). Tests substitute a fake driver.

import type { Blocker, Outcome } from "../contracts/blockers.ts";
import { refuse, success } from "../contracts/blockers.ts";
import type { ResolvedAuthority } from "../contracts/authority.ts";
import type { SealedBrief } from "../contracts/brief.ts";
import type { AssignmentIdentity } from "../contracts/identity.ts";
import type { ResolvedProfile } from "../config/provider-policy.ts";
import type { ClassifiedError } from "../runtimes/contract.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { type LaunchedAttempt, type SessionDeps, awaitBinding, launchAttempt, stopAttempt } from "../runtimes/session.ts";
import { SupervisionRegistry } from "../isolation/registry.ts";

export interface WorkerLaunchRequest {
  identity: AssignmentIdentity;
  profile: ResolvedProfile;
  authority: ResolvedAuthority;
  brief: SealedBrief;
  briefText: string;
  systemPrompt: string;
  /**
   * Launch authorization (current approvals, mode, supervision). The driver
   * rechecks it after its awaited preflight steps and at the last boundary
   * before the launch command is delivered; a refusal there starts nothing.
   */
  authorize?: () => Outcome<true>;
  /** Revision-bound start gate checked by the launcher before anything starts (W06/F03). */
  startGate?: { projectRoot: string; artifacts: Array<{ kind: string; path: string; hash: string }> };
  /** Exact-candidate checks the contained launcher runs itself before the runtime (R03). */
  checks?: { runs: Array<{ id: string; argv: string[] }>; timeoutMs: number };
}

/** Launcher-recorded execution of an approved check: the only source of a check outcome. */
export interface CheckExecution {
  id: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

export interface WorkerHandle {
  identity: AssignmentIdentity;
  authority: ResolvedAuthority;
  resultFile: string;
  /** Opaque driver data (e.g. pane and projection records). */
  internal: unknown;
}

export type SettledOutcome =
  | { kind: "settled"; outcome: "success" | "error" | "aborted"; error?: ClassifiedError; usage?: { inputTokens?: number; outputTokens?: number; source: string } }
  | { kind: "exited"; exitCode: number | null }
  | { kind: "timeout" };

/**
 * "refused": proven not started (nothing delivered; resources released).
 * "uncertain": the launch may have started; the handle carries owned identity
 * and resources and must be stopped, with termination verified, before release.
 */
export type DriverLaunch =
  | { kind: "launched"; handle: WorkerHandle }
  | { kind: "refused"; blocker: Blocker }
  | { kind: "uncertain"; handle: WorkerHandle; blocker: Blocker };

export interface WorkerDriver {
  launch(request: WorkerLaunchRequest): Promise<DriverLaunch>;
  /** Waits end early (unbound / timeout) when the signal aborts; the caller then owns stopping. */
  awaitBinding(handle: WorkerHandle, deadlineMs: number, signal?: AbortSignal): Promise<Outcome<true>>;
  awaitSettled(handle: WorkerHandle, deadlineMs: number, signal?: AbortSignal): Promise<SettledOutcome>;
  stop(handle: WorkerHandle): Promise<{ termination: "verified" | "unknown" }>;
  /** Check executions recorded outside the worker's reach for this attempt. */
  checkExecutions(handle: WorkerHandle): CheckExecution[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Production driver over src/runtimes/session.ts. */
export class RuntimeWorkerDriver implements WorkerDriver {
  private readonly deps: SessionDeps;
  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  async launch(request: WorkerLaunchRequest): Promise<DriverLaunch> {
    const launched = await launchAttempt(this.deps, request);
    const handle = (attempt: LaunchedAttempt): WorkerHandle => ({ identity: request.identity, authority: request.authority, resultFile: attempt.resultFile, internal: attempt });
    if (launched.ok) return { kind: "launched", handle: handle(launched.value) };
    if (launched.started === "uncertain") return { kind: "uncertain", handle: handle(launched.attempt), blocker: launched.blocker };
    return { kind: "refused", blocker: launched.blocker };
  }

  async awaitBinding(handle: WorkerHandle, deadlineMs: number, signal?: AbortSignal): Promise<Outcome<true>> {
    const bound = await awaitBinding(this.deps, handle.internal as LaunchedAttempt, deadlineMs, undefined, signal);
    return bound.ok ? success(true) : bound;
  }

  /**
   * An interactive session does not exit when its task is done: the attempt
   * settles when the worker's result file is complete (valid JSON, unchanged
   * for a moment), or when the session exits on its own.
   */
  async awaitSettled(handle: WorkerHandle, deadlineMs: number, signal?: AbortSignal): Promise<SettledOutcome> {
    const launched = handle.internal as LaunchedAttempt;
    const registry = new SupervisionRegistry(this.deps.stateDir, launched.identity.assignment);
    let seen: { size: number; mtimeMs: number } | undefined;
    while (Date.now() < deadlineMs && !signal?.aborted) {
      if (existsSync(launched.resultFile)) {
        const stat = statSync(launched.resultFile);
        const now = { size: stat.size, mtimeMs: stat.mtimeMs };
        if (seen && seen.size === now.size && seen.mtimeMs === now.mtimeMs && completeJson(launched.resultFile)) return { kind: "settled", outcome: "success" };
        seen = now;
      }
      const exited = registry.entries().find((e) => e.kind === "exited" && e.attempt === launched.identity.attempt);
      if (exited && exited.kind === "exited") return { kind: "exited", exitCode: exited.exitCode };
      await sleep(1000);
    }
    return { kind: "timeout" };
  }

  async stop(handle: WorkerHandle): Promise<{ termination: "verified" | "unknown" }> {
    const stopped = await stopAttempt(this.deps, handle.internal as LaunchedAttempt, handle.authority);
    return { termination: stopped.termination.postcondition };
  }

  checkExecutions(handle: WorkerHandle): CheckExecution[] {
    return new SupervisionRegistry(this.deps.stateDir, handle.identity.assignment).checks(handle.identity.attempt).map((e) => ({ id: e.id, exitCode: e.exitCode, signal: e.signal, timedOut: e.timedOut }));
  }
}

export function unavailableDriver(reason: string): WorkerDriver {
  return {
    launch: async () => ({ kind: "refused", blocker: { code: "RUNTIME_UNAVAILABLE", message: reason } }),
    awaitBinding: async () => refuse("BINDING_UNCONFIRMED", reason),
    awaitSettled: async () => ({ kind: "timeout" }),
    stop: async () => ({ termination: "unknown" }),
    checkExecutions: () => [],
  };
}

function completeJson(file: string): boolean {
  try {
    JSON.parse(readFileSync(file, "utf8"));
    return true;
  } catch {
    return false;
  }
}
