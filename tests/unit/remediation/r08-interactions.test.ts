// R08 — cross-finding interactions on the final assembled source:
//   approval revoked during an uncertain launch (R04 × R05),
//   watcher loss during partial-launch cleanup (R05 × R06),
//   candidate mutation followed by repair-cycle accounting (R03 × R07),
//   a linked planning artifact used for approval (R02 × R04).

import { test } from "node:test";
import assert from "node:assert/strict";
import { renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Blocker } from "../../../src/contracts/blockers.ts";
import { removeDir } from "../helpers/fixture.ts";
import { type World, controllerOver, human, plan, world } from "../helpers/coordinator-world.ts";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

async function reject(w: World, kind: "spec" | "plan") {
  const file = kind === "spec" ? "docs/spec.md" : "docs/plan.md";
  assert.ok((await w.store.recordApproval(human(), { kind, task: w.taskId, artifact: { path: file, hash: w.artifacts[kind] }, decision: "rejected" })).ok);
}

test("R08: approval revoked during an uncertain launch — the launch is stopped and verified, and no recovery starts", async () => {
  const w = await world();
  try {
    w.driver.script("developer", { launchResult: "uncertain", onStop: () => reject(w, "plan") }, { edit: { "src/a.ts": "recovery under a rejected plan\n" } });
    const outcome = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.equal(outcome.state === "blocked" ? outcome.blocker.code : outcome.state, "APPROVAL_MISSING");
    assert.equal(w.driver.stops.length, 1, "the possibly-started launch was stopped");
    assert.equal(w.driver.started.length, 1, "the recovery attempt never started");
    const a = w.store.state.assignments[outcome.assignment!]!;
    // The recovery was refused by the first authorization check, before any reservation or attempt record.
    assert.deepEqual(a.attempts.map((x) => [x.endReason, x.termination]), [["infrastructure", "verified"]]);
    assert.equal((await w.capacity.list()).length, 0);
  } finally {
    removeDir(w.root);
  }
});

test("R08: watcher loss during partial-launch cleanup — one stop, no recovery, ownership per termination", async () => {
  for (const termination of ["verified", "unknown"] as const) {
    const w = await world();
    const stopping = gate();
    try {
      let notified: () => void = () => {};
      const stopEntered = new Promise<void>((r) => (notified = r));
      w.driver.script("developer", { launchResult: "uncertain", termination, onStop: async () => (notified(), await stopping.opened) });
      const running = w.coordinator.runAssignment(plan(w, "developer"));
      await stopEntered;
      const loss: Blocker = { code: "SUPERVISION_UNHEALTHY", message: "watcher exited during cleanup" };
      const lost = w.coordinator.supervisionLost(loss);
      stopping.open();
      await lost;
      const outcome = await running;
      assert.notEqual(outcome.state, "completed");
      assert.equal(w.driver.stops.length, 1, `${termination}: the cleanup stop was shared, not repeated`);
      assert.equal(w.driver.started.length, 1, `${termination}: no recovery after loss`);
      assert.equal((await w.capacity.list()).length, termination === "verified" ? 0 : 1);
    } finally {
      stopping.open();
      removeDir(w.root);
    }
  }
});

test("R08: candidate mutation in a check, then repair — evidence refused and exactly one new cycle", async () => {
  const w = await world();
  try {
    const ui = await controllerOver(w);
    w.driver.script("developer", { edit: { "src/a.ts": "export const a = 2;\n" } });
    const dev = await ui.dispatch({ role: "developer", writeRoots: ["src"] });
    w.driver.script("tester", { edit: { "tests/a.test.ts": "// t\n" } });
    const tester = await ui.dispatch({ role: "tester", writeRoots: ["tests"] });
    const first = /Candidate ([0-9a-f]{40,64})/.exec((await ui.assemble([dev.assignment!, tester.assignment!], w.base)).text ?? "")?.[1]!;
    const checks = [{ id: "unit", description: "unit", argv: ["npm", "test"] }];
    w.driver.script("tester", { edit: { "src/a.ts": "tampered\n" }, checks: [{ id: "unit", outcome: "passed" }] });
    const tampered = await ui.dispatch({ role: "tester", candidateCheck: true, baseCandidate: first, requiredChecks: checks });
    assert.match(tampered.text, /CANDIDATE_MISMATCH/);
    assert.equal(w.store.state.tasks[w.taskId]!.roundsUsed, 1, "a refused check consumes no cycle");
    // Repair: developer and tester for the next candidate share one new cycle.
    w.driver.script("developer", { edit: { "src/a.ts": "export const a = 3;\n" } });
    const repair = await ui.dispatch({ role: "developer", writeRoots: ["src"], baseCandidate: first, newCandidateRound: false });
    w.driver.script("tester", { edit: { "tests/a.test.ts": "// t2\n" } });
    const repairTester = await ui.dispatch({ role: "tester", writeRoots: ["tests"], baseCandidate: first, newCandidateRound: true });
    assert.equal(w.store.state.tasks[w.taskId]!.roundsUsed, 2);
    const second = /Candidate ([0-9a-f]{40,64})/.exec((await ui.assemble([repair.assignment!, repairTester.assignment!], first)).text ?? "")?.[1]!;
    assert.ok(second && second !== first);
    w.driver.script("tester", { checks: [{ id: "unit", outcome: "passed" }] });
    const valid = await ui.dispatch({ role: "tester", candidateCheck: true, baseCandidate: second, requiredChecks: checks });
    assert.match(valid.text, /unit=passed/);
    assert.equal(w.store.state.tasks[w.taskId]!.roundsUsed, 2);
  } finally {
    removeDir(w.root);
  }
});

test("R08: a planning artifact swapped for a link after approval cannot authorize a launch", { skip: process.platform === "darwin" ? false : "confined reads require macOS" }, async () => {
  const w = await world();
  try {
    const p = plan(w, "developer");
    const prepared = await w.coordinator.prepare(p);
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    // Same bytes, now reached through a link to a file outside the approved path.
    const spec = path.join(w.repo.root, "docs", "spec.md");
    const elsewhere = path.join(w.root, "elsewhere-spec.md");
    renameSync(spec, elsewhere);
    symlinkSync(elsewhere, spec);
    const outcome = await w.coordinator.runAttempt(prepared.value.assignment, p, prepared.value);
    assert.equal(outcome.state === "blocked" ? outcome.blocker.code : outcome.state, "APPROVAL_STALE");
    assert.equal(w.driver.started.length, 0);
    // Restoring a regular file with the approved content restores the authorization.
    renameSync(spec, path.join(w.root, "link-removed"));
    writeFileSync(spec, "# Spec\nSynthetic behavior.\n");
    w.driver.script("developer", { edit: { "src/a.ts": "ok\n" } });
    const again = await w.coordinator.runAttempt(prepared.value.assignment, p, prepared.value);
    assert.equal(again.state, "completed", JSON.stringify(again));
  } finally {
    removeDir(w.root);
  }
});
