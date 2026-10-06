// W06 / F03 (R04) — approval currency through actual delivery and delayed
// startup: no new worker (or check) begins under a stale approval. Production
// path: the real Coordinator with the production RuntimeWorkerDriver and
// session over a fake Herdr transport (no existing pane), synthetic
// capabilities and credentials, and the real contained launcher under
// sandbox-exec, which the fake pane starts with a delay after "delivery".
// Approval changes happen (a) right after the final local authorization,
// (b) during transport delivery, and (c) as an edit of the approved artifact
// before the delayed launcher starts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { RuntimeWorkerDriver } from "../../../src/coordinator/driver.ts";
import { SupervisionRegistry } from "../../../src/isolation/registry.ts";
import type { HerdrRunner } from "../../../src/runtimes/herdr.ts";
import { removeDir } from "../helpers/fixture.ts";
import { layout } from "../helpers/layout.ts";
import { type World, human, plan, world } from "../helpers/coordinator-world.ts";
import { deps, fakeCodex, native } from "../helpers/session-fixture.ts";

const DELAY_MS = 1_200;

/** A fake pane: "run" succeeds, and the pane's shell starts the launcher command after a delay. */
function delayedPane(calls: string[][], onRun: () => Promise<void> | void): HerdrRunner {
  let n = 0;
  return async (args) => {
    calls.push([...args]);
    if (args[1] === "split") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: `fx:f3-${++n}` } } }), stderr: "", timedOut: false };
    if (args[1] === "run") {
      await onRun();
      setTimeout(() => {
        const child = spawn("/bin/sh", ["-c", args[3]!], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
        child.unref();
      }, DELAY_MS);
    }
    return { code: 0, stdout: "{}", stderr: "", timedOut: false };
  };
}

async function productionWorld(onRun: (w: World) => Promise<void> | void) {
  const w = await world();
  const l = layout();
  const calls: string[][] = [];
  const sessionDeps = { ...deps(l, fakeCodex(l, "bind-and-wait"), calls, true, delayedPane(calls, () => onRun(w))), stateDir: w.stateDir };
  w.coordinator.deps.driver = new RuntimeWorkerDriver(sessionDeps);
  w.coordinator.deps.startupMs = 4_000;
  return { w, l, calls, cleanup: () => (removeDir(w.root), removeDir(l.root)) };
}

/** Every attempt's registry: whether any launcher intent or runtime/check process was recorded. */
function started(w: World): Array<{ attempt: string; intents: number; processes: number }> {
  const out: Array<{ attempt: string; intents: number; processes: number }> = [];
  for (const a of Object.values(w.store.state.assignments)) {
    const registry = new SupervisionRegistry(w.stateDir, a.id);
    for (const attempt of a.attempts) {
      const entries = registry.entries().filter((e) => e.attempt === attempt.id);
      out.push({ attempt: attempt.id, intents: entries.filter((e) => e.kind === "intent").length, processes: entries.filter((e) => e.kind === "process" || e.kind === "check").length });
    }
  }
  return out;
}

async function rejectPlan(w: World) {
  const recorded = await w.store.recordApproval(human(), { kind: "plan", task: w.taskId, artifact: { path: "docs/plan.md", hash: w.artifacts.plan }, decision: "rejected" });
  assert.ok(recorded.ok);
}

const settle = () => new Promise((r) => setTimeout(r, DELAY_MS + 3_000));

test("F03: a rejection right after the final local authorization stops the delivered launcher from starting anything", { skip: native ? false : "requires macOS sandbox-exec" }, async () => {
  const pw = await productionWorld(() => undefined);
  try {
    // Reject in the microtask after the last authorization succeeds (the review's window).
    const coordinator = pw.w.coordinator;
    const authorize = coordinator.launchAuthorization.bind(coordinator);
    let calls = 0;
    coordinator.launchAuthorization = (...args: Parameters<typeof authorize>) => {
      const out = authorize(...args);
      calls += 1;
      if (calls === 5 && out.ok) queueMicrotask(() => void rejectPlan(pw.w));
      return out;
    };
    const outcome = await coordinator.runAssignment(plan(pw.w, "developer"));
    await settle();
    assert.ok(calls >= 5, `the final authorization was reached (${calls})`);
    assert.ok(pw.calls.some((c) => c[1] === "run"), "the launcher command was delivered");
    assert.deepEqual(started(pw.w).filter((s) => s.intents + s.processes > 0), [], "no runtime or check started under the stale approval");
    assert.notEqual(outcome.state, "completed");
  } finally {
    pw.cleanup();
  }
});

test("F03: a rejection during transport delivery stops the delayed launcher, consumes no automatic recovery, and accounts for the attempt", { skip: native ? false : "requires macOS sandbox-exec" }, async () => {
  const pw = await productionWorld((w) => rejectPlan(w));
  try {
    const outcome = await pw.w.coordinator.runAssignment(plan(pw.w, "developer"));
    await settle();
    assert.deepEqual(started(pw.w).filter((s) => s.intents + s.processes > 0), [], "no runtime or check started under the stale approval");
    assert.equal(outcome.state === "blocked" ? outcome.blocker.code.startsWith("APPROVAL") : outcome.state, true, JSON.stringify(outcome));
    const a = Object.values(pw.w.store.state.assignments)[0]!;
    assert.equal(a.attempts.length, 1, "no replacement attempt");
    assert.equal(a.automaticRecoveriesUsed, 0);
    assert.ok(a.attempts[0]!.status === "ended" && a.attempts[0]!.termination === "verified", "the attempt was stopped and verified before release");
    assert.equal((await pw.w.capacity.list()).length, 0);
  } finally {
    pw.cleanup();
  }
});

test("F03: an approved artifact edited before a delayed launcher starts is stale at actual start", { skip: native ? false : "requires macOS sandbox-exec" }, async () => {
  const pw = await productionWorld((w) => {
    // After delivery returned, before the delayed launcher runs.
    setTimeout(() => w.fixture.write("docs/spec.md", "# Spec\nSilently changed after delivery.\n"), 100);
  });
  try {
    const outcome = await pw.w.coordinator.runAssignment(plan(pw.w, "developer"));
    await settle();
    assert.deepEqual(started(pw.w).filter((s) => s.intents + s.processes > 0), [], "the launcher refused: the approved spec no longer matches");
    assert.notEqual(outcome.state, "completed");
  } finally {
    pw.cleanup();
  }
});
