// R06 — active watcher and coordinator-lease loss response. Supervision and
// lease health are monitored while owned work is alive (binding and
// execution), not only at preflight. On loss the coordinator blocks new
// dispatch at once and stops every live assignment within a bounded interval,
// retaining ownership when termination is unknown. Lease renewal failures feed
// the same response. Fake probes/drivers, plus one owned synthetic watcher.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { type Blocker, type Outcome, success } from "../../../src/contracts/blockers.ts";
import { SupervisionClient } from "../../../src/isolation/supervision.ts";
import { watcherStatusFile } from "../../../src/isolation/watcher.ts";
import { CoordinatorLease, startLeaseRenewal } from "../../../src/state/lease.ts";
import { psProbe } from "../../../src/util/process-identity.ts";
import { removeDir, tempDir } from "../helpers/fixture.ts";
import { type World, plan, world } from "../helpers/coordinator-world.ts";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

const unhealthy: Blocker = { code: "SUPERVISION_UNHEALTHY", message: "watcher is gone" };

/** Settle a promise within a bound, or report that it did not. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | "still running"> {
  return Promise.race([promise, new Promise<"still running">((r) => setTimeout(() => r("still running"), ms))]);
}

async function startedCount(w: World, n: number) {
  const deadline = Date.now() + 5_000;
  while (w.driver.started.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.driver.started.length, n);
}

function monitored(w: World, health: () => Outcome<true>) {
  w.coordinator.deps.supervisionHealthy = health;
  (w.coordinator.deps as { safetyIntervalMs?: number }).safetyIntervalMs = 25;
}

test("R06: supervision loss during binding and during execution stops every live assignment within a bounded interval", async () => {
  const w = await world();
  const binding = gate();
  const settling = gate();
  try {
    let healthy = true;
    monitored(w, () => (healthy ? success(true as const) : { ok: false, blocker: unhealthy }));
    w.driver.script("developer", { holdBinding: binding.opened, edit: { "src/a.ts": "late\n" } });
    w.driver.script("tester", { holdSettle: settling.opened, edit: { "tests/a.test.ts": "late\n" } });
    const developer = w.coordinator.runAssignment(plan(w, "developer"));
    await startedCount(w, 1);
    const tester = w.coordinator.runAssignment(plan(w, "tester"));
    await startedCount(w, 2);
    healthy = false;
    const [dev, test] = await Promise.all([within(developer, 2_000), within(tester, 2_000)]);
    assert.notEqual(dev, "still running", "the assignment waiting for binding was stopped");
    assert.notEqual(test, "still running", "the executing assignment was stopped");
    for (const outcome of [dev, test]) {
      if (outcome === "still running") continue;
      assert.equal(outcome.state === "blocked" ? outcome.blocker.code : outcome.state, "SUPERVISION_UNHEALTHY");
    }
    assert.equal(w.driver.stops.length, 2, "both owned attempts were stopped by the coordinator");
    assert.equal((await w.capacity.list()).length, 0, "verified stops release their slots");
    for (const a of Object.values(w.store.state.assignments)) {
      assert.equal(a.attempts.length, 1, "no replacement was started");
      assert.equal(a.budget.blocked?.reason, "supervision", "an honest supervision blocker is recorded");
    }
  } finally {
    binding.open();
    settling.open();
    removeDir(w.root);
  }
});

test("R06: after loss nothing launches; repeated notifications are idempotent; unknown stops keep their slots", async () => {
  const w = await world();
  const settling = gate();
  try {
    monitored(w, () => success(true as const));
    w.driver.script("developer", { holdSettle: settling.opened, termination: "unknown" });
    const running = w.coordinator.runAssignment(plan(w, "developer"));
    await startedCount(w, 1);
    const lost = (w.coordinator as unknown as { supervisionLost(b: Blocker): Promise<void> }).supervisionLost;
    assert.equal(typeof lost, "function", "the coordinator exposes a loss response");
    await Promise.all([lost.call(w.coordinator, unhealthy), lost.call(w.coordinator, { code: "LEASE_LOST", message: "renewal refused" })]);
    const outcome = await within(running, 2_000);
    assert.notEqual(outcome, "still running");
    assert.equal(w.driver.stops.length, 1, "each owned attempt is stopped once");
    assert.equal((await w.capacity.list()).length, 1, "unknown termination keeps the slot");
    // Health probes report healthy again, but the loss is latched for this coordinator.
    const launches = w.driver.launches.length;
    const next = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.equal(next.state === "blocked" ? next.blocker.code : next.state, "SUPERVISION_UNHEALTHY");
    assert.equal(w.driver.launches.length, launches, "no launch after loss");
  } finally {
    settling.open();
    removeDir(w.root);
  }
});

test("R06: lease renewal refusal or error, and an expired or replaced lease, trigger the same stop", async () => {
  const w = await world();
  const settling = gate();
  try {
    const lease = w.lease;
    monitored(w, () => lease.checkHeld());
    const failures: Blocker[] = [];
    const keeper = startLeaseRenewal(lease, 20, (b) => {
      failures.push(b);
      void (w.coordinator as unknown as { supervisionLost(b: Blocker): Promise<void> }).supervisionLost(b);
    });
    w.driver.script("developer", { holdSettle: settling.opened });
    const running = w.coordinator.runAssignment(plan(w, "developer"));
    await startedCount(w, 1);
    // Another session replaces the lease: renewal is refused and the checks fail.
    const file = CoordinatorLease.file(w.stateDir);
    const record = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...record, token: "replaced-by-another-session", generation: record.generation + 1 }));
    const outcome = await within(running, 2_000);
    assert.notEqual(outcome, "still running");
    assert.ok(failures.some((f) => f.code === "LEASE_LOST"), "renewal refusal was reported, not discarded");
    assert.equal(w.driver.stops.length, 1);
    keeper.stop();
    const reported = failures.length;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(failures.length, reported, "a stopped renewal loop reports nothing further");
  } finally {
    settling.open();
    removeDir(w.root);
  }

  // A throwing renewal and an expired lease, without unhandled rejections; a released lease is never renewed.
  const dir = tempDir();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const acquired = await CoordinatorLease.acquire(dir, "prj_fixture1", { ttlMs: 60_000 });
    assert.ok(acquired.ok);
    if (!acquired.ok) return;
    const lease = acquired.value;
    const failures: Blocker[] = [];
    const renew = lease.renew.bind(lease);
    lease.renew = async () => {
      throw new Error("synthetic renewal I/O error");
    };
    const keeper = startLeaseRenewal(lease, 10, (b) => failures.push(b));
    await new Promise((r) => setTimeout(r, 60));
    keeper.stop();
    assert.ok(failures.some((f) => f.code === "LEASE_LOST"), "a renewal error is a lease loss");
    lease.renew = renew;
    const file = CoordinatorLease.file(dir);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), expiresAtMs: 1 }));
    assert.equal(lease.checkHeld().ok, false, "an expired lease is not held");
    await lease.release();
    const after = await lease.renew();
    assert.equal(after.ok, false, "a released lease cannot be renewed");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).owner.start, "released");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    removeDir(dir);
  }
});

test("R06: the supervision client reports watcher exit, identity change, and heartbeat pipe errors without unhandled errors", async () => {
  const dir = tempDir();
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);
  process.on("uncaughtException", onError);
  const client = new SupervisionClient({ stateDir: dir, leaseMs: 2_000, graceMs: 200 });
  try {
    const started = await client.start();
    assert.ok(started.ok, started.ok ? "" : started.blocker.message);
    if (!started.ok) return;
    const losses: Blocker[] = [];
    client.onLoss((b) => losses.push(b));
    assert.ok(client.health().ok);
    // The watcher's status names a different process: not the watcher this coordinator started.
    const status = watcherStatusFile(dir);
    const original = readFileSync(status, "utf8");
    writeFileSync(status, JSON.stringify({ ...JSON.parse(original), identity: { pid: started.value.pid + 100_000, start: "other" } }));
    assert.equal(client.health().ok, false, "an unexpected watcher identity is unhealthy");
    writeFileSync(status, original);
    // The watcher dies: the coordinator learns without waiting for a launch.
    process.kill(started.value.pid, "SIGKILL");
    const deadline = Date.now() + 5_000;
    while (losses.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(losses.length >= 1, "watcher exit was reported");
    for (let i = 0; i < 5; i += 1) client.beat();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(client.health().ok, false);
    assert.equal(psProbe(started.value.pid).state, "absent");
    assert.deepEqual(errors, [], "heartbeats to a dead watcher raise no unhandled error");
  } finally {
    client.release();
    process.off("uncaughtException", onError);
    removeDir(dir);
  }
});

test("R06: healthy runs are unaffected by active monitoring", async () => {
  const w = await world();
  try {
    monitored(w, () => success(true as const));
    w.driver.script("developer", { edit: { "src/a.ts": "fine\n" } });
    const outcome = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.equal(outcome.state, "completed", JSON.stringify(outcome));
    assert.equal((await w.capacity.list()).length, 0);
  } finally {
    removeDir(w.root);
  }
});
