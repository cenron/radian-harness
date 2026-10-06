// A live Claude Code developer completed its task but listed deliverables as
// absolute paths; the whole result was rejected ("deliverable paths must be
// relative and inside the assignment") and the work was not delivered.
// Absolute paths inside the worker's own worktree are made relative; paths
// outside it are left as they are, so validation still refuses them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeResultPaths } from "../../../src/state/inbox.ts";

test("absolute deliverable paths inside the worktree become relative; outside paths stay and are refused later", () => {
  const worktree = "/ws/.radian/projects/p/worktrees/wt_1";
  const raw = { deliverables: [{ path: `${worktree}/scripts/main.gd` }, { path: "README.md" }, { path: "/etc/hosts" }, { path: `${worktree}` }], candidate: { patch: { path: `${worktree}/out.patch`, hash: "sha256:x" } } };
  const out = normalizeResultPaths(raw, worktree) as typeof raw;
  assert.deepEqual(out.deliverables.map((d) => d.path), ["scripts/main.gd", "README.md", "/etc/hosts", worktree]);
  assert.equal(out.candidate.patch.path, "out.patch");
  assert.equal(normalizeResultPaths("not an object", worktree), "not an object");
});
