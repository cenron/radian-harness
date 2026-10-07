import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeHerdr } from "../../helpers/fake-herdr.ts";
import {
  closePane,
  getPane,
  parseCreatedPane,
  promptAgent,
  renamePane,
  splitPane,
  startAgent,
  type HerdrRunner,
} from "../../../src/io/herdr.ts";

test("splitPane opens a pane to the right without focus and blanks the given variables", async () => {
  const herdr = createFakeHerdr();
  const pane = await splitPane(herdr.run, {
    from: "w1:p1",
    cwd: "/ws/wt",
    blankedEnv: ["ANTHROPIC_API_KEY", "HTTPS_PROXY"],
  });
  assert.equal(pane, "w9:p1");
  assert.deepEqual(herdr.calls[0], [
    "pane",
    "split",
    "w1:p1",
    "--direction",
    "right",
    "--cwd",
    "/ws/wt",
    "--no-focus",
    "--env",
    "ANTHROPIC_API_KEY=",
    "--env",
    "HTTPS_PROXY=",
  ]);
});

test("renamePane, startAgent, promptAgent, and closePane use Herdr's command shapes", async () => {
  const herdr = createFakeHerdr();
  await renamePane(herdr.run, "w9:p1", "developer Add login");
  await startAgent(herdr.run, {
    name: "demo-developer-1",
    kind: "claude",
    pane: "w9:p1",
    args: ["--model", "claude-sonnet-5-5"],
  });
  await promptAgent(herdr.run, "demo-developer-1", "hello\n\nworld");
  await closePane(herdr.run, "w9:p1");
  assert.deepEqual(herdr.calls, [
    ["pane", "rename", "w9:p1", "developer Add login"],
    [
      "agent",
      "start",
      "demo-developer-1",
      "--kind",
      "claude",
      "--pane",
      "w9:p1",
      "--timeout",
      "120000",
      "--",
      "--model",
      "claude-sonnet-5-5",
    ],
    ["agent", "prompt", "demo-developer-1", "hello\n\nworld"],
    ["pane", "close", "w9:p1"],
  ]);
});

test("getPane reads the agent status, and is undefined once the pane is closed", async () => {
  const herdr = createFakeHerdr();
  const pane = await splitPane(herdr.run, { from: "w1:p1", cwd: "/", blankedEnv: [] });
  await startAgent(herdr.run, { name: "w", kind: "pi", pane, args: [] });
  herdr.panes.set(pane, "working");
  assert.deepEqual(await getPane(herdr.run, pane), { agentStatus: "working" });
  await closePane(herdr.run, pane);
  assert.equal(await getPane(herdr.run, pane), undefined);
});

test("a failing herdr command throws with its error output", async () => {
  const failing: HerdrRunner = async () => ({ stdout: "", stderr: "no such pane", exitCode: 1 });
  await assert.rejects(renamePane(failing, "w9:p1", "x"), /herdr pane rename failed: no such pane/);
});

test("parseCreatedPane reads the pane id or throws on unexpected output", () => {
  assert.equal(parseCreatedPane('{"result":{"pane":{"pane_id":"w1:pA"}}}'), "w1:pA");
  assert.throws(() => parseCreatedPane("not json"), /pane id/);
  assert.throws(() => parseCreatedPane('{"result":{}}'), /pane id/);
});
