// Contained assignment launcher. The coordinator writes a launch spec into
// protected state and passes its hash; the launcher (running in the assignment's
// terminal) verifies the spec, re-checks required capabilities and the launch
// environment, records registration intent, generates the Seatbelt profile with
// its own terminal device, starts the runtime under `sandbox-exec`, and
// registers the runtime's identity before the coordinator confirms binding.
// Any failure refuses the launch; there is no unsandboxed fallback.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  return success({ spec, profileFile, profileHash: profile.value.hash, registry: new SupervisionRegistry(spec.stateDir, spec.identity.assignment) });
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
export async function launchContained(prepared: PreparedLaunch, options: { stdio?: "inherit" | "ignore"; probe?: IdentityProbe; onRegistered?: () => void } = {}): Promise<Outcome<LaunchResult>> {
  const { spec, registry } = prepared;
  await registry.append({ kind: "intent", attempt: spec.identity.attempt, label: "runtime" });
  const child = spawn(SANDBOX_EXEC, ["-f", prepared.profileFile, "--", ...spec.argv], {
    cwd: spec.cwd,
    env: { ...spec.env, RADIAN_ASSIGNMENT: spec.identity.assignment, RADIAN_ATTEMPT: spec.identity.attempt },
    stdio: options.stdio ?? "inherit",
  });
  if (child.pid === undefined) return refuse("CONTAINMENT_UNAVAILABLE", "contained runtime failed to start");
  const observed = (options.probe ?? psProbe)(child.pid);
  if (observed.state !== "running") {
    // It may already have exited; the intent stays unresolved so termination is "unknown" until reconciled.
    const exit = await new Promise<LaunchResult>((resolve) => child.on("close", (code, signal) => resolve({ exitCode: code, signal })));
    return success(exit);
  }
  await registry.append({ kind: "process", attempt: spec.identity.attempt, label: "runtime", identity: { pid: child.pid, start: observed.start }, source: "launcher" });
  options.onRegistered?.();
  const result = await new Promise<LaunchResult>((resolve) => child.on("close", (code, signal) => resolve({ exitCode: code, signal })));
  return success(result);
}
