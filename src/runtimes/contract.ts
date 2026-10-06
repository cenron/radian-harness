// Runtime adapter contract shared by Pi, Codex CLI, and Claude Code. An adapter
// translates a validated assignment into an exact argument vector and
// environment, declares its dependencies and tool restrictions, and parses the
// runtime's structured event stream into normalized events. Implementing an
// adapter is not evidence that the runtime is supported: launch still requires
// verified capabilities (src/isolation/capabilities.ts).

import type { Outcome } from "../contracts/blockers.ts";
import type { ResolvedAuthority } from "../contracts/authority.ts";
import type { AssignmentIdentity, Role, RuntimeKind } from "../contracts/identity.ts";
import type { ResolvedProfile } from "../config/provider-policy.ts";
import type { Projection } from "../isolation/credentials.ts";

export interface RuntimeInstall {
  runtime: RuntimeKind;
  executable: string;
  version: string;
  /** Install roots the runtime needs to read (package trees, interpreters). */
  installRoots: string[];
  /** Interpreter or helper executables that must also be resolvable. */
  helpers: string[];
}

export type ErrorClass = "quota" | "authentication" | "trust-permission" | "infrastructure" | "unknown";

export interface ClassifiedError {
  class: ErrorClass;
  /** Reliable reset time (epoch ms) only when the runtime supplied an explicit timestamp. */
  resetAtMs?: number;
  /** Sanitized summary; never raw provider payloads or credentials. */
  summary: string;
}

export type RuntimeEvent =
  | { kind: "session-started"; sessionId?: string; model?: string; effort?: string; authSource?: string; tools?: string[] }
  | { kind: "prompt-accepted" }
  | { kind: "activity"; detail: string }
  | { kind: "tool"; name: string; phase: "start" | "end"; isError?: boolean }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; source: string }
  | { kind: "settled"; outcome: "success" | "error" | "aborted"; error?: ClassifiedError }
  | { kind: "error"; error: ClassifiedError };

export interface LaunchInput {
  identity: AssignmentIdentity;
  profile: ResolvedProfile;
  authority: ResolvedAuthority;
  install: RuntimeInstall;
  projection: Projection;
  /** File (in the output directory) holding the sealed brief text the worker reads. */
  briefFile: string;
  /** Where the worker must write its `radian.result/1` envelope. */
  resultFile: string;
  /** Fresh session identifier for this attempt (UUID). */
  sessionId: string;
  /** Path of Radian's Pi SDK bridge script, for the Pi adapter. */
  bridgeScript?: string;
}

export interface RuntimeLaunchPlan {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  /** Additional read roots beyond the authority (install trees, bridge script directory). */
  readRoots: string[];
  /** Exact tool set the runtime exposes for this role. */
  tools: string[];
  /** Explicit statement of what parity this launch path does and does not provide. */
  parity: { interactiveUi: boolean; herdrAgentDetection: boolean; notes: string };
}

export interface RuntimeAdapter {
  runtime: RuntimeKind;
  /** Versions whose CLI/API surface this adapter was written against. */
  writtenFor: readonly string[];
  detect(): Promise<Outcome<RuntimeInstall>>;
  toolsFor(role: Role, authority: ResolvedAuthority): Outcome<string[]>;
  buildLaunch(input: LaunchInput): Outcome<RuntimeLaunchPlan>;
  parseEvent(line: string): RuntimeEvent[];
  /** One short human-readable line for the pane, or undefined to stay quiet. */
  render(event: RuntimeEvent): string | undefined;
}

/** Fixed first prompt for every runtime: the brief file is the bounded input; no transcript is passed. */
export function initialPrompt(input: Pick<LaunchInput, "briefFile" | "resultFile" | "identity">): string {
  return [
    `You are a Radian ${input.identity.role} worker for assignment ${input.identity.assignment} (attempt ${input.identity.attempt}, generation ${input.identity.generation}).`,
    `Read your sealed assignment brief at ${input.briefFile} and follow it exactly.`,
    `When finished, blocked, or unable to continue, write a radian.result/1 JSON envelope to ${input.resultFile} as described in the brief, then stop.`,
    "Your authority is limited to the brief. Do not change your runtime, model, or effort, and do not start other agents.",
  ].join("\n");
}

export const SAFE_ARG = /^[^\0\n\r]*$/;

export function checkArgv(argv: readonly string[]): boolean {
  return argv.length > 0 && argv.every((arg) => SAFE_ARG.test(arg));
}
