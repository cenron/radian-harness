import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createFakePi } from "../../helpers/fake-pi.ts";
import { git } from "../../helpers/git-fixtures.ts";
import { actAsWorker, makeWorkerEnv } from "../../helpers/worker-fixtures.ts";
import { listWorkers } from "../../../src/io/worker-store.ts";
import { readWorkerTools } from "../../../src/io/worker-tools.ts";
import { State } from "../../../src/pi/state.ts";
import { StatusView } from "../../../src/pi/status/status-view.ts";
import { RADIAN_TOOL_NAMES, registerTools } from "../../../src/pi/tools/index.ts";
import { dispatchWorker } from "../../../src/workers/dispatch.ts";
import { workersFileOf } from "../../../src/workers/worker-env.ts";

async function setup() {
  const { env } = await makeWorkerEnv();
  const fake = createFakePi(env);
  registerTools({ state: fake.state, status: fake.status });
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

test("registerTools registers exactly the tools in RADIAN_TOOL_NAMES", async () => {
  const { env } = await makeWorkerEnv();
  const registered: string[] = [];
  const pi = {
    registerTool: (tool: ToolDefinition) => registered.push(tool.name),
  } as unknown as ExtensionAPI;
  const deps = { harnessRoot: env.harnessRoot, herdr: env.herdr, paneId: env.paneId };
  const state = new State(pi, deps);
  registerTools({ state, status: new StatusView(state) });
  assert.deepEqual(registered.sort(), [...RADIAN_TOOL_NAMES].sort());
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

test("radian_allow_tool asks the user, and only Allow saves the tool for the project", async () => {
  const { env, fake } = await setup();
  let dialog = { title: "", options: [] as string[] };
  fake.answer.pick = (options) => {
    dialog = { ...dialog, options };
    return undefined;
  };
  const ctxSelect = fake.ctx.ui.select;
  fake.ctx.ui.select = async (title, options) => {
    dialog.title = title;
    return ctxSelect(title, options);
  };
  const params = { tool: "mcp__godot__run_project", reason: "Run the game to check movement." };
  assert.match(await fake.callTool("radian_allow_tool", params), /not allowed: the user said no/);
  assert.deepEqual(dialog.options, ["Cancel", "Allow"]);
  assert.match(
    dialog.title,
    /^Allow workers in demo to use mcp__godot__run_project\?[\s\S]*Reason: Run the game to check movement\./,
  );
  assert.deepEqual(readWorkerTools(env.project.path), []);

  fake.answer.pick = (options) => options.find((option) => option === "Allow");
  assert.match(
    await fake.callTool("radian_allow_tool", params),
    /Allowed mcp__godot__run_project for new workers in demo\. Workers already running keep their tools/,
  );
  assert.deepEqual(readWorkerTools(env.project.path), ["mcp__godot__run_project"]);
  assert.match(await fake.callTool("radian_allow_tool", params), /already allowed/);
});

test("radian_allow_tool refuses anything but an MCP tool name", async () => {
  const { fake } = await setup();
  await assert.rejects(
    fake.callTool("radian_allow_tool", { tool: "Bash", reason: "x" }),
    /MCP tool/,
  );
});

test("radian_merge refuses a dirty checkout before asking, so an approval is never wasted", async () => {
  const { env, fake, worker } = await setup();
  writeFileSync(path.join(env.project.path, "dirty.txt"), "x");
  let wasAsked = false;
  fake.answer.pick = () => {
    wasAsked = true;
    return "Merge";
  };
  await assert.rejects(
    fake.callTool("radian_merge", { worker: worker.name }),
    /uncommitted changes: \?\? dirty\.txt/,
  );
  assert.equal(wasAsked, false);
});
