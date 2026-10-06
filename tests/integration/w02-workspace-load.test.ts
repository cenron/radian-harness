// W02 — native offline check that an empty, non-Git workspace installed by the
// workspace-first installer loads Radian when Pi starts at its root. A real
// `pi --mode rpc` runs with an isolated HOME/agent directory and PI_OFFLINE;
// the one-run `--approve` flag stands in for the user's own trust decision
// (nothing is written to any trust store). No model request is made.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutable } from "../../src/util/proc.ts";
import { applyPlan, planInstall } from "../../src/workspace/installer.ts";
import { removeDir, tempDir } from "../unit/helpers/fixture.ts";
import { PiRpc } from "./helpers/pi-rpc.ts";

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function installedPi(): string | undefined {
  const exe = resolveExecutable("pi", process.env.PATH);
  if (!exe) return undefined;
  const out = spawnSync(exe, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: tempDir("radian-ver-") }, timeout: 20_000 });
  return `${out.stdout}${out.stderr}`.includes("1.0.2") ? realpathSync(exe) : undefined;
}
const pi = installedPi();

test("W02: Pi started at an installed empty workspace root loads Radian without the workspace becoming a Git repository", { skip: pi ? false : "Pi 1.0.2 not installed" }, async () => {
  const root = tempDir("radian-w02-");
  const ws = path.join(root, "empty workspace");
  mkdirSync(ws);
  const plan = await planInstall({ workspaceRoot: ws, source: { kind: "local", path: HARNESS } });
  assert.ok(plan.ok, plan.ok ? "" : plan.blocker.message);
  if (!plan.ok) return;
  assert.ok(applyPlan(plan.value, plan.value.hash).ok);
  const rpc = new PiRpc({ pi: pi!, cwd: ws, sandbox: path.join(root, "sb"), args: ["--approve", "--no-session"] });
  try {
    const commands = ((await rpc.command("get_commands", {}, 60_000)).data as { commands: Array<{ name: string; source?: string }> }).commands.map((c) => c.name);
    assert.ok(commands.includes("radian"), `Radian's command is registered: ${commands.join(", ")}`);
    assert.ok(!existsSync(path.join(ws, ".git")));
  } finally {
    const code = await rpc.close();
    removeDir(root);
    assert.equal(code, 0, rpc.stderr.join("").slice(-1500));
  }
});

test("W02: without the user's trust decision Pi does not load the workspace package (the installer grants no trust)", { skip: pi ? false : "Pi 1.0.2 not installed" }, async () => {
  const root = tempDir("radian-w02-");
  const ws = path.join(root, "ws");
  mkdirSync(ws);
  const plan = await planInstall({ workspaceRoot: ws, source: { kind: "local", path: HARNESS } });
  assert.ok(plan.ok && applyPlan(plan.value, plan.value.hash).ok);
  const rpc = new PiRpc({ pi: pi!, cwd: ws, sandbox: path.join(root, "sb"), args: ["--no-session"] });
  try {
    const commands = ((await rpc.command("get_commands", {}, 60_000)).data as { commands: Array<{ name: string }> }).commands.map((c) => c.name);
    assert.ok(!commands.includes("radian"));
    assert.ok(!existsSync(path.join(root, "sb", "agent", "trust.json")), "no trust decision was recorded");
  } finally {
    const code = await rpc.close();
    removeDir(root);
    assert.equal(code, 0, rpc.stderr.join("").slice(-1500));
  }
});
