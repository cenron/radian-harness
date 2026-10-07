import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { chooseOption, waitForNote } from "./helpers/notes.ts";
import { startWorkspace } from "./helpers/workspace.ts";

const dispatch = JSON.stringify({
  role: "developer",
  title: "Add work",
  task: "Create work.txt and commit it.",
});

test("a dispatched worker reports done, Pi is told, and the approved merge lands", async () => {
  const workspace = startWorkspace();
  const { pi, root } = workspace;
  const lastToolResult = () => workspace.modelLog().at(-1)?.transcript.at(-1)?.text ?? "";
  try {
    await pi.prompt("/new-project demo");
    await waitForNote(pi, /Project demo selected/);
    await pi.prompt(`TOOL radian_dispatch ${dispatch}`);
    const refused = workspace.modelLog().at(-1)?.transcript.at(-1)?.text ?? "";
    assert.match(refused, /Build mode/);

    await pi.prompt("/radian mode build");
    await pi.prompt(`TOOL radian_dispatch ${dispatch}`);
    const started = workspace.modelLog().at(-1)?.transcript.at(-1)?.text ?? "";
    assert.match(started, /Started demo-developer-1 \(claude claude-sonnet-5-5, effort medium\)/);

    // The watcher's `pane get` polls may interleave with the launch; only launch calls matter here.
    const calls = workspace.herdrCalls().filter((call) => call[1] !== "get");
    assert.deepEqual(
      calls.map((call) => call.slice(0, 2).join(" ")),
      ["pane split", "pane rename", "agent start", "pane read", "agent prompt"],
    );
    assert.match(
      calls[4]?.[3] ?? "",
      /^You are a developer[\s\S]*Read and do the task in .*brief\.md$/,
    );

    // The watcher sees `done:` in the status file and starts a turn for Pi.
    await pi.wait(() =>
      workspace
        .modelLog()
        .some((request) =>
          request.transcript.some((message) =>
            /demo-developer-1 \(developer: Add work\) done: wrote work.txt/.test(message.text),
          ),
        ),
    );

    // Before offering the merge, Pi can review the worker's files and brief, read-only.
    const worktree = path.join(
      root,
      ".radian",
      "projects",
      "demo",
      "worktrees",
      "demo-developer-1",
    );
    const workerDir = path.join(root, ".radian", "projects", "demo", "workers", "demo-developer-1");
    await pi.prompt("TOOL radian_workers {}");
    assert.match(lastToolResult(), new RegExp(`worktree ${worktree}`));
    await pi.prompt(`TOOL read ${JSON.stringify({ path: path.join(worktree, "work.txt") })}`);
    assert.match(lastToolResult(), /done by the fake worker/);
    await pi.prompt(`TOOL read ${JSON.stringify({ path: path.join(workerDir, "brief.md") })}`);
    assert.match(lastToolResult(), /# Add work/);

    chooseOption(pi, /^Merge$/);
    await pi.prompt('TOOL radian_merge {"worker":"demo-developer-1"}');
    const merged = workspace.modelLog().at(-1)?.transcript.at(-1)?.text ?? "";
    assert.match(merged, /Merged radian\/demo-developer-1 into main \(fast-forward\)/);
    const project = path.join(root, "demo");
    assert.equal(
      execFileSync("git", ["log", "-1", "--format=%s"], { cwd: project, encoding: "utf8" }).trim(),
      "Add work",
    );
    assert.equal(
      existsSync(path.join(root, ".radian", "projects", "demo", "worktrees", "demo-developer-1")),
      false,
    );
    assert.ok(workspace.herdrCalls().some((call) => call[0] === "pane" && call[1] === "close"));
  } finally {
    await pi.close();
  }
});

test("a cancelled merge changes nothing, and /delete-project refuses while the worker runs", async () => {
  const workspace = startWorkspace();
  const { pi, root } = workspace;
  try {
    await pi.prompt("/new-project demo");
    await waitForNote(pi, /Project demo selected/);
    // A developer gets a Radian commit at done, so it stays open for the merge; a worker with
    // nothing to merge would close itself and race this test.
    await pi.prompt("/radian mode build");
    await pi.prompt(`TOOL radian_dispatch ${dispatch}`);
    chooseOption(pi, /^Cancel$/);
    await pi.prompt('TOOL radian_merge {"worker":"demo-developer-1"}');
    assert.match(
      workspace.modelLog().at(-1)?.transcript.at(-1)?.text ?? "",
      /cancelled by the user/,
    );
    await pi.prompt("/delete-project demo");
    await waitForNote(pi, /still has running workers: demo-developer-1/);
    assert.ok(existsSync(path.join(root, "demo")));
  } finally {
    await pi.close();
  }
});
