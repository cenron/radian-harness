import assert from "node:assert/strict";
import { test } from "node:test";
import { firstPrompt, renderBrief } from "../../../src/core/brief.ts";

const input = {
  workerName: "demo-developer-1",
  role: "developer" as const,
  title: "Add login",
  task: "Add a login form.",
  branch: "radian/demo-developer-1",
  baseBranch: "main",
  targetBranch: "main",
  runtime: "claude" as const,
  worktree: "/ws/.radian/projects/demo/worktrees/demo-developer-1",
  statusPath: "/ws/.radian/projects/demo/workers/demo-developer-1/status",
  reportPath: "/ws/.radian/projects/demo/workers/demo-developer-1/report.md",
};

test("renderBrief holds the task, working rules, and the absolute status path", () => {
  const brief = renderBrief(input);
  assert.match(brief, /^# Add login/);
  assert.match(brief, /Add a login form\./);
  assert.match(brief, /radian\/demo-developer-1/);
  assert.match(brief, /Stay inside .*worktrees\/demo-developer-1/);
  assert.match(brief, /relative to the worktree/);
  assert.match(brief, /echo "done: <one-line summary>" >> \/ws\/.*\/status/);
  assert.match(brief, /working\|question\|blocked\|done\|failed/);
  assert.match(brief, /target branch is `main`/);
});

test("workers never commit; Radian commits a developer's changes, and readers write a report", () => {
  for (const runtime of ["claude", "codex", "pi"] as const) {
    const brief = renderBrief({ ...input, runtime });
    assert.match(brief, /Do not commit, merge, rebase, push, or switch branches/);
    assert.match(
      brief,
      /Radian commits your changes on your branch `radian\/demo-developer-1` .*when you write `done:`/,
    );
  }
  const review = renderBrief({ ...input, role: "reviewer" });
  assert.match(
    review,
    /do not change code or commit\. Write your findings to \/ws\/.*\/report\.md/,
  );
});

test("renderBrief names the branch a reviewer or tester starts from", () => {
  assert.match(
    renderBrief({ ...input, role: "reviewer", baseBranch: "radian/demo-developer-1" }),
    /cut from `radian\/demo-developer-1`/,
  );
});

test("firstPrompt is the role prompt followed by the brief instruction", () => {
  const prompt = firstPrompt("You are a developer.\n", "/ws/brief.md");
  assert.equal(prompt, "You are a developer.\n\nRead and do the task in /ws/brief.md");
});

test("the brief tells workers to report a denied tool by its exact name", () => {
  assert.match(
    renderBrief(input),
    /If a tool you need is denied, write `blocked:` with its exact name/,
  );
});
