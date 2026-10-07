import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { git } from "../../helpers/git-fixtures.ts";
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

  const [split, rename, start, prompt] = herdr.calls;
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
  assert.equal(prompt?.[2], worker.name);
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

test("a startup prompt in the worker pane delays the task until the agent is ready", async () => {
  const { env, herdr } = await makeWorkerEnv();
  herdr.options.isStartupBlocked = true;
  const worker = await dispatchWorker(env, request, "build");
  assert.equal(worker.state, "starting");
  assert.equal(worker.isTaskPending, true);
  assert.match(worker.lastStatus ?? "", /answer the prompt in pane w9:p1/);
  assert.ok(
    !herdr.calls.some((call) => call[1] === "prompt"),
    "nothing is typed while the agent asks",
  );

  const stillBlocked = await pollWorker(env, worker);
  assert.equal(stillBlocked.worker.isTaskPending, true);

  herdr.panes.set(worker.pane ?? "", "idle");
  const delivered = await pollWorker(env, stillBlocked.worker);
  assert.equal(delivered.worker.isTaskPending, false);
  assert.equal(delivered.worker.state, "working");
  const prompt = herdr.calls.find((call) => call[1] === "prompt");
  assert.match(prompt?.[3] ?? "", /Read and do the task in .*brief\.md$/);
});
