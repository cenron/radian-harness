// W05 — native offline acceptance of same-interface project work. A real
// `pi --mode rpc` at an installed workspace root (isolated HOME/agent
// directory, PI_OFFLINE, one-run --approve for the user's trust, pi-ai's faux
// provider) selects, switches, restores, creates, and returns from projects
// through Radian's commands. Every model request is logged, so the test checks
// exactly which transcript, instructions, and working directory reached the
// model. No credential, endpoint, worker, or existing pane is used.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { removeDir } from "../unit/helpers/fixture.ts";
import { type PiRpc, type RpcRecord } from "./helpers/pi-rpc.ts";
import { installedPi, installedWorkspace, workspacePi } from "./helpers/workspace.ts";

const pi = installedPi();

interface Request { systemPrompt: string; transcript: Array<{ role: string; text: string }>; cwd: string }

test("W05: create, select, switch, restore, and return in one Pi process with isolated project context", { skip: pi ? false : "Pi 1.0.2 not installed" }, async () => {
  const w = await installedWorkspace(["alpha", "beta"]);
  const home = path.join(w.root, "sb", "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Fixture Author\n\temail = fixture@example.com\n");
  const log = path.join(w.root, "requests.jsonl");
  const dialogs: string[] = [];
  const ui = (r: RpcRecord): Record<string, unknown> => {
    dialogs.push(`${String(r.title)}\n${String(r.message ?? "")}`);
    return r.method === "confirm" ? { confirmed: true } : { cancelled: true };
  };
  const requests = (): Request[] => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Request);
  const last = () => requests().at(-1)!;
  const state = async (rpc: PiRpc) => (await rpc.command("get_state")).data as { sessionFile: string; thinkingLevel: string };
  const command = async (rpc: PiRpc, text: string) => {
    const before = rpc.notes.length;
    const response = await rpc.prompt(text, 60_000);
    assert.equal((response.data as { disposition?: string }).disposition, "handled", `${text} is a Radian command`);
    await rpc.wait(() => rpc.notes.length > before, 60_000);
    return rpc.notes.slice(before).join("\n");
  };
  let rpc = workspacePi(pi!, w.root, w.ws, log, ui);
  try {
    await rpc.prompt("hello dashboard", 60_000);
    assert.ok(last().systemPrompt.includes("WORKSPACE-MARKER") && !/PROJECT-(ALPHA|BETA)-MARKER/.test(last().systemPrompt));
    const dashboardFile = (await state(rpc)).sessionFile;
    await rpc.command("set_thinking_level", { level: "high" });

    assert.match(await command(rpc, "/projects alpha"), /Project alpha selected/);
    const aFile = (await state(rpc)).sessionFile;
    assert.notEqual(aFile, dashboardFile);
    assert.equal((await state(rpc)).thinkingLevel, "high", "selection keeps the interface's thinking level");
    await rpc.prompt("hello A", 60_000);
    let req = last();
    assert.ok(req.systemPrompt.includes("PROJECT-ALPHA-MARKER") && !req.systemPrompt.includes("PROJECT-BETA-MARKER"));
    assert.ok(req.systemPrompt.includes(w.dirs.alpha!), "the project root is the model's working directory");
    assert.deepEqual(req.transcript.map((t) => t.text), ["hello A"], "no dashboard history");
    assert.equal(req.cwd, w.ws, "Pi's process cwd stays the workspace root");
    await rpc.prompt('TOOL read {"path":"alpha.txt"}', 60_000);
    assert.match(last().transcript.at(-1)!.text, /content-of-alpha/);
    await rpc.prompt('TOOL read {"path":"../beta/beta.txt"}', 60_000);
    assert.match(last().transcript.at(-1)!.text, /PATH_OUTSIDE_SCOPE/);

    assert.match(await command(rpc, "/projects beta"), /Project beta selected/);
    await rpc.prompt("hello B", 60_000);
    req = last();
    assert.ok(req.systemPrompt.includes("PROJECT-BETA-MARKER") && !req.systemPrompt.includes("PROJECT-ALPHA-MARKER"));
    assert.deepEqual(req.transcript.map((t) => t.text), ["hello B"], "A's transcript does not enter B");

    assert.match(await command(rpc, "/projects alpha"), /Project alpha selected/);
    assert.equal((await state(rpc)).sessionFile, aFile, "A's own conversation is restored");
    await rpc.prompt("back in A", 60_000);
    req = last();
    assert.ok(req.transcript.some((t) => t.text === "hello A") && !req.transcript.some((t) => /hello (B|dashboard)/.test(t.text)));

    assert.match(await command(rpc, "/workspace"), /Workspace dashboard/);
    await rpc.prompt("dashboard again", 60_000);
    req = last();
    assert.deepEqual(req.transcript.map((t) => t.text), ["dashboard again"]);
    assert.ok(!/PROJECT-(ALPHA|BETA)-MARKER/.test(req.systemPrompt));

    assert.match(await command(rpc, "/new-project demo"), /Project demo selected/);
    assert.ok(dialogs.some((d) => /Create project demo[\s\S]*Initial branch: main/.test(d)), "the exact plan was shown for confirmation");
    const git = (args: string[]) => spawnSync("/usr/bin/git", args, { cwd: path.join(w.ws, "demo"), encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).stdout.trim();
    assert.equal(git(["rev-list", "--count", "HEAD"]), "1");
    assert.equal(git(["log", "-1", "--format=%an"]), "Fixture Author");
    await rpc.prompt("hello demo", 60_000);
    assert.ok(last().systemPrompt.includes(path.join(w.ws, "demo")));
    assert.deepEqual(last().transcript.map((t) => t.text), ["hello demo"]);
    assert.equal((await state(rpc)).thinkingLevel, "high");
    assert.ok(!existsSync(path.join(w.ws, ".git")), "the workspace is still not a Git repository");
  } finally {
    assert.equal(await rpc.close(), 0, rpc.stderr.join("").slice(-1500));
  }
  // Restart: a new Pi process starts on the dashboard and restores A's validated context.
  rpc = workspacePi(pi!, w.root, w.ws, log, ui);
  try {
    await rpc.prompt("fresh start", 60_000);
    assert.deepEqual(last().transcript.map((t) => t.text), ["fresh start"]);
    assert.match(await command(rpc, "/projects alpha"), /Project alpha selected/);
    await rpc.prompt("after restart", 60_000);
    const req = last();
    assert.ok(req.transcript.some((t) => t.text === "hello A") && req.transcript.some((t) => t.text === "back in A"));
    assert.ok(!req.transcript.some((t) => /hello B|fresh start|hello demo/.test(t.text)));
  } finally {
    const code = await rpc.close();
    removeDir(w.root);
    assert.equal(code, 0, rpc.stderr.join("").slice(-1500));
  }
});
