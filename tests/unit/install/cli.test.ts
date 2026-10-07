import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const harness = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const cliPath = path.join(harness, "src", "install", "cli.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", stdio: "pipe" });
}

function makeWorkspace(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "radian-")));
}

test("CLI installs with --yes and then reports status", () => {
  const workspace = makeWorkspace();

  const installRun = runCli(["install", "--workspace", workspace, "--yes"]);
  assert.equal(installRun.status, 0, installRun.stderr);
  assert.match(installRun.stdout, /\.pi\/settings\.json: add Radian package entry/);
  assert.match(installRun.stdout, /Done: install applied/);
  assert.ok(fs.existsSync(path.join(workspace, ".radian", "install-manifest.json")));

  const statusRun = runCli(["status", "--workspace", workspace]);
  assert.equal(statusRun.status, 0, statusRun.stderr);
  assert.match(statusRun.stdout, /Harness: /);
  assert.match(statusRun.stdout, /Package entry: /);
  assert.doesNotMatch(statusRun.stdout, /missing|not in/);
});

test("CLI refuses to apply without a terminal or --yes", () => {
  const workspace = makeWorkspace();
  const run = runCli(["install", "--workspace", workspace]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--yes/);
  assert.ok(!fs.existsSync(path.join(workspace, ".radian")));
});

test("CLI exits 1 with the message when install is refused", () => {
  const workspace = makeWorkspace();
  assert.equal(runCli(["install", "--workspace", workspace, "--yes"]).status, 0);
  const run = runCli(["install", "--workspace", workspace, "--yes"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /run update/);
});

test("CLI exits 2 for an unknown command or option", () => {
  const unknownCommand = runCli(["frobnicate"]);
  assert.equal(unknownCommand.status, 2);
  assert.match(unknownCommand.stderr, /Usage:/);
  assert.equal(runCli(["status", "--bogus"]).status, 2);
  assert.equal(runCli([]).status, 2);
});
