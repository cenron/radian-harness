// Assignment launcher. The coordinator writes a launch spec into its private
// state and passes the spec's hash; the launcher (running in the worker's owned
// Herdr pane) verifies the spec, records a registration intent under the
// supervision registry lock (where the revision-bound start gate is checked),
// starts the runtime's interactive session on the pane's own terminal, and
// registers the runtime's process identity so the coordinator and watcher can
// stop it. There is no OS sandbox (isolation is deferred past the MVP).
//
// For exact-candidate checks the launcher first runs each approved check
// argument vector itself in the worktree and records its exit status in the
// supervision registry. That record — not a worker's report — is the check's
// execution evidence. Output goes to the output directory for analysis.

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { type AssignmentIdentity, assignmentIdentitySchema } from "../contracts/identity.ts";
import { canonicalJson, hashJson, sha256 } from "../util/canonical.ts";
import { readConfined } from "../util/confined-fs.ts";
import { type IdentityProbe, psProbe } from "../util/process-identity.ts";
import { atomicWrite } from "../state/fsutil.ts";
import { SupervisionRegistry } from "./registry.ts";

export interface LaunchSpec {
  schema: "radian.launch/2";
  identity: AssignmentIdentity;
  stateDir: string;
  /** Absolute runtime executable followed by arguments; never a shell string. */
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  /** Approved candidate checks the launcher runs before the runtime starts. */
  checks?: { runs: CheckRun[]; timeoutMs: number; logDir: string; env: Record<string, string> };
  /**
   * Revision-bound start authorization (W06/F03): every product-approval
   * artifact this attempt was authorized against, re-hashed (without following
   * links) under the registry lock immediately before each intent. A changed
   * or unreadable artifact revokes the attempt; nothing starts.
   */
  startGate?: { projectRoot: string; artifacts: Array<{ kind: string; path: string; hash: string }> };
}

/** Undefined when every approved artifact still has its authorized content; otherwise why not. */
export function startGateFailure(spec: Pick<LaunchSpec, "startGate">): string | undefined {
  const gate = spec.startGate;
  if (!gate) return undefined;
  for (const artifact of gate.artifacts) {
    const read = readConfined(gate.projectRoot, artifact.path);
    if (!read.ok) return `approved ${artifact.kind} artifact is unreadable at start`;
    if (hashJson({ content: read.value }) !== artifact.hash) return `approved ${artifact.kind} artifact changed before start`;
  }
  return undefined;
}

export interface CheckRun {
  id: string;
  /** Approved argument vector; argv[0] is resolved on the check environment's PATH. */
  argv: string[];
}

export function specHash(spec: LaunchSpec): string {
  return "sha256:" + sha256(canonicalJson(spec));
}

export function writeSpec(file: string, spec: LaunchSpec): string {
  atomicWrite(file, canonicalJson(spec));
  return specHash(spec);
}

export function readSpec(file: string, expectedHash: string): Outcome<LaunchSpec> {
  let spec: LaunchSpec;
  try {
    spec = JSON.parse(readFileSync(file, "utf8")) as LaunchSpec;
  } catch {
    return refuse("POLICY_TAMPERED", "launch spec is missing or unreadable");
  }
  if (specHash(spec) !== expectedHash) return refuse("POLICY_TAMPERED", "launch spec does not match the coordinator's recorded hash");
  if (spec.schema !== "radian.launch/2" || !assignmentIdentitySchema.parse(spec.identity).ok) return refuse("POLICY_TAMPERED", "launch spec is malformed");
  if (!Array.isArray(spec.argv) || spec.argv.length === 0 || !path.isAbsolute(spec.argv[0]!)) return refuse("POLICY_TAMPERED", "launch argv must start with an absolute executable");
  return success(spec);
}

export interface PreparedLaunch {
  spec: LaunchSpec;
  registry: SupervisionRegistry;
}

/** All checks that must pass before anything is started. */
export function prepareLaunch(specFile: string, expectedHash: string): Outcome<PreparedLaunch> {
  const read = readSpec(specFile, expectedHash);
  if (!read.ok) return read;
  const spec = read.value;
  if (spec.checks && spec.checks.runs.some((run) => !Array.isArray(run.argv) || run.argv.length === 0 || !/^[A-Za-z0-9._-]{1,128}$/.test(run.id))) return refuse("POLICY_TAMPERED", "check runs are malformed");
  return success({ spec, registry: new SupervisionRegistry(spec.stateDir, spec.identity.assignment) });
}

export interface LaunchResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Start the runtime's interactive session. Registration intent precedes
 * spawn; the runtime's PID + start time are registered immediately after
 * spawn, before the coordinator confirms binding.
 */
export async function launchRuntime(prepared: PreparedLaunch, options: { stdio?: "inherit" | "ignore"; probe?: IdentityProbe; onRegistered?: () => void } = {}): Promise<Outcome<LaunchResult>> {
  const { spec, registry } = prepared;
  if (spec.checks) {
    const deadline = Date.now() + spec.checks.timeoutMs;
    for (const run of spec.checks.runs) {
      if (!(await runCheck(prepared, run, deadline, options.probe ?? psProbe))) return revokedLaunch();
    }
  }
  if (!(await registry.appendIntent(spec.identity.attempt, "runtime", () => startGateFailure(spec)))) return revokedLaunch();
  const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...spec.env, RADIAN_ASSIGNMENT: spec.identity.assignment, RADIAN_ATTEMPT: spec.identity.attempt },
    stdio: options.stdio ?? "inherit",
  });
  const closed = new Promise<LaunchResult>((resolve) => {
    child.on("close", (code, signal) => resolve({ exitCode: code, signal }));
    child.on("error", () => resolve({ exitCode: null, signal: null }));
  });
  if (child.pid === undefined) {
    await registry.append({ kind: "exited", attempt: spec.identity.attempt, exitCode: null, signal: null });
    return refuse("RUNTIME_UNAVAILABLE", "the runtime failed to start");
  }
  const observed = (options.probe ?? psProbe)(child.pid);
  if (observed.state !== "running") {
    // It may already have exited; the intent stays unresolved so termination is "unknown" until reconciled.
    const exit = await closed;
    await registry.append({ kind: "exited", attempt: spec.identity.attempt, exitCode: exit.exitCode, signal: exit.signal });
    return success(exit);
  }
  await registry.append({ kind: "process", attempt: spec.identity.attempt, label: "runtime", identity: { pid: child.pid, start: observed.start }, source: "launcher" });
  options.onRegistered?.();
  const result = await closed;
  await registry.append({ kind: "exited", attempt: spec.identity.attempt, exitCode: result.exitCode, signal: result.signal });
  return success(result);
}

/**
 * Run one approved check in its own process group, register it like any owned
 * process, and record its exit status as execution evidence. A check that
 * cannot be spawned or observed leaves its intent unresolved, so termination
 * stays unknown rather than assumed.
 */
async function runCheck(prepared: PreparedLaunch, run: CheckRun, deadline: number, probe: IdentityProbe): Promise<boolean> {
  const { spec, registry } = prepared;
  const checks = spec.checks!;
  const attempt = spec.identity.attempt;
  const label = `check:${run.id}`;
  if (!(await registry.appendIntent(attempt, label, () => startGateFailure(spec)))) return false;
  const log = openSync(path.join(checks.logDir, `check-${run.id}.log`), "w", 0o600);
  let child;
  try {
    child = spawn(run.argv[0]!, run.argv.slice(1), { cwd: spec.cwd, env: checks.env, stdio: ["ignore", log, log], detached: true });
  } finally {
    closeSync(log);
  }
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: null, signal: null }));
  });
  const pid = child.pid;
  if (pid === undefined) {
    await closed;
    await registry.append({ kind: "check", attempt, id: run.id, exitCode: null, signal: null, timedOut: false });
    return true;
  }
  const observed = probe(pid);
  if (observed.state === "running") await registry.append({ kind: "process", attempt, label, identity: { pid, start: observed.start }, source: "launcher" });
  let timedOut = false;
  const killGroup = () => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, Math.max(0, deadline - Date.now()));
  const result = await closed;
  clearTimeout(timer);
  // Leftover background processes from the check's group are not allowed to outlive it.
  killGroup();
  await registry.append({ kind: "check", attempt, id: run.id, exitCode: result.code, signal: result.signal, timedOut });
  return true;
}

function revokedLaunch(): Outcome<LaunchResult> {
  return refuse("OWNERSHIP_AMBIGUOUS", "the coordinator revoked this launch before it started; nothing was run", "No action needed; the attempt was stopped and reconciled.");
}
