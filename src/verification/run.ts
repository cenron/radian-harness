// One complete Claude Code capability verification (Tiers 1–3) and the
// version context each passed item is recorded under. Recording itself is
// done only by the interactive `/radian capabilities verify` command.

import type { CapabilityContext, CapabilityId } from "../isolation/capabilities.ts";
import { PROFILE_TEMPLATE_VERSION } from "../isolation/profile.ts";
import { createClaudeAdapter } from "../runtimes/claude.ts";
import { type CheckResult, nativeAvailable } from "./harness.ts";
import { TIER1 } from "./tier1.ts";
import { runTier2 } from "./tier2.ts";
import { runTier3 } from "./tier3.ts";

export interface VerificationRun {
  runtime: "claude-code";
  runtimeVersion: string | undefined;
  osVersion: string;
  results: CheckResult[];
  /** Non-secret login facts (auth method, provider, subscription type). */
  login: Record<string, string>;
}

/** Items whose evidence depends on the runtime and its version; the rest hold for this macOS and policy template. */
export function runtimeBound(capability: CapabilityId): boolean {
  return /^(runtime|credential|billing)\./.test(capability) || capability === "containment.dependency-access-audit";
}

export function evidenceContext(capability: CapabilityId, run: Pick<VerificationRun, "runtime" | "runtimeVersion" | "osVersion">): CapabilityContext {
  return runtimeBound(capability) ? { osVersion: run.osVersion, runtime: run.runtime, ...(run.runtimeVersion ? { runtimeVersion: run.runtimeVersion } : {}), policyTemplate: PROFILE_TEMPLATE_VERSION } : { osVersion: run.osVersion, policyTemplate: PROFILE_TEMPLATE_VERSION };
}

export async function verifyClaudeCode(osVersion: string, progress: (message: string) => void = () => {}): Promise<VerificationRun> {
  const install = await createClaudeAdapter().detect();
  const run: VerificationRun = { runtime: "claude-code", runtimeVersion: install.ok ? install.value.version : undefined, osVersion, results: [], login: {} };
  if (!nativeAvailable()) {
    run.results.push({ capability: "containment.sandbox-exec.filesystem", passed: false, details: ["FAIL requires macOS with /usr/bin/sandbox-exec"] });
    return run;
  }
  progress("Tier 1: sandbox, signals, network, dependency access, supervision…");
  for (const check of TIER1) {
    try {
      run.results.push(await check());
    } catch (error) {
      run.results.push({ capability: "containment.sandbox-exec.filesystem", passed: false, details: [`FAIL ${check.name}: ${(error as Error).message}`] });
    }
  }
  progress("Tier 2: Claude Code launch and scoped login…");
  const tier2 = await runTier2();
  run.results.push(...tier2.results);
  run.login = tier2.login;
  progress("Tier 3: tiny real Claude Code tasks and a Herdr pane…");
  run.results.push(...(await runTier3()));
  return run;
}
