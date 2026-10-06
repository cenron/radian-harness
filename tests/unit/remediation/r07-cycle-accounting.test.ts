// R07 — durable candidate-cycle accounting. Cycles are derived from durable
// task/candidate state under the run lock, never from a model-supplied flag:
// work toward the next candidate shares one cycle, the first modifying
// assignment after a candidate starts the next cycle exactly once, reassembly
// cannot add a candidate to a cycle, the cap holds across restarts, only
// recorded human grants extend it, and ambiguous classification blocks.
// Exercised through the registered radian_dispatch/radian_assemble tools and
// the orchestrator with a fake driver.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../../../src/state/run-store.ts";
import { removeDir } from "../helpers/fixture.ts";
import { type World, controllerOver, human, plan, world } from "../helpers/coordinator-world.ts";

type UI = Awaited<ReturnType<typeof controllerOver>>;

async function deliver(w: World, ui: UI, role: "developer" | "tester", flags: Record<string, unknown>, base?: string) {
  w.driver.script(role, { edit: role === "developer" ? { "src/a.ts": `export const a = ${Math.random()};\n` } : { "tests/a.test.ts": `// ${Math.random()}\n` } });
  return ui.dispatch({ role, writeRoots: [role === "developer" ? "src" : "tests"], ...(base ? { baseCandidate: base } : {}), ...flags });
}

/** One full cycle through the tools: developer + tester deliveries, assembly, and a blocking review (a defect). */
async function cycle(w: World, ui: UI, base: string | undefined, flags: Record<string, unknown> = { newCandidateRound: true }): Promise<string> {
  const dev = await deliver(w, ui, "developer", flags, base);
  const tester = await deliver(w, ui, "tester", {}, base);
  assert.ok(dev.assignment && tester.assignment, `${dev.text} | ${tester.text}`);
  const assembled = await ui.assemble([dev.assignment!, tester.assignment!], base ?? w.base);
  const commit = /Candidate ([0-9a-f]{40,64})/.exec(assembled.text ?? "")?.[1];
  assert.ok(commit, JSON.stringify(assembled));
  w.driver.script("reviewer", { findings: [{ severity: "blocker", summary: "defect" }] });
  await ui.dispatch({ role: "reviewer", baseCandidate: commit });
  return commit!;
}

test("R07: after three evaluated defect cycles, a fourth is refused whatever the legacy flag says", async () => {
  const w = await world();
  try {
    const ui = await controllerOver(w);
    let base: string | undefined;
    for (let i = 0; i < 3; i += 1) base = await cycle(w, ui, base);
    assert.equal(w.store.state.tasks[w.taskId]!.roundsUsed, 3);
    const escaped: string[] = [];
    for (const flags of [{}, { newCandidateRound: false }, { newCandidateRound: true }]) {
      const launches = w.driver.launches.length;
      const fourth = await deliver(w, ui, "developer", flags, base);
      if (w.driver.launches.length !== launches || !/ROUNDS_EXHAUSTED/.test(fourth.text)) escaped.push(`${JSON.stringify(flags)} → ${fourth.text.slice(0, 120)}`);
      const tester = await deliver(w, ui, "tester", flags, base);
      if (!/ROUNDS_EXHAUSTED/.test(tester.text)) escaped.push(`tester ${JSON.stringify(flags)} → ${tester.text.slice(0, 120)}`);
    }
    assert.deepEqual(escaped, [], "no model-requested assignment starts a fourth cycle");
    assert.equal(w.store.state.tasks[w.taskId]!.roundsUsed, 3);
    assert.equal(w.store.state.tasks[w.taskId]!.candidates.length, 3);
    // Checks and reviews of the existing candidate are still possible.
    w.driver.script("reviewer", {});
    const review = await ui.dispatch({ role: "reviewer", baseCandidate: base });
    assert.match(review.text, /completed/);

    // Restart: a reopened store replays the same cap and cycle identity.
    const reopened = await RunStore.open(w.stateDir, w.store.state.run.id, w.lease);
    assert.ok(reopened.ok);
    if (!reopened.ok) return;
    assert.equal(reopened.value.state.tasks[w.taskId]!.roundsUsed, 3);
    const replay = await reopened.value.createAssignment({ task: w.taskId, role: "developer", purpose: "assignment", profile: { name: "codex", runtime: "codex", provider: "openai", model: "gpt-test-1", effort: "medium" }, briefHash: "sha256:" + "a".repeat(64), limitMs: 60_000, maxAutomaticRecoveries: 1, artifacts: w.artifacts, newCandidateRound: true } as never);
    assert.equal(replay.ok ? "ok" : replay.blocker.code, "ROUNDS_EXHAUSTED");

    // A recorded human grant allows exactly the granted number of further cycles.
    assert.ok((await w.store.grantRounds(human(), w.taskId, 1, "dec_grant-fixture1")).ok);
    base = await cycle(w, ui, base, {});
    assert.equal(w.store.state.tasks[w.taskId]!.roundsUsed, 4);
    const fifth = await deliver(w, ui, "developer", { newCandidateRound: true }, base);
    assert.match(fifth.text, /ROUNDS_EXHAUSTED/);
  } finally {
    removeDir(w.root);
  }
});

test("R07: work toward one candidate shares a cycle; concurrent repairs start the next cycle exactly once", async () => {
  const w = await world();
  try {
    const ui = await controllerOver(w);
    // Developers and testers before assembly share cycle 1, whatever the flags say.
    await deliver(w, ui, "developer", { newCandidateRound: true });
    w.driver.script("developer", { edit: { "src/b.ts": "export const b = 1;\n" } });
    await ui.dispatch({ role: "developer", writeRoots: ["src"], newCandidateRound: true });
    await deliver(w, ui, "tester", { newCandidateRound: true });
    assert.equal(w.store.state.tasks[w.taskId]!.roundsUsed, 1, "same-cycle collaboration does not consume cycles");
    const ids = Object.values(w.store.state.assignments).filter((a) => a.role !== "reviewer").map((a) => a.id);
    const assembled = await ui.assemble(ids, w.base);
    const first = /Candidate ([0-9a-f]{40,64})/.exec(assembled.text ?? "")?.[1]!;
    assert.ok(first, JSON.stringify(assembled));
    // Concurrent repairs after the candidate: one new cycle.
    // (Run through the orchestrator directly so each concurrent outcome is awaited individually.)
    w.driver.script("developer", { edit: { "src/a.ts": "repair one\n" } }, { edit: { "src/c.ts": "repair two\n" } });
    w.driver.script("tester", { edit: { "tests/a.test.ts": "// repair\n" } });
    const repairBase = { kind: "commit" as const, commit: first };
    const repairs = await Promise.all([
      w.coordinator.runAssignment(plan(w, "developer", { base: repairBase, newCandidateRound: true })),
      w.coordinator.runAssignment(plan(w, "developer", { base: repairBase, newCandidateRound: true })),
      w.coordinator.runAssignment(plan(w, "tester", { base: repairBase, newCandidateRound: true })),
    ]);
    for (const r of repairs) assert.equal(r.state, "completed", JSON.stringify(r));
    assert.equal(w.store.state.tasks[w.taskId]!.roundsUsed, 2, "concurrent repairs consumed exactly one cycle");
    const rounds = Object.values(w.store.state.assignments).map((a) => a.round);
    assert.deepEqual([...new Set(rounds)].sort(), [1, 2]);
  } finally {
    removeDir(w.root);
  }
});

test("R07: reassembly cannot add a second candidate to a cycle", async () => {
  const w = await world();
  try {
    const ui = await controllerOver(w);
    const dev = await deliver(w, ui, "developer", { newCandidateRound: true });
    w.driver.script("developer", { edit: { "src/b.ts": "export const b = 1;\n" } });
    const dev2 = await ui.dispatch({ role: "developer", writeRoots: ["src"] });
    const tester = await deliver(w, ui, "tester", {});
    const first = await ui.assemble([dev.assignment!, tester.assignment!], w.base);
    assert.match(first.text ?? "", /Candidate/);
    const again = await ui.assemble([dev.assignment!, dev2.assignment!, tester.assignment!], w.base);
    assert.ok(dev2.assignment, dev2.text);
    assert.doesNotMatch(again.text ?? "", /^Candidate/, `a different candidate in the same cycle is refused: ${JSON.stringify(again)}`);
    assert.equal(w.store.state.tasks[w.taskId]!.candidates.length, 1);
    assert.equal(w.store.state.tasks[w.taskId]!.roundsUsed, 1);
  } finally {
    removeDir(w.root);
  }
});

test("R07: infrastructure recovery keeps the cycle and the remaining budget; ambiguous classification blocks", async () => {
  const w = await world();
  try {
    w.driver.script("developer", { bind: "fail" }, { edit: { "src/a.ts": "recovered\n" } });
    const recovered = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.equal(recovered.state, "completed");
    const a = w.store.state.assignments[recovered.assignment]!;
    assert.equal(a.round, 1);
    assert.equal(a.attempts.length, 2);
    assert.equal(a.automaticRecoveriesUsed, 1);
    assert.equal(w.store.state.tasks[w.taskId]!.roundsUsed, 1, "recovery is not a candidate cycle");

    const opened = await w.store.classifyFailure(w.taskId, "ambiguous", "check failed for an unclear reason");
    assert.ok(opened.ok);
    const decision = Object.values(w.store.state.decisions).find((d) => d.kind === "accounting" && d.status === "open")!;
    w.driver.script("developer", { edit: { "src/a.ts": "while ambiguous\n" } });
    const blocked = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.equal(blocked.state === "blocked" ? blocked.blocker.code : blocked.state, "AMBIGUOUS_ACCOUNTING");
    assert.ok((await w.store.resolveDecision(human(), decision.id, "candidate defect")).ok);
    const allowed = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.equal(allowed.state, "completed", JSON.stringify(allowed));
  } finally {
    removeDir(w.root);
  }
});
