// The brief must tell a real worker exactly how to write its result envelope:
// a live Claude Code run wrote `assignmentId`/`attemptId`, omitted the
// workspace/project/run/task ids (which the brief never showed), and invented
// handoff/findings/usage shapes, so every result was rejected. The rendered
// template must itself pass the production validator for that exact
// assignment and brief revision.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateResult } from "../../../src/contracts/result.ts";
import { renderBrief } from "../../../src/coordinator/orchestrator.ts";
import { removeDir } from "../helpers/fixture.ts";
import { layout } from "../helpers/layout.ts";
import { request } from "../helpers/session-fixture.ts";

test("the brief carries a complete result template that the validator accepts for this assignment", () => {
  const l = layout();
  try {
    const r = request(l);
    const text = renderBrief(r.brief, "role guide");
    const block = /```json\n([\s\S]*?)\n```/.exec(text.slice(text.indexOf("## Result envelope")));
    assert.ok(block, "a JSON result template is rendered in the Result envelope section");
    const parsed = JSON.parse(block![1]!);
    const valid = validateResult(parsed, { identity: r.identity, briefHash: r.brief.hash });
    assert.ok(valid.ok, valid.ok ? "" : valid.blocker.message);
    for (const id of [r.identity.workspace, r.identity.project, r.identity.run, r.identity.task]) assert.ok(text.includes(id), "every identity value the validator requires is shown");
    assert.match(text, /no other fields/i, "the worker is told that unknown fields are rejected");
  } finally {
    removeDir(l.root);
  }
});
