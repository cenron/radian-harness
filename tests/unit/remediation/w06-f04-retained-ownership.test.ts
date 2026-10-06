// W06 / F04 (R05/R06) — work whose termination is unknown stays owned
// execution: it remains monitored, is included in supervision/lease loss and
// shutdown, counts in the interface, and is never orderly released; stops are
// retried generation-safely without duplicate finalization. Real coordinator,
// run store, capacity, and worktrees; fake driver (no worker runs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { success } from "../../../src/contracts/blockers.ts";
import { removeDir } from "../helpers/fixture.ts";
import { type World, controllerOver, plan, world } from "../helpers/coordinator-world.ts";

/** An uncertain launch whose stop cannot be verified: retained, unknown-termination work. */
async function retainedUnknown(w: World) {
  w.driver.script("developer", { launchResult: "uncertain", termination: "unknown" });
  const outcome = await w.coordinator.runAssignment(plan(w, "developer"));
  assert.equal(outcome.state, "blocked", JSON.stringify(outcome));
  assert.equal((await w.capacity.list()).length, 1, "the slot is retained");
  return outcome.assignment!;
}

const LOSS = { code: "SUPERVISION_UNHEALTHY" as const, message: "synthetic watcher loss" };

test("F04: supervision loss after an unknown stop retries the stop of retained work", async () => {
  const w = await world();
  try {
    await retainedUnknown(w);
    const stopsBefore = w.driver.stops.length;
    await w.coordinator.supervisionLost(LOSS);
    assert.ok(w.driver.stops.length > stopsBefore, `retained work is included in the loss response (stops ${stopsBefore} → ${w.driver.stops.length})`);
    assert.equal((await w.capacity.list()).length, 1, "still unknown: the slot stays retained");
  } finally {
    removeDir(w.root);
  }
});

test("F04: retained work stays monitored, so a later watcher or lease loss is detected", async () => {
  const w = await world();
  try {
    w.coordinator.deps.safetyIntervalMs = 20;
    await retainedUnknown(w);
    const stopsBefore = w.driver.stops.length;
    w.coordinator.deps.supervisionHealthy = () => ({ ok: false, blocker: LOSS });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(w.driver.stops.length > stopsBefore, "the monitor kept polling while only retained work existed and responded to the loss");
    const refused = await w.coordinator.prepare(plan(w, "developer"));
    assert.equal(refused.ok ? "ok" : refused.blocker.code, "SUPERVISION_UNHEALTHY", "and no new dispatch follows the loss");
  } finally {
    w.coordinator.stopMonitoring();
    removeDir(w.root);
  }
});

test("F04: a retried stop that verifies termination releases exactly once, without re-finalizing the attempt", async () => {
  const w = await world();
  try {
    const assignment = await retainedUnknown(w);
    const endsBefore = w.store.state.assignments[assignment]!.attempts.filter((a) => a.status === "ended").length;
    // The next stop of the retained handle verifies termination.
    const driver = w.driver as unknown as { stop: (h: unknown) => Promise<{ termination: "verified" | "unknown" }> };
    const original = driver.stop.bind(w.driver);
    driver.stop = async (h) => (await original(h), { termination: "verified" });
    await Promise.all([w.coordinator.supervisionLost(LOSS), w.coordinator.supervisionLost(LOSS)]);
    assert.equal((await w.capacity.list()).length, 0, "verified: the slot is released");
    const attempts = w.store.state.assignments[assignment]!.attempts;
    assert.equal(attempts.filter((a) => a.status === "ended").length, endsBefore, "the attempt was not finalized again");
    await w.coordinator.supervisionLost(LOSS);
    assert.equal((await w.capacity.list()).length, 0, "idempotent");
  } finally {
    removeDir(w.root);
  }
});

test("F04: shutdown with only retained work never orderly releases the watcher, and the interface counts it", async () => {
  const w = await world();
  try {
    const ui = await controllerOver(w);
    const calls: string[] = [];
    const run = ui.controller.session()!.run!;
    run.supervision = { release: () => calls.push("release"), dropHeartbeat: () => calls.push("dropHeartbeat"), health: () => success(true as const) } as never;
    await retainedUnknown(w);
    assert.ok(w.coordinator.liveAssignments().length >= 1, "retained work is owned execution for interface counts");
    await ui.host.emit("session_shutdown", { reason: "quit" }, ui.ctx);
    assert.deepEqual(calls, ["dropHeartbeat"], "the watcher is left unfed (loss stops the work), never orderly released");
  } finally {
    w.coordinator.stopMonitoring();
    removeDir(w.root);
  }
});
