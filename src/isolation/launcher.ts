// Contained assignment launcher. The coordinator writes a launch spec into
// protected state and passes its hash; the launcher (running in the assignment's
// terminal) verifies the spec, re-checks required capabilities and the launch
// environment, records registration intent, generates the Seatbelt profile with
// its own terminal device, starts the runtime under `sandbox-exec`, and
// registers the runtime's identity before the coordinator confirms binding.
// Any failure refuses the launch; there is no unsandboxed fallback.
//
// For exact-candidate checks the launcher first runs each approved check
// argument vector itself, under a profile with the same authority but no
// credential access, and records its exit status in the protected supervision
// registry. That record — not a worker's report — is the check's execution
// evidence. Output goes to the worker-readable output directory for analysis.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { type AssignmentIdentity, assignmentIdentitySchema } from "../contracts/identity.ts";
import { canonicalJson, sha256 } from "../util/canonical.ts";
import { type IdentityProbe, psProbe } from "../util/process-identity.ts";
import { atomicWrite } from "../state/fsutil.ts";
import { type CapabilityContext, type CapabilityId, CapabilityRegistry } from "./capabilities.ts";
import { assertNoProhibitedEnv } from "./credentials.ts";
import { type ProfileInput, TERMINAL_PATTERN, generateProfile } from "./profile.ts";
import { SupervisionRegistry } from "./registry.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface LaunchSpec {
  schema: "radian.launch/1";
  identity: AssignmentIdentity;
  stateDir: string;
  profile: ProfileInput;
  /** Absolute runtime executable followed by arguments; never a shell string. */
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  requiredCapabilities: CapabilityId[];
  capabilityContext: CapabilityContext;
  /** "assigned" grants the launcher's own terminal device; "none" grants no terminal. */
  terminal: "assigned" | "none";
  /** Capture the runtime's JSONL stdout into protected state and render a summary in the pane. */
  events?: { file: string; runtime: "pi" | "codex" | "claude-code" };
  /** Approved candidate checks the launcher runs (contained, no credentials) before the runtime starts. */
  checks?: { runs: CheckRun[]; timeoutMs: number; logDir: string; env: Record<string, string> };
}

export interface CheckRun {
  id: string;
  /** Approved argument vector; argv[0] is resolved on the check environment's PATH by sandbox-exec. */
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
  if (spec.schema !== "radian.launch/1" || !assignmentIdentitySchema.parse(spec.identity).ok) return refuse("POLICY_TAMPERED", "launch spec is malformed");
  if (!Array.isArray(spec.argv) || spec.argv.length === 0 || !path.isAbsolute(spec.argv[0]!)) return refuse("POLICY_TAMPERED", "launch argv must start with an absolute executable");
  return success(spec);
}

export function terminalDevice(pid: number): string | undefined {
  const result = spawnSync("/bin/ps", ["-o", "tty=", "-p", String(pid)], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, encoding: "utf8", timeout: 5000 });
  const tty = (result.stdout ?? "").trim();
  if (!tty || tty === "??") return undefined;
  const device = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
  return TERMINAL_PATTERN.test(device) ? device : undefined;
}

export interface PreparedLaunch {
  spec: LaunchSpec;
  profileFile: string;
  profileHash: string;
  /** Profile for approved checks: the same authority with the credential projection denied. */
  checkProfileFile?: string;
  registry: SupervisionRegistry;
}

/** All checks that must pass before anything is started. */
export function prepareLaunch(specFile: string, expectedHash: string, terminal: string | undefined): Outcome<PreparedLaunch> {
  const read = readSpec(specFile, expectedHash);
  if (!read.ok) return read;
  const spec = read.value;
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) return refuse("CONTAINMENT_UNAVAILABLE", "native macOS containment (sandbox-exec) is unavailable", "Execution stays disabled; no weaker mode is used.");
  const capabilities = new CapabilityRegistry(spec.stateDir).require(spec.requiredCapabilities, spec.capabilityContext);
  if (!capabilities.ok) return capabilities;
  const env = assertNoProhibitedEnv(spec.env);
  if (!env.ok) return env;
  let profileInput: ProfileInput = spec.profile;
  if (spec.terminal === "assigned") {
    if (!terminal) return refuse("CONTAINMENT_UNAVAILABLE", "the assigned terminal device cannot be determined");
    profileInput = { ...profileInput, terminal };
  }
  const profile = generateProfile(profileInput);
  if (!profile.ok) return profile;
  const profileFile = path.join(path.dirname(specFile), `${spec.identity.attempt}.sb`);
  writeFileSync(profileFile, profile.value.text, { mode: 0o400, flag: "w" });
  const prepared: PreparedLaunch = { spec, profileFile, profileHash: profile.value.hash, registry: new SupervisionRegistry(spec.stateDir, spec.identity.assignment) };
  if (spec.checks) {
    if (spec.checks.runs.some((run) => !Array.isArray(run.argv) || run.argv.length === 0 || !/^[A-Za-z0-9._-]{1,128}$/.test(run.id))) return refuse("POLICY_TAMPERED", "check runs are malformed");
    const checkEnv = assertNoProhibitedEnv(spec.checks.env);
    if (!checkEnv.ok) return checkEnv;
    const { credentialDir, ...rest } = profileInput;
    const checkProfile = generateProfile({ ...rest, denyRead: [...(rest.denyRead ?? []), ...(credentialDir ? [credentialDir] : [])] });
    if (!checkProfile.ok) return checkProfile;
    prepared.checkProfileFile = path.join(path.dirname(specFile), `${spec.identity.attempt}-checks.sb`);
    writeFileSync(prepared.checkProfileFile, checkProfile.value.text, { mode: 0o400, flag: "w" });
  }
  return success(prepared);
}

export interface LaunchResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Start the contained runtime. Registration intent precedes spawn; the
 * runtime's PID + start time are registered immediately after spawn and before
 * the coordinator is allowed to confirm assignment binding.
 */
export async function launchContained(
  prepared: PreparedLaunch,
  options: { stdio?: "inherit" | "ignore"; probe?: IdentityProbe; onRegistered?: () => void; render?: (line: string) => string | undefined; write?: (text: string) => void } = {},
): Promise<Outcome<LaunchResult>> {
  const { spec, registry } = prepared;
  if (spec.checks && prepared.checkProfileFile) {
    const deadline = Date.now() + spec.checks.timeoutMs;
    for (const run of spec.checks.runs) {
      if (!(await runContainedCheck(prepared, prepared.checkProfileFile, run, deadline, options.probe ?? psProbe))) return revokedLaunch();
    }
  }
  if (!(await registry.appendIntent(spec.identity.attempt, "runtime"))) return revokedLaunch();
  const capture = spec.events !== undefined;
  const child = spawn(SANDBOX_EXEC, ["-f", prepared.profileFile, "--", ...spec.argv], {
    cwd: spec.cwd,
    env: { ...spec.env, RADIAN_ASSIGNMENT: spec.identity.assignment, RADIAN_ATTEMPT: spec.identity.attempt },
    stdio: capture ? [options.stdio ?? "inherit", "pipe", options.stdio ?? "inherit"] : (options.stdio ?? "inherit"),
  });
  if (child.pid === undefined) return refuse("CONTAINMENT_UNAVAILABLE", "contained runtime failed to start");
  const closed = new Promise<LaunchResult>((resolve) => child.on("close", (code, signal) => resolve({ exitCode: code, signal })));
  if (capture && child.stdout) {
    // Split strictly on LF (not Unicode separators) and keep the raw records in protected state.
    let buffered = "";
    const write = options.write ?? ((text: string) => process.stdout.write(text));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let index: number;
      while ((index = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, index).replace(/\r$/, "");
        buffered = buffered.slice(index + 1);
        if (line.length === 0) continue;
        appendFileSync(spec.events!.file, line + "\n", { mode: 0o600 });
        const rendered = options.render?.(line);
        if (rendered) write(rendered + "\n");
      }
    });
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
 * Run one approved check under containment in its own process group, register
 * it like any owned process, and record its exit status as execution evidence.
 * A check that cannot be spawned or observed leaves its intent unresolved, so
 * termination stays unknown rather than assumed.
 */
async function runContainedCheck(prepared: PreparedLaunch, profileFile: string, run: CheckRun, deadline: number, probe: IdentityProbe): Promise<boolean> {
  const { spec, registry } = prepared;
  const checks = spec.checks!;
  const attempt = spec.identity.attempt;
  const label = `check:${run.id}`;
  if (!(await registry.appendIntent(attempt, label))) return false;
  const log = openSync(path.join(checks.logDir, `check-${run.id}.log`), "w", 0o600);
  let child;
  try {
    child = spawn(SANDBOX_EXEC, ["-f", profileFile, "--", ...run.argv], { cwd: spec.cwd, env: checks.env, stdio: ["ignore", log, log], detached: true });
  } finally {
    closeSync(log);
  }
  const pid = child.pid;
  if (pid === undefined) {
    await registry.append({ kind: "check", attempt, id: run.id, exitCode: null, signal: null, timedOut: false });
    return true;
  }
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: null, signal: null }));
  });
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
