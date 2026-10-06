// W03 — native offline routing at an installed workspace root with no project
// selected. A real `pi --mode rpc` (isolated HOME/agent directory, PI_OFFLINE,
// one-run --approve standing in for the user's trust) runs model tool calls
// scripted through pi-ai's faux provider; Radian's guard and confined read
// override decide each call. No credential, endpoint, or worker is involved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { removeDir } from "../unit/helpers/fixture.ts";
import { installedPi, installedWorkspace, workspacePi } from "./helpers/workspace.ts";

const pi = installedPi();

test("W03: the dashboard routes native model tool calls through Radian's guard and confined reads", { skip: pi ? false : "Pi 1.0.2 not installed" }, async () => {
  const w = await installedWorkspace(["alpha"]);
  const log = path.join(w.root, "requests.jsonl");
  const rpc = workspacePi(pi!, w.root, w.ws, log);
  const last = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { transcript: Array<{ role: string; text: string }>; systemPrompt: string }).at(-1)!;
  const toolResult = async (tool: string, args: Record<string, unknown>) => {
    await rpc.prompt(`TOOL ${tool} ${JSON.stringify(args)}`, 60_000);
    return last().transcript.at(-1)!.text;
  };
  try {
    const commands = ((await rpc.command("get_commands", {}, 60_000)).data as { commands: Array<{ name: string }> }).commands.map((c) => c.name);
    for (const c of ["radian", "projects", "workspace"]) assert.ok(commands.includes(c), c);
    assert.match(await toolResult("read", { path: "AGENTS.md" }), /WORKSPACE-MARKER/);
    assert.match(await toolResult("read", { path: ".radian/workspace.json" }), /PATH_OUTSIDE_SCOPE/);
    assert.match(await toolResult("read", { path: "../outside" }), /PATH_OUTSIDE_SCOPE/);
    // Disallowed tools are not declared to the model ("not found"); the guard refuses them if reached anyway.
    assert.match(await toolResult("bash", { command: "echo hi" }), /RH-COORD-SHELL|Tool bash not found/);
    assert.match(await toolResult("write", { path: "x.txt", content: "x" }), /RH-COORD|Tool write not found/);
    assert.match(await toolResult("grep", { pattern: "x" }), /RH-NO-PROJECT|Tool grep not found/);
    assert.match(await toolResult("radian_dispatch", { task: "t", role: "developer", objective: "o", planPath: "p" }), /RH-NO-PROJECT|Tool radian_dispatch not found/);
    assert.match(await toolResult("radian_status", {}), /no project selected[\s\S]*alpha/);
    assert.ok(last().systemPrompt.includes("no project is selected"), "the dashboard prompt says so");
    assert.ok(!last().systemPrompt.includes("PROJECT-ALPHA-MARKER"), "no project instructions on the dashboard");
    assert.ok(!existsSync(path.join(w.ws, "x.txt")));
  } finally {
    const code = await rpc.close();
    removeDir(w.root);
    assert.equal(code, 0, rpc.stderr.join("").slice(-1500));
  }
});
