// Worker driver: the narrow interface the orchestrator uses to run one attempt.
// The production driver composes the runtime session (preflight, projection,
// contained launch in an owned pane, semantic binding, verified stop). Tests
// substitute a fake driver; fake success is never support evidence.

import type { Outcome } from "../contracts/blockers.ts";
import { refuse, success } from "../contracts/blockers.ts";
import type { ResolvedAuthority } from "../contracts/authority.ts";
import type { SealedBrief } from "../contracts/brief.ts";
import type { AssignmentIdentity } from "../contracts/identity.ts";
import type { ResolvedProfile } from "../config/provider-policy.ts";
import type { CredentialSource } from "../isolation/credentials.ts";
import type { ClassifiedError } from "../runtimes/contract.ts";
import { EventTail, type LaunchedAttempt, type SessionDeps, awaitBinding, launchAttempt, stopAttempt } from "../runtimes/session.ts";
import { SupervisionRegistry } from "../isolation/registry.ts";

export interface WorkerLaunchRequest {
  identity: AssignmentIdentity;
  profile: ResolvedProfile;
  authority: ResolvedAuthority;
  brief: SealedBrief;
  briefText: string;
  systemPrompt: string;
  credentialSource: CredentialSource;
  minValidityMs: number;
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

export interface WorkerDriver {
  launch(request: WorkerLaunchRequest): Promise<Outcome<WorkerHandle>>;
  awaitBinding(handle: WorkerHandle, deadlineMs: number): Promise<Outcome<true>>;
  awaitSettled(handle: WorkerHandle, deadlineMs: number): Promise<SettledOutcome>;
  stop(handle: WorkerHandle): Promise<{ termination: "verified" | "unknown" }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Production driver over src/runtimes/session.ts. */
export class RuntimeWorkerDriver implements WorkerDriver {
  private readonly deps: SessionDeps;
  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  async launch(request: WorkerLaunchRequest): Promise<Outcome<WorkerHandle>> {
    const launched = await launchAttempt(this.deps, request);
    if (!launched.ok) return launched;
    return success({ identity: request.identity, authority: request.authority, resultFile: launched.value.resultFile, internal: launched.value });
  }

  async awaitBinding(handle: WorkerHandle, deadlineMs: number): Promise<Outcome<true>> {
    const bound = await awaitBinding(this.deps, handle.internal as LaunchedAttempt, deadlineMs);
    return bound.ok ? success(true) : bound;
  }

  async awaitSettled(handle: WorkerHandle, deadlineMs: number): Promise<SettledOutcome> {
    const launched = handle.internal as LaunchedAttempt;
    const adapter = this.deps.adapters[launched.runtime];
    if (!adapter) return { kind: "exited", exitCode: null };
    const tail = new EventTail(launched.eventsFile, adapter);
    const registry = new SupervisionRegistry(this.deps.stateDir, launched.identity.assignment);
    let usage: { inputTokens?: number; outputTokens?: number; source: string } | undefined;
    while (Date.now() < deadlineMs) {
      for (const event of tail.read()) {
        if (event.kind === "usage") usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, source: event.source };
        if (event.kind === "settled") {
          const settled: SettledOutcome = { kind: "settled", outcome: event.outcome };
          if (event.error) settled.error = event.error;
          if (usage) settled.usage = usage;
          return settled;
        }
      }
      const exited = registry.entries().find((e) => e.kind === "exited" && e.attempt === launched.identity.attempt);
      if (exited && exited.kind === "exited") return { kind: "exited", exitCode: exited.exitCode };
      await sleep(250);
    }
    return { kind: "timeout" };
  }

  async stop(handle: WorkerHandle): Promise<{ termination: "verified" | "unknown" }> {
    const stopped = await stopAttempt(this.deps, handle.internal as LaunchedAttempt, handle.authority);
    return { termination: stopped.termination.postcondition };
  }
}

export function unavailableDriver(reason: string): WorkerDriver {
  return {
    launch: async () => refuse("RUNTIME_UNAVAILABLE", reason),
    awaitBinding: async () => refuse("BINDING_UNCONFIRMED", reason),
    awaitSettled: async () => ({ kind: "timeout" }),
    stop: async () => ({ termination: "unknown" }),
  };
}
