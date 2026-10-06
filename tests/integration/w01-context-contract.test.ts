// W01 — native offline proof of the Pi 1.0.2 public-API contract that the
// workspace-first design relies on. A real `pi --mode rpc` process runs at a
// disposable workspace root with an isolated HOME/agent directory, PI_OFFLINE,
// and pi-ai's public faux provider (tests/integration/fixtures/probe-model.ts);
// no credential, provider endpoint, Herdr pane, or user configuration is used.
// The probe extension (fixtures/w01-contract-probe.ts) uses only public APIs.
// Skips (never passes) when Pi 1.0.2 is not installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutable } from "../../src/util/proc.ts";
import { removeDir, tempDir } from "../unit/helpers/fixture.ts";
import { PiRpc } from "./helpers/pi-rpc.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function installedPi(): string | undefined {
  const exe = resolveExecutable("pi", process.env.PATH);
  if (!exe) return undefined;
  const out = spawnSync(exe, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: tempDir("radian-ver-") }, timeout: 20_000 });
  return `${out.stdout}${out.stderr}`.includes("1.0.2") ? realpathSync(exe) : undefined;
}
const pi = installedPi();

interface ProbeState { pid: number; processCwd: string; ctxCwd: string; selected: string | null; starts: number; evaluations: number; shutdownReasons: string[]; nested: string[]; sessionFile: string; model: string | null; thinking: string }
interface Request { call: number; systemPrompt: string; transcript: Array<{ role: string; text: string }>; cwd: string }

test("W01: same-process project conversations with isolated context, fixed cwd, confined tools, and guarded nested calls", { skip: pi ? false : "Pi 1.0.2 not installed" }, async () => {
  const root = realpathSync(tempDir("radian-w01-"));
  const ws = path.join(root, "ws");
  for (const p of ["A", "B"]) mkdirSync(path.join(ws, p), { recursive: true });
  writeFileSync(path.join(ws, "AGENTS.md"), "WORKSPACE-MARKER\n");
  writeFileSync(path.join(ws, "A", "AGENTS.md"), "PROJECT-A-MARKER\n");
  writeFileSync(path.join(ws, "A", "a.txt"), "content-of-a\n");
  writeFileSync(path.join(ws, "B", "AGENTS.md"), "PROJECT-B-MARKER\n");
  writeFileSync(path.join(ws, "B", "b.txt"), "content-of-b\n");
  // Project-local executable/instruction resources that must not load in the workspace view.
  const marker = path.join(root, "project-extension-loaded");
  for (const d of [".pi/extensions", ".pi/prompts", ".agents/skills/proj-skill"]) mkdirSync(path.join(ws, "A", d), { recursive: true });
  writeFileSync(path.join(ws, "A", ".pi", "extensions", "proj.ts"), `import { writeFileSync } from "node:fs";\nexport default function (pi: any) { writeFileSync(${JSON.stringify(marker)}, "x"); pi.registerCommand("project-a-ext", { handler: async () => {} }); }\n`);
  writeFileSync(path.join(ws, "A", ".pi", "settings.json"), JSON.stringify({ defaultTools: ["bash"] }));
  writeFileSync(path.join(ws, "A", ".pi", "prompts", "proj-prompt.md"), "project prompt\n");
  writeFileSync(path.join(ws, "A", ".agents", "skills", "proj-skill", "SKILL.md"), "---\nname: proj-skill\ndescription: project skill\n---\nbody\n");
  mkdirSync(path.join(root, "sb", "agent"), { recursive: true });
  writeFileSync(path.join(root, "sb", "agent", "settings.json"), JSON.stringify({ defaultTools: ["+codemode"] }));
  const log = path.join(root, "requests.jsonl");
  const rpc = new PiRpc({ pi: pi!, cwd: ws, sandbox: path.join(root, "sb"), args: ["-e", path.join(HERE, "fixtures", "probe-model.ts"), "-e", path.join(HERE, "fixtures", "w01-contract-probe.ts")], env: { RADIAN_PROBE_LOG: log } });
  const requests = (): Request[] => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Request);
  const state = async (): Promise<ProbeState> => {
    const before = rpc.notes.length;
    await rpc.prompt("/w01-state");
    await rpc.wait(() => rpc.notes.length > before);
    return JSON.parse(rpc.notes.at(-1)!) as ProbeState;
  };
  const lastRequest = (): Request => requests().at(-1)!;
  try {
    const dash = await state();
    assert.equal(dash.selected, null);
    await rpc.prompt("hello dashboard");
    assert.ok(lastRequest().systemPrompt.includes("WORKSPACE-MARKER"));
    assert.ok(!/PROJECT-[AB]-MARKER/.test(lastRequest().systemPrompt), "the dashboard carries no project instructions");

    await rpc.command("set_thinking_level", { level: "high" });
    await rpc.prompt("/w01-select A");
    const a1 = await state();
    assert.equal(a1.selected, "A");
    assert.equal(a1.pid, dash.pid, "same Pi process");
    assert.equal(a1.processCwd, ws, "no global chdir");
    assert.equal(a1.ctxCwd, ws, "the runtime cwd stays at the workspace root");
    assert.notEqual(a1.sessionFile, dash.sessionFile, "a separate conversation");
    assert.equal(a1.thinking, "high", "the pre-switch thinking level is re-applied (a new session would reset it)");
    assert.equal(a1.evaluations, 1, "extension module evaluated once; its factory reran for the replacement runtime");
    assert.ok(a1.starts >= 2);
    const commands = ((await rpc.command("get_commands")).data as { commands: Array<{ name: string }> }).commands.map((c) => c.name);
    assert.ok(commands.includes("w01-select"));
    assert.ok(!commands.some((c) => /project-a-ext|proj-prompt|proj-skill/.test(c)), "project-local extensions, prompts, and skills are not loaded");
    assert.ok(!existsSync(marker), "no project extension code ran");

    await rpc.prompt("hello A");
    let req = lastRequest();
    assert.ok(req.systemPrompt.includes("PROJECT-A-MARKER") && !req.systemPrompt.includes("PROJECT-B-MARKER"));
    assert.ok(req.systemPrompt.includes(path.join(ws, "A")), "the prompt names the project root as the working directory");
    assert.deepEqual(req.transcript.map((t) => t.text), ["hello A"], "no dashboard history enters A");
    assert.equal(req.cwd, ws, "the model request was made with the process cwd unchanged");

    await rpc.prompt('TOOL read {"path":"a.txt"}');
    assert.match(lastRequest().transcript.at(-1)!.text, /content-of-a/, "relative reads resolve inside the selected project");
    await rpc.prompt('TOOL read {"path":"../B/b.txt"}');
    assert.match(lastRequest().transcript.at(-1)!.text, /outside the selected project/);
    assert.ok(!lastRequest().transcript.some((t) => t.text.includes("content-of-b")));
    await rpc.prompt('TOOL codemode {"code":"try { await tools.bash({command:\\"echo hi\\"}); text(\\"bash ran\\"); } catch (e) { text(\\"bash refused: \\" + e.message); }"}');
    assert.match(lastRequest().transcript.at(-1)!.text, /bash refused: .*shell blocked/, "a nested codemode call is subject to tool_call handlers");
    assert.ok((await state()).nested.includes("bash"));

    await rpc.command("set_thinking_level", { level: "low" });
    await rpc.prompt("/w01-select B");
    const b = await state();
    assert.equal(b.selected, "B");
    assert.equal(b.pid, dash.pid);
    assert.equal(b.thinking, "low");
    await rpc.prompt("hello B");
    req = lastRequest();
    assert.ok(req.systemPrompt.includes("PROJECT-B-MARKER") && !req.systemPrompt.includes("PROJECT-A-MARKER"));
    assert.deepEqual(req.transcript.map((t) => t.text), ["hello B"], "A's transcript does not enter B");

    await rpc.command("set_thinking_level", { level: "medium" });
    await rpc.prompt("/w01-select A");
    const a2 = await state();
    assert.equal(a2.sessionFile, a1.sessionFile, "returning restores A's own conversation");
    assert.equal(a2.thinking, "medium", "resume would restore A's saved level; the interface level is kept instead");
    assert.deepEqual(a2.shutdownReasons, ["new", "new", "resume"], "each switch tears down the previous extension runtime");
    await rpc.prompt("back in A");
    req = lastRequest();
    assert.ok(req.transcript.some((t) => t.text === "hello A"), "A's history is restored");
    assert.ok(!req.transcript.some((t) => t.text.includes("hello B") || t.text.includes("hello dashboard")), "no B or dashboard history in A");
    assert.ok(req.systemPrompt.includes("PROJECT-A-MARKER") && !req.systemPrompt.includes("PROJECT-B-MARKER"));
    assert.ok(!req.systemPrompt.includes("proj-skill"), "project skills are not advertised");
    assert.ok(!existsSync(marker));
  } finally {
    const code = await rpc.close();
    removeDir(root);
    assert.equal(code, 0, rpc.stderr.join("").slice(-1500));
  }
});
