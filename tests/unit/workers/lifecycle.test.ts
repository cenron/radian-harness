import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { commitFile, git } from "../../helpers/git-fixtures.ts";
import { actAsWorker, makeWorkerEnv } from "../../helpers/worker-fixtures.ts";
import { listWorkers } from "../../../src/io/worker-store.ts";
import { dispatchWorker } from "../../../src/workers/dispatch.ts";
import {
  describeWorker,
  discardWorker,
  mergeWorker,
  sendToWorker,
  stopWorker,
} from "../../../src/workers/finish.ts";
import { pollWorker } from "../../../src/workers/poll.ts";
import { workersFileOf } from "../../../src/workers/worker-env.ts";

async function dispatchedDeveloper() {
  const { env, herdr } = await makeWorkerEnv();
  const worker = await dispatchWorker(
    env,
    { role: "developer", title: "Add a", task: "Add a." },
    "build",
  );
  return { env, herdr, worker };
}

test("pollWorker reports new status lines once and records the latest state", async () => {
  const { env, worker } = await dispatchedDeveloper();
  actAsWorker(worker, { status: ["working: reading", "question: which file name?"] });
  const first = await pollWorker(env, worker);
  assert.deepEqual(
    first.entries.map((entry) => entry.kind),
    ["working", "question"],
  );
  assert.equal(first.worker.state, "question");
  assert.equal(first.worker.lastStatus, "question: which file name?");
  assert.equal(first.worker.agentStatus, "idle");

  const again = await pollWorker(env, first.worker);
  assert.deepEqual(again.entries, []);
  assert.equal(listWorkers(workersFileOf(env))[0]?.statusLinesSeen, 2);
});

test("pollWorker marks a worker exited when its pane closes before it finished", async () => {
  const { env, herdr, worker } = await dispatchedDeveloper();
  herdr.panes.delete(worker.pane ?? "");
  const change = await pollWorker(env, worker);
  assert.equal(change.hasExited, true);
  assert.equal(change.worker.state, "exited");
});

test("a done worker stays done when its pane closes", async () => {
  const { env, herdr, worker } = await dispatchedDeveloper();
  actAsWorker(worker, { status: ["done: added a"] });
  herdr.panes.delete(worker.pane ?? "");
  assert.equal((await pollWorker(env, worker)).worker.state, "done");
});

test("merge fast-forwards the target, then removes pane, worktree, branch, and record", async () => {
  const { env, herdr, worker } = await dispatchedDeveloper();
  actAsWorker(worker, { file: "a.txt", status: ["done: added a"] });
  const { worker: done } = await pollWorker(env, worker);
  assert.match(await describeWorker(env, done), /1 commit\(s\)[\s\S]*a\.txt[\s\S]*done: added a/);

  assert.match(await mergeWorker(env, done), /fast-forward/);
  assert.equal(git(env.project.path, "log", "-1", "--format=%s"), "add a.txt");
  assert.equal(existsSync(worker.worktree), false);
  assert.equal(git(env.project.path, "branch", "--list", worker.branch), "");
  assert.equal(herdr.panes.has(worker.pane ?? ""), false);
  assert.deepEqual(listWorkers(workersFileOf(env)), []);
});

test("merge creates a merge commit when the target moved on", async () => {
  const { env, worker } = await dispatchedDeveloper();
  actAsWorker(worker, { file: "a.txt", status: ["done: a"] });
  commitFile(env.project.path, "b.txt", "b\n", "add b on main");
  assert.match(await mergeWorker(env, worker), /merge commit/);
  assert.ok(existsSync(path.join(env.project.path, "a.txt")));
});

test("a conflicting merge is aborted and the worker is kept", async () => {
  const { env, worker } = await dispatchedDeveloper();
  actAsWorker(worker, { file: "same.txt", status: ["done: x"] });
  commitFile(env.project.path, "same.txt", "different\n", "conflicting change");
  await assert.rejects(mergeWorker(env, worker), /conflict/);
  assert.equal(git(env.project.path, "status", "--porcelain"), "");
  assert.ok(existsSync(worker.worktree));
  assert.equal(listWorkers(workersFileOf(env)).length, 1);
});

test("merge refuses a dirty checkout or the wrong branch", async () => {
  const { env, worker } = await dispatchedDeveloper();
  writeFileSync(path.join(env.project.path, "scratch.txt"), "x");
  await assert.rejects(mergeWorker(env, worker), /uncommitted changes/);
  git(env.project.path, "stash", "-u");
  git(env.project.path, "checkout", "-q", "-b", "other");
  await assert.rejects(mergeWorker(env, worker), /check out main/);
});

test("discard removes unmerged work entirely", async () => {
  const { env, herdr, worker } = await dispatchedDeveloper();
  actAsWorker(worker, { file: "a.txt", status: [] });
  await discardWorker(env, worker);
  assert.equal(existsSync(worker.worktree), false);
  assert.equal(git(env.project.path, "branch", "--list", worker.branch), "");
  assert.equal(herdr.panes.size, 0);
  assert.equal(existsSync(path.join(env.project.path, "a.txt")), false);
});

test("stop closes the pane and keeps the worktree and branch", async () => {
  const { env, herdr, worker } = await dispatchedDeveloper();
  await stopWorker(env, worker);
  assert.equal(herdr.panes.size, 0);
  assert.ok(existsSync(worker.worktree));
  assert.equal(listWorkers(workersFileOf(env))[0]?.state, "stopped");
});

test("send types text into the worker's session", async () => {
  const { env, herdr, worker } = await dispatchedDeveloper();
  await sendToWorker(env, worker, "Use a.txt");
  assert.deepEqual(herdr.calls.at(-1), ["agent", "prompt", worker.pane, "Use a.txt"]);
  herdr.panes.clear();
  await assert.rejects(sendToWorker(env, worker, "hello"), /no open pane/);
});

async function dispatchedReader(role: "scout" | "reviewer") {
  const { env, herdr } = await makeWorkerEnv();
  const worker = await dispatchWorker(env, { role, title: "Look", task: "Look around." }, "build");
  return { env, herdr, worker };
}

function writeReport(worker: { worktree: string; name: string }, text: string): void {
  const workerDir = path.join(path.dirname(path.dirname(worker.worktree)), "workers", worker.name);
  writeFileSync(path.join(workerDir, "report.md"), text);
}

test("a scout that finishes without commits is closed and its report handed over", async () => {
  const { env, herdr, worker } = await dispatchedReader("scout");
  writeReport(worker, "Two files: README.md and a.txt.\n");
  actAsWorker(worker, { status: ["done: listed the files"] });
  const change = await pollWorker(env, worker);
  assert.equal(change.isClosed, true);
  assert.equal(change.report, "Two files: README.md and a.txt.\n");
  assert.equal(herdr.panes.has(worker.pane ?? ""), false);
  assert.equal(existsSync(worker.worktree), false);
  assert.equal(git(env.project.path, "branch", "--list", worker.branch), "");
  assert.deepEqual(listWorkers(workersFileOf(env)), []);
});

test("a reviewer that committed something is kept open for a merge", async () => {
  const { env, herdr, worker } = await dispatchedReader("reviewer");
  actAsWorker(worker, { file: "notes.txt", status: ["done: approve"] });
  const change = await pollWorker(env, worker);
  assert.equal(change.isClosed, false);
  assert.ok(herdr.panes.has(worker.pane ?? ""));
  assert.equal(listWorkers(workersFileOf(env))[0]?.state, "done");
});

test("a developer that finishes is never closed automatically", async () => {
  const { env, herdr, worker } = await dispatchedDeveloper();
  actAsWorker(worker, { status: ["done: nothing to change"] });
  assert.equal((await pollWorker(env, worker)).isClosed, false);
  assert.ok(herdr.panes.has(worker.pane ?? ""));
});

test("the watcher leaves a worker alone while dispatch is still launching it", async () => {
  const { env, herdr, worker } = await dispatchedDeveloper();
  const launching = { ...worker, state: "starting" as const, isTaskPending: false };
  const callsBefore = herdr.calls.length;
  const change = await pollWorker(env, launching);
  assert.equal(change.worker, launching);
  assert.equal(herdr.calls.length, callsBefore, "no Herdr calls, no typing");
});

test("a poll never brings back a worker that was removed meanwhile", async () => {
  const { env, worker } = await dispatchedDeveloper();
  await discardWorker(env, worker);
  await pollWorker(env, worker);
  assert.deepEqual(listWorkers(workersFileOf(env)), []);
});
