// Runtime installation detection: resolve the executable, read its version via
// `--version` (no model, network, or authentication activity), and compare it
// with the versions an adapter was written against. Other versions are refused
// rather than assumed compatible.

import { realpathSync } from "node:fs";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { RuntimeKind } from "../contracts/identity.ts";
import { resolveExecutable, run, succeeded } from "../util/proc.ts";

export async function readVersion(executable: string, env: Record<string, string> = {}): Promise<Outcome<string>> {
  const result = await run(executable, ["--version"], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/nonexistent-radian-home", ...env }, timeoutMs: 20_000 });
  if (!succeeded(result)) return refuse("RUNTIME_UNAVAILABLE", "runtime did not report a version");
  const match = /(\d+\.\d+\.\d+)/.exec(result.stdout.toString("utf8"));
  if (!match?.[1]) return refuse("RUNTIME_UNAVAILABLE", "runtime version output is unrecognized");
  return success(match[1]);
}

export function locate(runtime: RuntimeKind, name: string, override: string | undefined): Outcome<string> {
  const found = resolveExecutable(override ?? name, override ? undefined : process.env.PATH);
  if (!found) return refuse("RUNTIME_UNAVAILABLE", `${runtime} executable not found`, "Install the runtime yourself; Radian does not install host-global tools.");
  try {
    return success(realpathSync(found));
  } catch {
    return refuse("RUNTIME_UNAVAILABLE", `${runtime} executable cannot be resolved`);
  }
}

export function requireWrittenFor(runtime: RuntimeKind, version: string, writtenFor: readonly string[]): Outcome<true> {
  if (!writtenFor.includes(version)) {
    return refuse("RUNTIME_VERSION_UNSUPPORTED", `${runtime} ${version} differs from the adapter's reviewed version(s) ${writtenFor.join(", ")}`, "Review the runtime's CLI/API changes and update the adapter before use.");
  }
  return success(true);
}
