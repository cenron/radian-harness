// Runtime adapter contract shared by Pi, Codex CLI, and Claude Code. An adapter
// turns a validated assignment into the exact command line for that runtime's
// normal interactive session (model, effort, role system prompt, tool limits,
// and the first task message), run by Radian's launcher in an owned Herdr pane.

import type { Outcome } from "../contracts/blockers.ts";
import type { ResolvedAuthority } from "../contracts/authority.ts";
import type { AssignmentIdentity, Role, RuntimeKind } from "../contracts/identity.ts";
import type { ResolvedProfile } from "../config/provider-policy.ts";

export interface RuntimeInstall {
  runtime: RuntimeKind;
  executable: string;
  version: string;
}

export type ErrorClass = "quota" | "authentication" | "trust-permission" | "infrastructure" | "unknown";

export interface ClassifiedError {
  class: ErrorClass;
  /** Reliable reset time (epoch ms) only when the runtime supplied an explicit timestamp. */
  resetAtMs?: number;
  /** Sanitized summary; never raw provider payloads or credentials. */
  summary: string;
}

export interface LaunchInput {
  identity: AssignmentIdentity;
  profile: ResolvedProfile;
  authority: ResolvedAuthority;
  install: RuntimeInstall;
  /** The role guide, given to the runtime as its (appended) system prompt. */
  systemPrompt: string;
  /** File (in the output directory) holding the sealed brief text the worker reads. */
  briefFile: string;
  /** Where the worker must write its `radian.result/1` envelope. */
  resultFile: string;
  /** Fresh session identifier for this attempt (UUID), for runtimes that accept one. */
  sessionId: string;
}

export interface RuntimeLaunchPlan {
  /** Absolute executable followed by arguments; never a shell string. */
  argv: string[];
  /** Environment overrides on top of the user's environment (API-key/endpoint variables are always removed). */
  env: Record<string, string>;
  cwd: string;
  /** Exact tool set the session exposes for this role. */
  tools: string[];
}

export interface RuntimeAdapter {
  runtime: RuntimeKind;
  /** Versions whose CLI surface this adapter was written against. */
  writtenFor: readonly string[];
  detect(): Promise<Outcome<RuntimeInstall>>;
  toolsFor(role: Role, authority: ResolvedAuthority): Outcome<string[]>;
  buildLaunch(input: LaunchInput): Outcome<RuntimeLaunchPlan>;
}

/** First message of every worker session: the brief file is the bounded input; no transcript is passed. */
export function initialPrompt(input: Pick<LaunchInput, "briefFile" | "resultFile" | "identity">): string {
  return [
    `You are a Radian ${input.identity.role} worker for assignment ${input.identity.assignment} (attempt ${input.identity.attempt}, generation ${input.identity.generation}).`,
    `Read your assignment brief at ${input.briefFile} and follow it exactly.`,
    `When finished, blocked, or unable to continue, write the radian.result/1 JSON result to ${input.resultFile} exactly as the brief describes, then stop and wait.`,
    "Your authority is limited to the brief. Do not change your model or effort, and do not start other agents.",
  ].join(" ");
}

export const SAFE_ARG = /^[^\0]*$/;

export function checkArgv(argv: readonly string[]): boolean {
  return argv.length > 0 && argv.every((arg) => SAFE_ARG.test(arg));
}
