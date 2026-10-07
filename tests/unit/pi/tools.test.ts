import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { createFakePi } from "../../helpers/fake-pi.ts";
import { git } from "../../helpers/git-fixtures.ts";
import { actAsWorker, makeWorkerEnv } from "../../helpers/worker-fixtures.ts";
import { listWorkers } from "../../../src/io/worker-store.ts";
import { RADIAN_TOOL_NAMES, registerTools } from "../../../src/pi/tools.ts";
import { dispatchWorker } from "../../../src/workers/dispatch.ts";
import { workersFileOf } from "../../../src/workers/worker-env.ts";

async function setup() {
  const { env } = await makeWorkerEnv();
  const fake = createFakePi(env);
  registerTools(fake.state);
  const worker = await dispatchWorker(
    env,
    { role: "developer", title: "A", task: "Add a." },
    "build",
  );
  actAsWorker(worker, { file: "a.txt", status: ["done: added a"] });
  return { env, fake, worker };
}

test("radian_discard is one of the coordinator's tools", () => {
  assert.ok(RADIAN_TOOL_NAMES.includes("radian_discard"));
});

test("radian_discard asks first, with Cancel as the default, and keeps the work when cancelled", async () => {
  const { env, fake, worker } = await setup();
  let offered: string[] = [];
  fake.answer.pick = (options) => {
    offered = options;
    return undefined;
  };
  assert.match(
    await fake.callTool("radian_discard", { worker: worker.name }),
    /cancelled by the user/,
  );
  assert.deepEqual(offered, ["Cancel", "Discard"]);
  assert.ok(existsSync(worker.worktree));
  assert.equal(listWorkers(workersFileOf(env)).length, 1);
});

test("radian_discard removes the pane, worktree, and branch once the user approves", async () => {
  const { env, fake, worker } = await setup();
  fake.answer.pick = (options) => options.find((option) => option === "Discard");
  assert.match(
    await fake.callTool("radian_discard", { worker: worker.name }),
    /Discarded demo-developer-1/,
  );
  assert.equal(existsSync(worker.worktree), false);
  assert.equal(git(env.project.path, "branch", "--list", worker.branch), "");
  assert.deepEqual(listWorkers(workersFileOf(env)), []);
});
