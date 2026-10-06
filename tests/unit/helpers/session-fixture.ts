// Runtime-session fixtures: a fake interactive runtime script, a scripted fake
// Herdr runner, and session dependencies over a disposable layout. Nothing here
// touches real credentials, real Herdr panes, or live runtimes.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateProfile } from "../../../src/config/provider-policy.ts";
import { sealBrief } from "../../../src/contracts/brief.ts";
import { success } from "../../../src/contracts/blockers.ts";
import { newId, type AssignmentIdentity } from "../../../src/contracts/identity.ts";
import { systemProcessOps } from "../../../src/isolation/processes.ts";
import { createCodexAdapter } from "../../../src/runtimes/codex.ts";
import type { RuntimeAdapter } from "../../../src/runtimes/contract.ts";
import { HerdrTransport, type HerdrRunner } from "../../../src/runtimes/herdr.ts";
import type { SessionDeps } from "../../../src/runtimes/session.ts";
import { authorityFor, type Layout } from "./layout.ts";

/** Real-process fixtures need macOS process tools (ps/lsof). */
export const native = process.platform === "darwin";
export const LAUNCHER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src/isolation/launcher-main.ts");

/**
 * A fake interactive runtime: "bind-and-wait" stays running like an idle
 * session; "write-result" writes `$RESULT_FILE` (if given) and then stays
 * running; "exit-early" exits immediately.
 */
export function fakeCodex(l: Layout, behaviour: "bind-and-wait" | "exit-early" | "write-result"): RuntimeAdapter {
  const dir = path.join(l.root, "fake-runtime");
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "codex");
  const body =
    behaviour === "exit-early"
      ? "#!/bin/sh\nexit 7\n"
      : behaviour === "write-result"
        ? `#!/bin/sh\nprintf '{"synthetic":true}' > "${path.join(l.output, "result.json")}"\nexec /bin/sleep 60\n`
        : "#!/bin/sh\nexec /bin/sleep 60\n";
  writeFileSync(script, body, { mode: 0o755 });
  const real = createCodexAdapter();
  return { ...real, detect: async () => success({ runtime: "codex" as const, executable: script, version: "fixture" }) };
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
    transport: new HerdrTransport({ runner, stateDir: l.state }),
    supervision: {
      health: () => (healthy ? success(true as const) : { ok: false, blocker: { code: "SUPERVISION_UNHEALTHY", message: "watcher gone" } }),
      watch: async () => {},
      unwatch: async () => {},
    },
    ops: systemProcessOps,
    stateDir: l.state,
    launcherArgv: [process.execPath, LAUNCHER],
    parentPane: "fx:p0",
    graceMs: 300,
    hostEnv: { PATH: "/usr/bin:/bin", HOME: l.scratch },
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
  return { identity, profile: profile.value, authority, brief: sealed.value, briefText: "# Synthetic brief", systemPrompt: "synthetic" };
}
