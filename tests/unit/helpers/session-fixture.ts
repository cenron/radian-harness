// Runtime-session fixtures: a fake Codex-shaped runtime script, synthetic
// credential source, capability records bound to a synthetic context, a
// scripted fake Herdr runner, and session dependencies over a disposable layout.
// Nothing here touches real credentials, real Herdr panes, or live runtimes.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateProfile } from "../../../src/config/provider-policy.ts";
import { sealBrief } from "../../../src/contracts/brief.ts";
import { success } from "../../../src/contracts/blockers.ts";
import { newId, type AssignmentIdentity } from "../../../src/contracts/identity.ts";
import { CapabilityRegistry, requiredCapabilities, type CapabilityContext } from "../../../src/isolation/capabilities.ts";
import { CredentialBroker, type CredentialSource } from "../../../src/isolation/credentials.ts";
import { systemProcessOps } from "../../../src/isolation/processes.ts";
import { PROFILE_TEMPLATE_VERSION } from "../../../src/isolation/profile.ts";
import { createCodexAdapter } from "../../../src/runtimes/codex.ts";
import type { RuntimeAdapter } from "../../../src/runtimes/contract.ts";
import { HerdrTransport, type HerdrRunner } from "../../../src/runtimes/herdr.ts";
import type { SessionDeps } from "../../../src/runtimes/session.ts";
import { HumanChannel } from "../../../src/state/approvals.ts";
import { authorityFor, type Layout } from "./layout.ts";

export const native = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
export const LAUNCHER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src/isolation/launcher-main.ts");
export const OS = "27.0";

export function fakeCodex(l: Layout, behaviour: "bind-and-wait" | "exit-early"): RuntimeAdapter {
  const dir = path.join(l.root, "fake-runtime");
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "codex");
  const body = behaviour === "bind-and-wait"
    ? `#!/bin/sh\necho '{"type":"thread.started","thread_id":"t-1"}'\necho '{"type":"turn.started"}'\nexec /bin/sleep 60\n`
    : "#!/bin/sh\nexit 7\n";
  writeFileSync(script, body, { mode: 0o755 });
  const real = createCodexAdapter();
  return { ...real, detect: async () => success({ runtime: "codex" as const, executable: script, version: "fixture", installRoots: [dir], helpers: [] }) };
}

export function source(reads: { count: number }): CredentialSource {
  return {
    runtime: "codex",
    provider: "openai",
    describe: "synthetic",
    async read() {
      reads.count += 1;
      return success({ kind: "subscription-oauth" as const, expiresAtMs: Date.now() + 4 * 3_600_000, fingerprint: "sha256:synthetic", payload: { tokens: { access_token: "synthetic-not-a-token" } } });
    },
  };
}

export async function verifyAll(registry: CapabilityRegistry, role: "developer"): Promise<CapabilityContext> {
  const context: CapabilityContext = { osVersion: OS, runtime: "codex", runtimeVersion: "fixture", policyTemplate: PROFILE_TEMPLATE_VERSION };
  const human = HumanChannel.fromUserInput("user-command", "fixture-user", "/radian capability");
  for (const capability of requiredCapabilities("codex", role)) await registry.record(human, { capability, status: "verified", context, reference: "synthetic fixture only" });
  return context;
}

export function paneRunner(calls: string[][]): HerdrRunner {
  let n = 0;
  return async (args) => {
    calls.push([...args]);
    if (args[1] === "split") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: `fx:p${++n}` } } }), stderr: "", timedOut: false };
    if (args[1] === "run") {
      // Simulate the pane's shell executing the launcher command.
      const child = spawn("/bin/sh", ["-c", args[3]!], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
      child.unref();
    }
    return { code: 0, stdout: "{}", stderr: "", timedOut: false };
  };
}

export function deps(l: Layout, adapter: RuntimeAdapter, calls: string[][], healthy = true, runner: HerdrRunner = paneRunner(calls)): SessionDeps {
  return {
    adapters: { codex: adapter },
    capabilities: new CapabilityRegistry(l.state),
    broker: new CredentialBroker(),
    transport: new HerdrTransport({ runner, stateDir: l.state }),
    supervision: {
      health: () => (healthy ? success(true as const) : { ok: false, blocker: { code: "SUPERVISION_UNHEALTHY", message: "watcher gone" } }),
      watch: async () => {},
      unwatch: async () => {},
    },
    ops: systemProcessOps,
    stateDir: l.state,
    projectionRoot: path.join(l.root, "projections"),
    osVersion: OS,
    launcherArgv: [process.execPath, LAUNCHER],
    parentPane: "fx:p0",
    denyRead: [l.secret],
    graceMs: 300,
    terminal: "none",
  };
}

export function request(l: Layout) {
  const authority = authorityFor(l);
  const identity: AssignmentIdentity = { workspace: newId("ws"), project: newId("prj"), run: newId("run"), task: newId("task"), assignment: newId("asg"), attempt: newId("att"), generation: 1, role: "developer" };
  const profile = evaluateProfile("codex", { runtime: "codex", provider: "openai", model: "gpt-test-1", effort: "medium" }, {});
  if (!profile.ok) throw new Error("profile");
  const sealed = sealBrief({
    schema: "radian.brief/1", identity, round: { current: 1, max: 3 }, objective: "Synthetic objective.", nonGoals: [], acceptanceCriteria: ["synthetic"],
    approvals: [{ kind: "spec", approvalId: "apr_fixture1", artifact: { path: "docs/spec.md", hash: "sha256:" + "a".repeat(64) } }],
    base: { commit: "b".repeat(40), checkout: "wt_fixture1" }, authority, profile: { name: "codex", runtime: "codex", provider: "openai", model: "gpt-test-1", effort: "medium", selection: "default" },
    deliverables: [], requiredChecks: [], budget: { executionMsRemaining: 1_800_000, automaticRecoveriesRemaining: 1 }, context: [], decisionRoute: "coordinator", configSnapshot: "sha256:" + "c".repeat(64),
  });
  if (!sealed.ok) throw new Error(sealed.blocker.message);
  return { identity, profile: profile.value, authority, brief: sealed.value, briefText: "# Synthetic brief", systemPrompt: "synthetic", minValidityMs: 3_600_000 };
}
