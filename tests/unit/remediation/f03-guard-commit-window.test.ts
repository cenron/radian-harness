// W06 follow-up / F03 (R04) — the window between an approval change's
// pre-commit revocation and its commit. A rejection arrives while the attempt
// is being prepared (during the attempt-brief write): its guard runs before
// the attempt is a pending start, and ordinary run-lock contention delays the
// commit until just after the launch command is delivered. The delayed
// launcher must not start anything once the rejection is committed: a start
// is either fully before the decision or never. Production path: the real
// Coordinator, production RuntimeWorkerDriver and session, fake Herdr
// transport (no existing pane), synthetic capabilities and credentials, and
// the real contained launcher under sandbox-exec.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { RuntimeWorkerDriver } from "../../../src/coordinator/driver.ts";
import { CapabilityRegistry } from "../../../src/isolation/capabilities.ts";
import { SupervisionRegistry } from "../../../src/isolation/registry.ts";
import type { HerdrRunner } from "../../../src/runtimes/herdr.ts";
import { withLock } from "../../../src/state/fsutil.ts";
import { removeDir } from "../helpers/fixture.ts";
import { layout } from "../helpers/layout.ts";
import { human, plan, world } from "../helpers/coordinator-world.ts";
import { deps, fakeCodex, native, source, verifyAll } from "../helpers/session-fixture.ts";

/** Shorter than the coordinator's safety poll, as a real pane's shell start is. */
const PANE_DELAY_MS = 300;

test("F03 window: a rejection whose guard ran before the start was pending, committed after delivery, still starts nothing", { skip: native ? false : "requires macOS sandbox-exec" }, async () => {
  const w = await world();
  const l = layout();
  const calls: string[][] = [];
  let releaseLock: (() => void) | undefined;
  let n = 0;
  const pane: HerdrRunner = async (args) => {
    calls.push([...args]);
    if (args[1] === "split") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: `fx:f3w-${++n}` } } }), stderr: "", timedOut: false };
    if (args[1] === "run") {
      // The contended commit lands just after delivery, before the delayed launcher runs.
      setTimeout(() => releaseLock?.(), 50);
      setTimeout(() => spawn("/bin/sh", ["-c", args[3]!], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } }).unref(), PANE_DELAY_MS);
    }
    return { code: 0, stdout: "{}", stderr: "", timedOut: false };
  };
  try {
    await verifyAll(new CapabilityRegistry(w.stateDir), "developer");
    w.coordinator.deps.driver = new RuntimeWorkerDriver({ ...deps(l, fakeCodex(l, "bind-and-wait"), calls, true, pane), stateDir: w.stateDir, capabilities: new CapabilityRegistry(w.stateDir), projectionRoot: path.join(l.root, "projections") });
    w.coordinator.deps.credentialSourceFor = () => source({ count: 0 });
    w.coordinator.deps.startupMs = 4_000;
    const store = w.store as unknown as { runDir: string; recordAttemptBrief: (...args: unknown[]) => Promise<unknown> };
    const original = store.recordAttemptBrief.bind(store);
    let rejection: Promise<{ ok: boolean }> | undefined;
    store.recordAttemptBrief = async (...args: unknown[]) => {
      const out = await original(...args);
      if (!rejection) {
        // Another run-log writer holds the lock, so the decision commits later.
        void withLock(path.join(store.runDir, "lock"), "contention", () => new Promise<void>((r) => (releaseLock = r)));
        // Contention is bounded: it ends shortly after delivery, or after 400 ms if nothing is delivered.
        setTimeout(() => releaseLock?.(), 400);
        await new Promise((r) => setTimeout(r, 5));
        rejection = w.store.recordApproval(human(), { kind: "plan", task: w.taskId, artifact: { path: "docs/plan.md", hash: w.artifacts.plan }, decision: "rejected" });
      }
      return out;
    };
    const outcome = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.ok(rejection, "the rejection arrived during attempt preparation");
    assert.ok((await rejection).ok, "the rejection committed");
    releaseLock?.();
    await new Promise((r) => setTimeout(r, PANE_DELAY_MS + 2_500));
    const startedAny = Object.values(w.store.state.assignments).flatMap((a) => {
      const registry = new SupervisionRegistry(w.stateDir, a.id);
      return a.attempts.flatMap((attempt) => registry.entries().filter((e) => e.attempt === attempt.id && (e.kind === "intent" || e.kind === "process" || e.kind === "check")).map((e) => e.kind));
    });
    assert.deepEqual(startedAny, [], "no runtime or check started after the rejection committed");
    assert.notEqual(outcome.state, "completed", JSON.stringify(outcome));
    assert.equal((await w.capacity.list()).length, 0, "nothing retained");
  } finally {
    releaseLock?.();
    removeDir(w.root);
    removeDir(l.root);
  }
});
