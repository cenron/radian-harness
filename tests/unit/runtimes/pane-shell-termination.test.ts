// A real Herdr pane keeps its own shell running (in the pane's working
// directory) after the worker exits, until the pane is closed. The live
// Claude Code run created worker panes in the worktree, so termination
// discovery found the unregistered shell inside an owned root and every
// stop ended "unknown", retaining capacity and worktrees. The pane's shell
// must live outside the worker's owned roots so a clean exit verifies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { CapabilityRegistry } from "../../../src/isolation/capabilities.ts";
import type { HerdrRunner } from "../../../src/runtimes/herdr.ts";
import { awaitBinding, launchAttempt, stopAttempt } from "../../../src/runtimes/session.ts";
import { removeDir } from "../helpers/fixture.ts";
import { authorityFor, layout } from "../helpers/layout.ts";
import { deps, fakeCodex, native, request, source, verifyAll } from "../helpers/session-fixture.ts";

/** A pane that, like Herdr, runs a long-lived shell in the requested --cwd and closes it on `pane close`. */
function shellPane(shells: Map<string, number>): HerdrRunner {
  let n = 0;
  return async (args) => {
    if (args[1] === "split") {
      const id = `fx:shell-${++n}`;
      const cwd = args[args.indexOf("--cwd") + 1]!;
      const shell = spawn("/bin/sleep", ["600"], { cwd, detached: true, stdio: "ignore" });
      shell.unref();
      shells.set(id, shell.pid!);
      return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: id } } }), stderr: "", timedOut: false };
    }
    if (args[1] === "run") {
      const child = spawn("/bin/sh", ["-c", args[3]!], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
      child.unref();
    }
    if (args[1] === "close") {
      const pid = shells.get(args[2]!);
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    return { code: 0, stdout: "{}", stderr: "", timedOut: false };
  };
}

test("a worker pane's own shell does not make a clean stop unknown", { skip: native ? false : "requires macOS sandbox-exec" }, async () => {
  const l = layout();
  const shells = new Map<string, number>();
  try {
    await verifyAll(new CapabilityRegistry(l.state), "developer");
    const d = deps(l, fakeCodex(l, "bind-and-wait"), [], true, shellPane(shells));
    const launched = await launchAttempt(d, { ...request(l), credentialSource: source({ count: 0 }) });
    assert.ok(launched.ok, launched.ok ? "" : launched.blocker.message);
    if (!launched.ok) return;
    const bound = await awaitBinding(d, launched.value, Date.now() + 20_000);
    assert.ok(bound.ok, bound.ok ? "" : bound.blocker.message);
    const stopped = await stopAttempt(d, launched.value, authorityFor(l));
    assert.equal(stopped.termination.postcondition, "verified", `survivors: ${stopped.termination.survivors.length}; ${stopped.termination.reasons.join("; ")}`);
    assert.ok(stopped.paneClosed, "the pane is closed after verified termination");
  } finally {
    for (const pid of shells.values()) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    removeDir(l.root);
  }
});
