// W06 / F04 follow-up (independent review) — after a supervision/lease loss
// whose retry stop of retained work is *also* unknown, the coordinator stays
// halted and the work stays owned: no slot or worktree reuse, a later explicit
// cancel still retries the stop and releases exactly once when verified,
// shutdown never orderly releases the watcher, and a concurrent cancel and
// loss share one stop. Real coordinator, run store, capacity, and worktrees;
// fake driver (no worker runs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { success } from "../../../src/contracts/blockers.ts";
import { removeDir } from "../helpers/fixture.ts";
import { type World, controllerOver, plan, world } from "../helpers/coordinator-world.ts";

const LOSS = { code: "SUPERVISION_UNHEALTHY" as const, message: "synthetic watcher loss" };

async function retainedUnknown(w: World) {
  w.driver.script("developer", { launchResult: "uncertain", termination: "unknown" });
  const outcome = await w.coordinator.runAssignment(plan(w, "developer"));
  assert.equal(outcome.state, "blocked", JSON.stringify(outcome));
  return outcome.assignment!;
}

/** Script the driver's next stop results (default thereafter: unknown). */
function stops(w: World, results: Array<"verified" | "unknown">) {
  const driver = w.driver as unknown as { stop: (h: unknown) => Promise<{ termination: "verified" | "unknown" }> };
  const original = driver.stop.bind(w.driver);
  let calls = 0;
  driver.stop = async (h) => {
    await original(h);
    calls += 1;
    return { termination: results.shift() ?? "unknown" };
  };
  return () => calls;
}

test("F04 follow-up: a loss whose retry stop is also unknown leaves the work owned; a later cancel retries and releases once", async () => {
  const w = await world();
  try {
    const ui = await controllerOver(w);
    const watcher: string[] = [];
    ui.controller.session()!.run!.supervision = { release: () => watcher.push("release"), dropHeartbeat: () => watcher.push("dropHeartbeat"), health: () => success(true as const) } as never;
    const assignment = await retainedUnknown(w);
    const stopCalls = stops(w, ["unknown", "verified"]);
    await w.coordinator.supervisionLost(LOSS);
    assert.equal(stopCalls(), 1, "the loss retried the stop once");
    assert.equal((await w.capacity.list()).length, 1, "still unknown: the slot stays reserved");
    assert.ok(w.coordinator.liveAssignments().some((a) => a.assignment === assignment), "still counted as owned execution");
    const refused = await w.coordinator.prepare(plan(w, "developer"));
    assert.equal(refused.ok ? "ok" : refused.blocker.code, "SUPERVISION_UNHEALTHY", "halted: no new dispatch or reuse");
    const cancelled = await w.coordinator.cancel(assignment);
    assert.ok(cancelled.ok, JSON.stringify(cancelled));
    assert.equal(stopCalls(), 2, "an explicit cancel still retries the stop");
    assert.equal(cancelled.ok && cancelled.value.termination, "verified");
    assert.equal((await w.capacity.list()).length, 0, "verified: released");
    assert.equal(w.coordinator.liveAssignments().length, 0);
    await w.coordinator.supervisionLost(LOSS);
    assert.equal(stopCalls(), 2, "nothing left to stop; no duplicate release");
    assert.equal((await w.capacity.list()).length, 0);
  } finally {
    w.coordinator.stopMonitoring();
    removeDir(w.root);
  }
});

test("F04 follow-up: with retained work still unknown after a loss, quit leaves the watcher unfed", async () => {
  const w = await world();
  try {
    const ui = await controllerOver(w);
    const watcher: string[] = [];
    ui.controller.session()!.run!.supervision = { release: () => watcher.push("release"), dropHeartbeat: () => watcher.push("dropHeartbeat"), health: () => success(true as const) } as never;
    await retainedUnknown(w);
    stops(w, ["unknown"]);
    await w.coordinator.supervisionLost(LOSS);
    await ui.host.emit("session_shutdown", { reason: "quit" }, ui.ctx);
    assert.deepEqual(watcher, ["dropHeartbeat"]);
  } finally {
    w.coordinator.stopMonitoring();
    removeDir(w.root);
  }
});

test("F04 follow-up: a concurrent cancel and loss share one stop of retained work and release exactly once", async () => {
  const w = await world();
  try {
    const assignment = await retainedUnknown(w);
    const stopCalls = stops(w, ["verified"]);
    let releases = 0;
    const capacity = w.capacity as unknown as { release: (...a: unknown[]) => Promise<unknown> };
    const originalRelease = capacity.release.bind(w.capacity);
    capacity.release = async (...a: unknown[]) => {
      releases += 1;
      return originalRelease(...a);
    };
    const [cancelled] = await Promise.all([w.coordinator.cancel(assignment), w.coordinator.supervisionLost(LOSS)]);
    assert.ok(cancelled.ok, JSON.stringify(cancelled));
    assert.equal(stopCalls(), 1, "one shared stop");
    assert.equal(releases, 1, "released exactly once");
    assert.equal((await w.capacity.list()).length, 0);
  } finally {
    w.coordinator.stopMonitoring();
    removeDir(w.root);
  }
});
