// A live Claude Code developer reported "the brief refers to an approved spec
// and plan, but none were provided or readable": planning drafts are not in
// the worktree (uncommitted) and the project root is outside the worker
// sandbox. Each attempt must receive hash-verified copies of its approved
// artifacts in its output directory, listed in the brief; a copy whose content
// no longer matches its approval is never delivered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { removeDir } from "../helpers/fixture.ts";
import { PLAN_TEXT, plan, world } from "../helpers/coordinator-world.ts";

test("each attempt receives hash-verified copies of its approved artifacts, listed in its brief", async () => {
  const w = await world();
  try {
    w.driver.script("developer", {});
    const outcome = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.equal(outcome.state, "completed", JSON.stringify(outcome));
    const launch = w.driver.launches.at(-1)!;
    const out = launch.authority.outputDir;
    const spec = path.join(out, "approved", "spec.md");
    const planCopy = path.join(out, "approved", "plan.md");
    assert.ok(existsSync(spec) && existsSync(planCopy), "approved copies are in the worker's output directory");
    assert.equal(readFileSync(spec, "utf8"), "# Spec\nSynthetic behavior.\n");
    assert.equal(readFileSync(planCopy, "utf8"), PLAN_TEXT);
    assert.match(launch.briefText, /## Approved artifacts/);
    assert.ok(launch.briefText.includes(spec) && launch.briefText.includes(planCopy), "the brief lists the copies");
  } finally {
    removeDir(w.root);
  }
});
