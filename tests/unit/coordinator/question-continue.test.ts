// After the user answers a worker's question, work continues through a fresh
// assignment for the same role and task (with the answer in its objective);
// the interrupted assignment stays preserved. Nothing calls the old in-place
// resume, so this is the supported path and must not be blocked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { removeDir } from "../helpers/fixture.ts";
import { human, plan, world } from "../helpers/coordinator-world.ts";

test("a fresh assignment continues the work after the user answers a worker's question", async () => {
  const w = await world();
  try {
    w.driver.script("developer", { question: "Which export target?", outcome: "blocked" });
    const asked = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.equal(asked.state, "blocked", JSON.stringify(asked));
    const decision = Object.values(w.store.state.decisions).find((d) => d.status === "open");
    assert.ok(decision, "the question became an open decision");
    const resolved = await w.store.resolveDecision(human(), decision!.id, "macOS only; skip export if templates are missing");
    assert.ok(resolved.ok);
    w.driver.script("developer", {});
    const fresh = await w.coordinator.runAssignment(plan(w, "developer", { objective: "Continue the implementation. User answer: macOS only; skip export if templates are missing." }));
    assert.equal(fresh.state, "completed", JSON.stringify(fresh));
    assert.equal(Object.values(w.store.state.assignments).filter((a) => a.role === "developer").length, 2, "the interrupted assignment is preserved alongside the fresh one");
  } finally {
    removeDir(w.root);
  }
});
