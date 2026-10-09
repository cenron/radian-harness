import assert from "node:assert/strict";
import { test } from "node:test";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { createFakePi } from "../../helpers/fake-pi.ts";
import { actAsWorker, makeWorkerEnv } from "../../helpers/worker-fixtures.ts";
import { listWorkers } from "../../../src/io/worker-store.ts";
import { readAutoMerge, writeAutoMerge } from "../../../src/io/workspace.ts";
import { registerCommands } from "../../../src/pi/commands/index.ts";
import { ProjectMode } from "../../../src/pi/mode/project-mode.ts";
import { ModelCarry } from "../../../src/pi/session/model-carry.ts";
import { ProjectSession } from "../../../src/pi/session/project-session.ts";
import { SystemPrompt } from "../../../src/pi/session/system-prompt.ts";
import { projectStatusLine } from "../../../src/pi/status/footer.ts";
import { projectReport } from "../../../src/pi/status/reports.ts";
import { registerTools } from "../../../src/pi/tools/index.ts";
import { dispatchWorker } from "../../../src/workers/dispatch.ts";
import { workersFileOf } from "../../../src/workers/worker-env.ts";

async function setup() {
  const { env } = await makeWorkerEnv();
  const fake = createFakePi(env);
  const mode = new ProjectMode(fake.state, fake.status);
  const session = new ProjectSession(env.harnessRoot, new ModelCarry(fake.state.pi));
  registerTools({ state: fake.state, status: fake.status });
  registerCommands({ state: fake.state, session, status: fake.status, mode });
  const worker = await dispatchWorker(
    env,
    { role: "developer", title: "A", task: "Add a." },
    "build",
  );
  actAsWorker(worker, { file: "a.txt", status: ["done: added a"] });
  const autoMerge = (seconds: number) => writeAutoMerge(env.workspaceRoot, "demo", seconds);
  const workers = () => listWorkers(workersFileOf(env));
  return { env, fake, worker, autoMerge, workers };
}

test("with auto-merge off, the merge dialog waits for an answer", async () => {
  const { fake, worker, autoMerge } = await setup();
  autoMerge(0);
  fake.answer.pick = (options) => options.find((option) => option === "Merge");
  const result = await fake.callTool("radian_merge", { worker: worker.name });
  assert.match(result, /^Merged /);
  assert.doesNotMatch(result, /automatically/);
  assert.equal(fake.dialogs[0]?.timeout, undefined);
});

test("an unanswered merge dialog merges when its countdown runs out", async () => {
  const { fake, worker, autoMerge, workers } = await setup();
  autoMerge(0.4);
  fake.answer.waits = true;
  const result = await fake.callTool("radian_merge", { worker: worker.name });
  assert.match(result, /Merged automatically after 0\.4s with no answer/);
  assert.equal(fake.dialogs[0]?.timeout, 400);
  assert.match(fake.dialogs[0]?.title ?? "", /Merges on its own in 0\.4s unless you cancel/);
  assert.deepEqual(fake.dialogs[0]?.options, ["Cancel", "Merge"], "Cancel stays first");
  assert.deepEqual(workers(), []);
});

test("Esc during the countdown cancels the merge", async () => {
  const { fake, worker, autoMerge, workers } = await setup();
  autoMerge(5);
  fake.answer.pick = () => undefined;
  const result = await fake.callTool("radian_merge", { worker: worker.name });
  assert.match(result, /cancelled by the user/);
  assert.equal(workers().length, 1);
});

test("choosing Merge during the countdown merges at once", async () => {
  const { fake, worker, autoMerge } = await setup();
  autoMerge(5);
  fake.answer.pick = (options) => options.find((option) => option === "Merge");
  const result = await fake.callTool("radian_merge", { worker: worker.name });
  assert.match(result, /^Merged /);
  assert.doesNotMatch(result, /automatically/);
});

test("a merge the user types with /radian merge never counts down", async () => {
  const { fake, worker, autoMerge } = await setup();
  autoMerge(5);
  fake.answer.pick = () => undefined;
  await fake.run(`/radian merge ${worker.name}`);
  assert.equal(fake.dialogs[0]?.timeout, undefined);
});

test("/radian automerge turns the countdown on, sets it, shows it, and turns it off", async () => {
  const { env, fake } = await setup();
  const stored = () => readAutoMerge(env.workspaceRoot, "demo", -1);
  assert.match(
    (await fake.run("/radian automerge")) ?? "",
    /merges after 60s/,
    "auto-merge ships on at 60s",
  );
  assert.match((await fake.run("/radian automerge off")) ?? "", /Auto-merge off/);
  assert.equal(stored(), 0);
  assert.match((await fake.run("/radian automerge on")) ?? "", /merges after 60s/);
  assert.equal(stored(), 60);
  await fake.run("/radian automerge 90");
  assert.equal(stored(), 90);
  assert.match((await fake.run("/radian automerge")) ?? "", /merges after 90s/);
  assert.match((await fake.run("/radian automerge soon")) ?? "", /Usage: \/radian automerge/);
  assert.match((await fake.run("/radian automerge off")) ?? "", /Auto-merge off/);
  assert.equal(stored(), 0);
});

test("the footer and the status report show when auto-merge is on", () => {
  const project = { name: "demo", path: "/ws/demo", target: "main" };
  const status = { project, mode: "build" as const, workers: [], maxWorkers: 3 };
  assert.doesNotMatch(projectStatusLine(status), /AUTO-MERGE/);
  assert.match(
    projectStatusLine({ ...status, autoMergeSeconds: 60 }),
    /Radian · demo · BUILD · AUTO-MERGE 60s · no workers/,
  );
  assert.match(projectReport({ ...status, autoMergeSeconds: 60 }), /Auto-merge: .* after 60s/);
});

test("with auto-merge on, Pi is told to offer finished work for merging right away", async () => {
  const { fake, autoMerge } = await setup();
  const describe = () => {
    const options = { skills: [] } as unknown as BuildSystemPromptOptions;
    new SystemPrompt(fake.state).describe(options);
    return options.sections?.radian ?? "";
  };
  autoMerge(0);
  assert.doesNotMatch(describe(), /Auto-merge/);
  autoMerge(60);
  assert.match(describe(), /Auto-merge is on: .* after 60s.*call radian_merge right away/);
});
