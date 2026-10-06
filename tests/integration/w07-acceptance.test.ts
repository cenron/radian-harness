// W07 — end-to-end offline acceptance in a disposable fixture: empty non-Git
// workspace installation through the CLI → Pi trust/load (one-run --approve)
// → dashboard → confirmed /new-project bootstrap → project-scoped planning and
// control → /add-project of a second repository → first-project restore →
// Pi restart → installer status/update/remove/recover. A real offline Pi
// (`--mode rpc`, isolated HOME/agent directory, PI_OFFLINE, pi-ai's faux
// provider) is used; no credential, endpoint, worker, or existing pane.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseCommand, runCommand } from "../../src/workspace/cli.ts";
import { readManifest } from "../../src/workspace/installer.ts";
import { makeRepo, removeDir, tempDir } from "../unit/helpers/fixture.ts";
import type { PiRpc, RpcRecord } from "./helpers/pi-rpc.ts";
import { HARNESS, installedPi, workspacePi } from "./helpers/workspace.ts";

const pi = installedPi();

interface Request { systemPrompt: string; transcript: Array<{ role: string; text: string }> }

function git(cwd: string, ...args: string[]): string {
  return spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).stdout.trim();
}

async function cli(args: string[]): Promise<{ exitCode: number; text: string }> {
  const parsed = parseCommand(args);
  if ("error" in parsed) throw new Error(parsed.error);
  const preview = await runCommand(parsed);
  const hash = /Plan hash: (\S+)/.exec(preview.lines.join("\n"))?.[1];
  if (!hash || preview.exitCode === 2) return { exitCode: preview.exitCode, text: preview.lines.join("\n") };
  const applied = await runCommand({ ...parsed, apply: hash });
  return { exitCode: applied.exitCode, text: applied.lines.join("\n") };
}

test("W07: install → load → create → plan → register → select → restore → restart → update → remove → recover", { skip: pi ? false : "Pi 1.0.2 not installed" }, async () => {
  const root = tempDir("radian-w07-");
  const ws = path.join(root, "my workspace");
  mkdirSync(ws);
  const home = path.join(root, "sb", "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Fixture Author\n\temail = fixture@example.com\n");
  const log = path.join(root, "requests.jsonl");
  const ui = (r: RpcRecord): Record<string, unknown> => (r.method === "confirm" ? { confirmed: true } : { cancelled: true });
  const last = (): Request => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Request).at(-1)!;
  const command = async (rpc: PiRpc, text: string) => {
    const before = rpc.notes.length;
    await rpc.prompt(text, 60_000);
    await rpc.wait(() => rpc.notes.length > before, 60_000);
    return rpc.notes.slice(before).join("\n");
  };
  try {
    // 1. Empty, non-Git workspace installed through the CLI (preview, then the reviewed hash).
    const installed = await cli(["install", "--workspace", ws, "--local", HARNESS]);
    assert.equal(installed.exitCode, 0, installed.text);
    assert.ok(!existsSync(path.join(ws, ".git")));
    // 2. Pi at the workspace root: dashboard.
    let rpc = workspacePi(pi!, root, ws, log, ui);
    try {
      assert.match(await command(rpc, "/projects"), /no registered projects/);
      // 3. Confirmed minimal project creation, activated in the same interface.
      assert.match(await command(rpc, "/new-project app"), /Project app selected/);
      const app = path.join(ws, "app");
      assert.equal(git(app, "rev-list", "--count", "HEAD"), "1");
      assert.equal(git(app, "status", "--porcelain"), "");
      // 4. Project-scoped planning and control.
      await rpc.prompt('TOOL radian_write_artifact {"path":"spec.md","content":"# App spec\\n"}', 60_000);
      assert.match(last().transcript.at(-1)!.text, /Wrote \.radian\/planning\/spec\.md/);
      assert.equal(readFileSync(path.join(app, ".radian", "planning", "spec.md"), "utf8"), "# App spec\n");
      // 0016: real Pi declares the model-only request tool and runs it; over RPC no dialog opens and nothing is recorded.
      await rpc.prompt('TOOL radian_request_approval {"kind":"spec","path":".radian/planning/spec.md"}', 60_000);
      assert.match(last().transcript.at(-1)!.text, /NONINTERACTIVE_APPROVAL_REQUIRED/);
      assert.match(await command(rpc, "/radian status"), /No active run yet/, "a refused request does not even open a run");
      assert.match(await command(rpc, "/radian mode build"), /Mode: BUILD/);
      assert.match(await command(rpc, "/radian status"), /BUILD · project prj_/);
      await rpc.prompt("remember app", 60_000);
      // 5. Register a second, existing repository with an explicit target; it becomes selected.
      const lib = path.join(ws, "lib");
      mkdirSync(lib);
      const repo = await makeRepo(lib);
      repo.write("AGENTS.md", "LIB-MARKER\n");
      await repo.commitAll("lib base");
      assert.match(await command(rpc, "/add-project lib --target refs/heads/main"), /Project lib selected/);
      await rpc.prompt("hello lib", 60_000);
      assert.ok(last().systemPrompt.includes("LIB-MARKER"));
      assert.deepEqual(last().transcript.map((t) => t.text), ["hello lib"]);
      assert.match(await command(rpc, "/radian mode"), /Mode: PLAN/, "modes are per project");
      // 6. First project restored with its own conversation.
      assert.match(await command(rpc, "/projects app"), /Project app selected/);
      await rpc.prompt("back to app", 60_000);
      assert.ok(last().transcript.some((t) => t.text === "remember app") && !last().transcript.some((t) => t.text === "hello lib"));
      assert.match(await command(rpc, "/radian mode"), /Mode: BUILD/);
    } finally {
      assert.equal(await rpc.close(), 0, rpc.stderr.join("").slice(-1500));
    }
    // 7. Restart: dashboard first, then the second project's context is restored.
    rpc = workspacePi(pi!, root, ws, log, ui);
    try {
      assert.match(await command(rpc, "/projects"), /app[\s\S]*lib/);
      assert.match(await command(rpc, "/projects lib"), /Project lib selected/);
      await rpc.prompt("after restart", 60_000);
      assert.ok(last().transcript.some((t) => t.text === "hello lib"));
    } finally {
      assert.equal(await rpc.close(), 0, rpc.stderr.join("").slice(-1500));
    }
    // 8. Installer status, update between runs, remove, recover — work and private evidence preserved.
    const status = await runCommand({ command: "status", workspace: ws, projects: [] });
    assert.equal(status.exitCode, 0);
    const report = JSON.parse(status.lines.join("\n")) as { projects: Array<{ entry: string }>; workspaceEntry: string };
    assert.equal(report.workspaceEntry, "owned-unchanged");
    assert.deepEqual(report.projects.map((p) => p.entry).sort(), ["owned-unchanged", "owned-unchanged"]);
    const updated = await cli(["update", "--workspace", ws, "--source", `git:github.com/example/radian-harness@${"c".repeat(40)}`]);
    assert.equal(updated.exitCode, 0, updated.text);
    assert.equal(JSON.parse(readFileSync(path.join(ws, ".pi", "settings.json"), "utf8")).packages[0].source, `git:github.com/example/radian-harness@${"c".repeat(40)}`);
    const removed = await cli(["remove", "--workspace", ws]);
    assert.equal(removed.exitCode, 0, removed.text);
    assert.equal(readManifest(ws), undefined);
    assert.ok(!existsSync(path.join(ws, ".pi", "settings.json")) && !existsSync(path.join(ws, "app", ".pi", "settings.json")) && !existsSync(path.join(ws, "lib", ".pi", "settings.json")));
    assert.equal(git(path.join(ws, "app"), "rev-list", "--count", "HEAD"), "1", "project history kept");
    assert.ok(existsSync(path.join(ws, "app", ".radian", "planning", "spec.md")), "planning artifacts kept");
    assert.ok(readdirSync(path.join(ws, ".radian", "projects")).length === 2, "private project state kept");
    const recovered = await runCommand({ command: "recover", workspace: ws, projects: [] });
    assert.match(recovered.lines[0]!, /recovered 0 action/);
  } finally {
    removeDir(root);
  }
});
