import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePi } from "../../helpers/fake-pi.ts";
import { makeWorkerEnv } from "../../helpers/worker-fixtures.ts";
import { readMode } from "../../../src/io/workspace.ts";
import { registerCommands } from "../../../src/pi/commands/index.ts";
import {
  BUILD_CHOICES,
  BUILD_FRESH_COMMAND,
  ProjectMode,
} from "../../../src/pi/mode/project-mode.ts";
import { planHandoff } from "../../../src/pi/session/handoff.ts";
import { ModelCarry } from "../../../src/pi/session/model-carry.ts";
import { ProjectSession } from "../../../src/pi/session/project-session.ts";
import { registerTools } from "../../../src/pi/tools/index.ts";

const PLAN = "# Login plan\n\n1. Add the form.\n2. Add the session check.";

async function setup() {
  const { env } = await makeWorkerEnv();
  const fake = createFakePi(env);
  const mode = new ProjectMode(fake.state, fake.status);
  const session = new ProjectSession(env.harnessRoot, new ModelCarry(fake.state.pi));
  registerTools({ state: fake.state, status: fake.status });
  registerCommands({ state: fake.state, session, status: fake.status, mode });
  const modeOf = () => readMode(env.workspaceRoot, "demo", "plan");
  const writePlan = () =>
    fake.callTool("radian_write_doc", { path: "login-plan.md", content: PLAN });
  return { fake, mode, modeOf, writePlan };
}

test("radian_write_doc remembers the plan it wrote for the build handoff", async () => {
  const { fake, writePlan } = await setup();
  await writePlan();
  assert.equal(fake.state.lastPlan, ".radian/planning/login-plan.md");
});

test("without a plan this session, leaving Plan switches straight to Build", async () => {
  const { fake, modeOf } = await setup();
  fake.answer.pick = () => assert.fail("no dialog without a plan");
  assert.match((await fake.run("/radian mode build")) ?? "", /Mode: BUILD/);
  assert.equal(modeOf(), "build");
});

test("with a plan, leaving Plan offers to build here, start fresh, or compact", async () => {
  const { fake, modeOf, writePlan } = await setup();
  await writePlan();
  let offered: string[] = [];
  fake.answer.pick = (options) => ((offered = options), BUILD_CHOICES.here);
  assert.match((await fake.run("/radian mode build")) ?? "", /Mode: BUILD/);
  assert.deepEqual(offered, Object.values(BUILD_CHOICES));
  assert.equal(modeOf(), "build");
  assert.deepEqual(fake.newSessions, [], "building here keeps the conversation");
});

test("Compact and build compacts around the plan, then switches to Build", async () => {
  const { fake, modeOf, writePlan } = await setup();
  await writePlan();
  fake.answer.pick = () => BUILD_CHOICES.compact;
  assert.match((await fake.run("/radian mode build")) ?? "", /Compacting/);
  assert.equal(modeOf(), "build");
  assert.match(fake.compactions[0] ?? "", /login-plan\.md/);
});

test("Clear context hands off to /radian build --fresh, which owns the session switch", async () => {
  const { fake, modeOf, writePlan } = await setup();
  await writePlan();
  fake.answer.pick = () => BUILD_CHOICES.fresh;
  await fake.run("/radian mode build");
  assert.deepEqual(fake.userMessages, [
    { text: BUILD_FRESH_COMMAND, options: { expandPromptTemplates: true } },
  ]);
  assert.equal(modeOf(), "plan", "the dispatched command switches the mode");
});

test("cancelling the dialog stays in Plan", async () => {
  const { fake, modeOf, writePlan } = await setup();
  await writePlan();
  fake.answer.pick = () => undefined;
  assert.match((await fake.run("/radian mode build")) ?? "", /Still in Plan mode/);
  assert.equal(modeOf(), "plan");
});

test("Shift+Tab out of Plan offers the same choices", async () => {
  const { fake, mode, modeOf, writePlan } = await setup();
  await writePlan();
  fake.answer.pick = () => BUILD_CHOICES.here;
  await mode.toggle(fake.ctx);
  assert.equal(modeOf(), "build");
  await mode.toggle(fake.ctx);
  assert.equal(modeOf(), "plan", "Build back to Plan never asks");
});

test("/radian build --fresh builds in a new project session that starts with the plan", async () => {
  const { fake, modeOf, writePlan } = await setup();
  await writePlan();
  await fake.run("/radian build --fresh");
  assert.equal(modeOf(), "build");
  const [fresh] = fake.newSessions;
  assert.deepEqual(fresh?.entries, [{ customType: "radian-project", data: { project: "demo" } }]);
  assert.equal(fresh?.prompts.length, 1);
  assert.match(fresh?.prompts[0] ?? "", /\.radian\/planning\/login-plan\.md/);
  assert.match(fresh?.prompts[0] ?? "", /2\. Add the session check\./);
});

test("/radian build --fresh needs a plan written in this session", async () => {
  const { fake, modeOf } = await setup();
  assert.match((await fake.run("/radian build --fresh")) ?? "", /No plan was written/);
  assert.equal(modeOf(), "plan");
  assert.deepEqual(fake.newSessions, []);
});

test("/projects new-session starts an empty conversation for the selected project", async () => {
  const { fake } = await setup();
  await fake.run("/projects new-session");
  const [fresh] = fake.newSessions;
  assert.deepEqual(fresh?.entries, [{ customType: "radian-project", data: { project: "demo" } }]);
  assert.deepEqual(fresh?.prompts, []);
});

test("a long plan is handed over by its path instead of inline", () => {
  const long = "x".repeat(25_000);
  assert.doesNotMatch(planHandoff("plan.md", long), /x{100}/);
  assert.match(planHandoff("plan.md", long), /Read plan\.md first/);
  assert.match(planHandoff("plan.md", "short plan"), /short plan/);
});
