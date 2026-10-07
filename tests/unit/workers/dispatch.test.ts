import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { git } from "../../helpers/git-fixtures.ts";
import { READY_SCREEN, TRUST_SCREEN } from "../../helpers/fake-herdr.ts";
import { makeWorkerEnv } from "../../helpers/worker-fixtures.ts";
import { listWorkers } from "../../../src/io/worker-store.ts";
import { dispatchWorker } from "../../../src/workers/dispatch.ts";
import { pollWorker } from "../../../src/workers/poll.ts";
import { workersFileOf } from "../../../src/workers/worker-env.ts";

const request = { role: "developer" as const, title: "Add login", task: "Add a login form." };

test("dispatch creates the worktree and brief, then launches the agent in a new pane", async () => {
  const { env, herdr } = await makeWorkerEnv();
  const worker = await dispatchWorker(env, request, "build");

  assert.equal(worker.name, "demo-developer-1");
  assert.equal(worker.state, "working");
  assert.equal(worker.pane, "w9:p1");
  assert.equal(git(worker.worktree, "branch", "--show-current"), "radian/demo-developer-1");
  const workerDir = path.join(
    env.workspaceRoot,
    ".radian",
    "projects",
    "demo",
    "workers",
    worker.name,
  );
  const brief = readFileSync(path.join(workerDir, "brief.md"), "utf8");
  assert.match(brief, /Add a login form\./);
  assert.match(brief, new RegExp(`>> ${path.join(workerDir, "status")}`));

  const [split, rename, start, screenCheck, prompt] = herdr.calls;
  assert.deepEqual(screenCheck, ["pane", "read", "w9:p1", "--source", "visible"]);
  assert.deepEqual(split?.slice(0, 8), [
    "pane",
    "split",
    "w1:p1",
    "--direction",
    "right",
    "--cwd",
    worker.worktree,
    "--no-focus",
  ]);
  assert.ok(split?.includes("ANTHROPIC_API_KEY="));
  assert.deepEqual(rename, ["pane", "rename", "w9:p1", "developer Add login"]);
  assert.deepEqual(start?.slice(0, 5), ["agent", "start", worker.name, "--kind", "claude"]);
  assert.ok(start?.includes("claude-sonnet-5-5"));
  assert.ok(!start?.some((arg) => arg.includes("brief.md")), "no prompt on the command line");
  assert.equal(prompt?.[2], worker.pane, "typed into the pane, which outlives the agent name");
  assert.match(prompt?.[3] ?? "", /You are a developer[\s\S]*Read and do the task in .*brief\.md$/);
  assert.deepEqual(listWorkers(workersFileOf(env)), [worker]);
});

test("only a scout may be dispatched in Plan mode", async () => {
  const { env } = await makeWorkerEnv();
  await assert.rejects(dispatchWorker(env, request, "plan"), /Build mode/);
  const scout = await dispatchWorker(env, { ...request, role: "scout" }, "plan");
  assert.equal(scout.model, "claude-haiku-4-5-20251001");
});

test("dispatch enforces the worker limit", async () => {
  const { env } = await makeWorkerEnv();
  env.config.harness.maxWorkers = 1;
  await dispatchWorker(env, request, "build");
  await assert.rejects(dispatchWorker(env, request, "build"), /1 of 1 workers are already running/);
});

test("a named profile picks the runtime; Pi workers skip extensions", async () => {
  const { env, herdr } = await makeWorkerEnv();
  const worker = await dispatchWorker(env, { ...request, profile: "developer-pi" }, "build");
  assert.equal(worker.runtime, "pi");
  const start = herdr.calls.find((call) => call[1] === "start");
  assert.deepEqual(start?.slice(3, 5), ["--kind", "pi"]);
  assert.ok(start?.includes("--no-extensions"));
});

test("fromWorker cuts the new branch from that worker's branch", async () => {
  const { env } = await makeWorkerEnv();
  const developer = await dispatchWorker(env, request, "build");
  const reviewer = await dispatchWorker(
    env,
    { ...request, role: "reviewer", fromWorker: developer.name },
    "build",
  );
  assert.equal(reviewer.baseBranch, developer.branch);
});

test("dispatch refuses outside Herdr", async () => {
  const { env } = await makeWorkerEnv();
  env.paneId = undefined;
  await assert.rejects(dispatchWorker(env, request, "build"), /inside Herdr/);
});

test("a launch failure marks the worker failed and reports the error", async () => {
  const { env } = await makeWorkerEnv();
  env.herdr = async (args) =>
    args[1] === "start"
      ? { stdout: "", stderr: "agent not ready", exitCode: 1 }
      : { stdout: '{"result":{"pane":{"pane_id":"w9:p1"}}}', stderr: "", exitCode: 0 };
  await assert.rejects(dispatchWorker(env, request, "build"), /agent not ready/);
  const [worker] = listWorkers(workersFileOf(env));
  assert.equal(worker?.state, "failed");
  assert.match(worker?.lastStatus ?? "", /launch failed/);
});

test("a startup prompt Herdr reports as blocked delays the task until the screen is ready", async () => {
  const { env, herdr } = await makeWorkerEnv();
  herdr.options.isStartupBlocked = true;
  herdr.screens.set("w9:p1", TRUST_SCREEN);
  const worker = await dispatchWorker(env, request, "build");
  assert.equal(worker.state, "starting");
  assert.equal(worker.isTaskPending, true);
  assert.match(worker.lastStatus ?? "", /answer the prompt in pane w9:p1/);
  assert.ok(!herdr.calls.some((call) => call[1] === "prompt"), "nothing is typed into a prompt");

  const stillAsking = await pollWorker(env, worker);
  assert.equal(stillAsking.worker.isTaskPending, true);
  assert.equal(stillAsking.isAwaitingUser, false, "Pi was already told at dispatch");

  herdr.screens.set("w9:p1", READY_SCREEN);
  const delivered = await pollWorker(env, stillAsking.worker);
  assert.equal(delivered.worker.isTaskPending, false);
  assert.equal(delivered.worker.state, "working");
  const prompt = herdr.calls.find((call) => call[1] === "prompt");
  assert.match(prompt?.[3] ?? "", /Read and do the task in .*brief\.md$/);
});

test("a prompt Herdr calls ready is found on the screen, and nothing is typed into it", async () => {
  const { env, herdr } = await makeWorkerEnv();
  herdr.screens.set("w9:p1", TRUST_SCREEN);
  const worker = await dispatchWorker(env, { ...request, profile: "developer-codex" }, "build");
  assert.equal(worker.isTaskPending, true);
  assert.ok(!herdr.calls.some((call) => call[1] === "prompt"));

  herdr.screens.set("w9:p1", READY_SCREEN);
  const delivered = await pollWorker(env, worker);
  assert.equal(delivered.worker.state, "working");
  assert.ok(herdr.calls.some((call) => call[1] === "prompt" && call[2] === "w9:p1"));
});

test("a screen that is still starting waits; a prompt appearing later is reported once", async () => {
  const { env, herdr } = await makeWorkerEnv();
  herdr.screens.set("w9:p1", "");
  const worker = await dispatchWorker(env, request, "build");
  assert.equal(worker.isTaskPending, true);
  assert.equal(worker.lastStatus, undefined);

  herdr.screens.set("w9:p1", TRUST_SCREEN);
  const asking = await pollWorker(env, worker);
  assert.equal(asking.isAwaitingUser, true);
  assert.match(asking.worker.lastStatus ?? "", /answer the prompt in pane w9:p1/);
  assert.equal((await pollWorker(env, asking.worker)).isAwaitingUser, false);
  assert.ok(!herdr.calls.some((call) => call[1] === "prompt"));
});

test("the first worker opens right of Pi; later ones stack below the newest worker", async () => {
  const { env, herdr } = await makeWorkerEnv();
  const first = await dispatchWorker(env, { ...request, title: "A" }, "build");
  await dispatchWorker(env, { ...request, title: "B" }, "build");
  const splits = herdr.calls.filter((call) => call[1] === "split");
  assert.deepEqual(splits[0]?.slice(2, 5), ["w1:p1", "--direction", "right"]);
  assert.deepEqual(splits[1]?.slice(2, 5), [first.pane, "--direction", "down"]);
});

test("parallel dispatches get distinct names, as when Pi runs two tool calls at once", async () => {
  const { env } = await makeWorkerEnv();
  const workers = await Promise.all([
    dispatchWorker(env, { ...request, title: "A" }, "build"),
    dispatchWorker(env, { ...request, title: "B" }, "build"),
  ]);
  assert.deepEqual(workers.map((worker) => worker.name).sort(), [
    "demo-developer-1",
    "demo-developer-2",
  ]);
  assert.equal(listWorkers(workersFileOf(env)).length, 2);
});

test("parallel dispatches respect the worker limit", async () => {
  const { env } = await makeWorkerEnv();
  env.config.harness.maxWorkers = 1;
  const results = await Promise.allSettled([
    dispatchWorker(env, { ...request, title: "A" }, "build"),
    dispatchWorker(env, { ...request, title: "B" }, "build"),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
});

test("a dispatch whose worktree cannot be created leaves no record behind", async () => {
  const { env } = await makeWorkerEnv();
  git(env.project.path, "branch", "radian/demo-developer-1");
  await assert.rejects(dispatchWorker(env, request, "build"), /already exists/);
  assert.deepEqual(listWorkers(workersFileOf(env)), []);
});
