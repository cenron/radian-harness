import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createFakePi } from "../../helpers/fake-pi.ts";
import { git, makeRepository } from "../../helpers/git-fixtures.ts";
import { makeWorkerEnv } from "../../helpers/worker-fixtures.ts";
import { listWorkers } from "../../../src/io/worker-store.ts";
import { listProjects, readMode } from "../../../src/io/workspace.ts";
import { addWorkerTool, readWorkerTools } from "../../../src/io/worker-tools.ts";
import { readCalm } from "../../../src/pi/calm.ts";
import { registerCommands, toggleMode } from "../../../src/pi/commands.ts";
import { dispatchWorker } from "../../../src/workers/dispatch.ts";
import { workersFileOf } from "../../../src/workers/worker-env.ts";

async function setup() {
  const { env, herdr } = await makeWorkerEnv();
  const fake = createFakePi(env);
  registerCommands(fake.state);
  return { env, herdr, fake };
}

test("/radian mode and Shift+Tab switch between Plan and Build", async () => {
  const { env, fake } = await setup();
  assert.match((await fake.run("/radian mode build")) ?? "", /Mode: BUILD/);
  assert.equal(readMode(env.workspaceRoot, "demo", "plan"), "build");
  toggleMode(fake.state, fake.ctx);
  assert.equal(readMode(env.workspaceRoot, "demo", "plan"), "plan");
  assert.match((await fake.run("/radian mode ship")) ?? "", /plan or build/);
});

test("/radian calm persists the preference", async () => {
  const { env, fake } = await setup();
  await fake.run("/radian calm on");
  assert.equal(fake.state.isCalm, true);
  assert.equal(readCalm(env.workspaceRoot, false), true);
});

test("/calm toggles Calm, and also takes on or off", async () => {
  const { env, fake } = await setup();
  assert.match((await fake.run("/calm")) ?? "", /Calm on/);
  assert.equal(readCalm(env.workspaceRoot, false), true);
  assert.match((await fake.run("/calm")) ?? "", /Calm off/);
  assert.equal(fake.state.isCalm, false);
  await fake.run("/calm on");
  await fake.run("/calm on");
  assert.equal(fake.state.isCalm, true);
  assert.match((await fake.run("/calm loud")) ?? "", /Usage: \/calm \[on\|off\]/);
});

test("/radian status and workers report the project", async () => {
  const { env, fake } = await setup();
  await dispatchWorker(env, { role: "scout", title: "Look", task: "Look." }, "plan");
  assert.match(
    (await fake.run("/radian")) ?? "",
    /Project demo[\s\S]*Mode: PLAN[\s\S]*demo-scout-1 \[working/,
  );
  assert.match((await fake.run("/radian workers")) ?? "", /demo-scout-1/);
  assert.match((await fake.run("/radian merge")) ?? "", /Usage: \/radian/);
});

test("/radian stop and discard act on a worker; discard asks first", async () => {
  const { env, fake } = await setup();
  const worker = await dispatchWorker(env, { role: "developer", title: "A", task: "A." }, "build");
  assert.match((await fake.run(`/radian stop ${worker.name}`)) ?? "", /Stopped/);
  assert.match((await fake.run(`/radian discard ${worker.name}`)) ?? "", /cancelled by the user/);
  assert.ok(existsSync(worker.worktree));
  fake.answer.pick = (options) => options.find((option) => option === "Discard");
  assert.match((await fake.run(`/radian discard ${worker.name}`)) ?? "", /Discarded/);
  assert.deepEqual(listWorkers(workersFileOf(env)), []);
});

test("/new-project --branch and /add-project --target register and open the project", async () => {
  const { env, fake } = await setup();
  await fake.run("/new-project other --branch trunk");
  assert.equal(git(path.join(env.workspaceRoot, "other"), "branch", "--show-current"), "trunk");
  const repo = makeRepository();
  await fake.run(`/add-project ${repo} --target refs/heads/main`);
  assert.deepEqual(
    listProjects(env.workspaceRoot).map((project) => [project.name, project.target]),
    [
      ["demo", "main"],
      ["other", "trunk"],
      [path.basename(repo).toLowerCase(), "main"],
    ],
  );
  assert.deepEqual(fake.sessions, ["new", "new"]);
  assert.match((await fake.run("/add-project")) ?? "", /Usage: \/add-project/);
});

test("/delete-project is refused while a worker's pane is open, then removes the project", async () => {
  const { env, herdr, fake } = await setup();
  const worker = await dispatchWorker(env, { role: "scout", title: "Look", task: "Look." }, "plan");
  assert.match(
    (await fake.run("/delete-project demo")) ?? "",
    /still has running workers: demo-scout-1/,
  );
  herdr.panes.delete(worker.pane ?? "");
  assert.match((await fake.run("/delete-project demo")) ?? "", /Kept project demo/);
  fake.answer.pick = (options) => options.find((option) => /keep files/.test(option));
  await fake.run("/delete-project demo");
  assert.deepEqual(listProjects(env.workspaceRoot), []);
  assert.ok(existsSync(env.project.path));
  assert.deepEqual(
    fake.sessions,
    ["new"],
    "the deleted project was selected, so Pi returns to the dashboard",
  );
});

test("/radian tools lists the project's approved worker tools, and remove takes one away", async () => {
  const { env, fake } = await setup();
  assert.match((await fake.run("/radian tools")) ?? "", /No extra tools/);
  addWorkerTool(env.project.path, "mcp__godot__run_project");
  assert.match((await fake.run("/radian tools")) ?? "", /- mcp__godot__run_project/);
  assert.match((await fake.run("/radian tools remove mcp__godot__run_project")) ?? "", /Removed/);
  assert.deepEqual(readWorkerTools(env.project.path), []);
});
