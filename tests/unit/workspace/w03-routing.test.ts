// W03 — dashboard, explicit states, and project-scoped routing over fake Pi
// hosts and disposable workspaces (no Pi process, model, or worker).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { confinedAccessSupported } from "../../../src/util/confined-fs.ts";
import { deliverNotice, processRuntime } from "../../../src/ui/workspace-runtime.ts";
import { removeDir } from "../helpers/fixture.ts";
import { FakePiProcess, workspaceWorld } from "../helpers/workspace-world.ts";

const opts = { skip: confinedAccessSupported() ? false : "needs macOS O_NOFOLLOW_ANY" };

const blocked = (r: { blocked?: string }) => r.blocked ?? "";

test("an empty workspace root opens the dashboard: no project, no engineering actions, private state unreadable", opts, async () => {
  const w = await workspaceWorld();
  try {
    const pi = new FakePiProcess(w.ws, path.join(w.root, "sessions"));
    await pi.start();
    assert.equal(pi.controller.view().kind, "dashboard");
    assert.match(pi.state.status ?? "", /^WORKSPACE · no project selected/);
    assert.equal(pi.state.editorFactory, undefined, "Plan/Build is per project; the dashboard has no mode editor");
    assert.match(await pi.command("projects"), /no registered projects[\s\S]*\/new-project/);
    assert.match(await pi.command("radian", "status"), /no project selected/);
    for (const sub of ["mode build", "approve spec t .radian/planning/x.md", "task add x", "integrate t", "start"]) assert.match(await pi.command("radian", sub), /NO_PROJECT_SELECTED/, sub);
    for (const tool of ["radian_dispatch", "radian_assemble", "radian_write_artifact", "radian_git_inspect", "grep", "find"]) assert.match(blocked(await pi.tool(tool, { pattern: "x", task: "t", path: "x", content: "x", op: "status" })), /RH-NO-PROJECT/, tool);
    for (const tool of ["bash", "write", "edit", "codemode", "tool_search", "mcp__srv__x", "powershell"]) assert.ok(blocked(await pi.tool(tool, { command: "true", path: "x" })), tool);
    assert.match((await pi.tool("radian_status", {})).text ?? "", /no project selected/);
    const priv = await pi.tool("read", { path: ".radian/workspace.json" });
    assert.match(priv.error ?? "", /PATH_OUTSIDE_SCOPE/, "private workspace state is not readable");
    assert.match((await pi.tool("read", { path: "AGENTS.md" })).text ?? "", /WORKSPACE-MARKER/);
    const listing = (await pi.tool("ls", {})).text ?? "";
    assert.ok(listing.includes("AGENTS.md") && !listing.includes(".radian"), listing);
    assert.match((await pi.tool("read", { path: "../outside.txt" })).error ?? "", /PATH_OUTSIDE_SCOPE/);
    // The dashboard prompt names no project and carries the workspace instruction only.
    const event = { systemPromptOptions: { cwd: w.ws, contextFiles: [{ path: path.join(w.ws, "AGENTS.md"), content: "WORKSPACE-MARKER\n" }] } };
    await pi.host.emit("before_agent_start", event, pi.ctx());
    assert.equal(event.systemPromptOptions.cwd, w.ws);
    assert.match((event.systemPromptOptions as { sections?: Record<string, string> }).sections?.radian ?? "", /no project is selected/);
  } finally {
    removeDir(w.root);
  }
});

test("an invalid recognized workspace is blocked, never unrestricted Pi", opts, async () => {
  const w = await workspaceWorld(["alpha"]);
  try {
    const registry = path.join(w.ws, ".radian", "state", "projects.json");
    const good = readFileSync(registry, "utf8");
    writeFileSync(registry, "{ corrupt");
    const pi = new FakePiProcess(w.ws, path.join(w.root, "sessions"));
    await pi.start();
    assert.equal(pi.controller.view().kind, "blocked");
    assert.match(pi.state.status ?? "", /^BLOCKED/);
    for (const tool of ["read", "ls", "radian_status", "grep"]) assert.match(blocked(await pi.tool(tool, { path: "AGENTS.md" })), /RH-WORKSPACE-BLOCKED/, tool);
    assert.match(await pi.command("radian", "status"), /BLOCKED WORKSPACE_BLOCKED/);
    // Direct entry from inside the same (invalid) workspace is blocked too.
    const direct = new FakePiProcess(w.dirs.alpha!, path.join(w.root, "sessions-direct"));
    await direct.start();
    assert.equal(direct.controller.view().kind, "blocked");
    writeFileSync(registry, good);
    // An unregistered repository or a project subdirectory inside a valid workspace is blocked.
    mkdirSync(path.join(w.ws, "stray"));
    const stray = new FakePiProcess(path.join(w.ws, "stray"), path.join(w.root, "s3"));
    await stray.start();
    assert.equal(stray.controller.view().kind, "blocked");
    assert.match(blocked(await stray.tool("read", { path: "x" })), /RH-WORKSPACE-BLOCKED/);
    const sub = new FakePiProcess(path.join(w.dirs.alpha!, "src"), path.join(w.root, "s4"));
    await sub.start();
    assert.equal(sub.controller.view().kind, "blocked");
    // A moved workspace record is blocked as well.
    const record = path.join(w.ws, ".radian", "workspace.json");
    const json = JSON.parse(readFileSync(record, "utf8"));
    writeFileSync(record, JSON.stringify({ ...json, canonicalRoot: path.join(w.root, "elsewhere") }));
    const moved = new FakePiProcess(w.ws, path.join(w.root, "s5"));
    await moved.start();
    assert.equal(moved.controller.view().kind, "blocked");
  } finally {
    removeDir(w.root);
  }
});

test("direct project entry stays supported, with reads and searches confined to that project", opts, async () => {
  const w = await workspaceWorld(["alpha", "beta"]);
  try {
    const pi = new FakePiProcess(w.dirs.alpha!, path.join(w.root, "sessions"));
    await pi.start();
    const v = pi.controller.view();
    assert.ok(v.kind === "project" && v.direct && v.project.binding.project === w.id("alpha"));
    assert.match(pi.state.status ?? "", /^PLAN · alpha · .*workers|^PLAN · alpha/);
    assert.match((await pi.tool("read", { path: "src/alpha.txt" })).text ?? "", /content-of-alpha/);
    assert.match((await pi.tool("read", { path: path.join(w.dirs.alpha!, "AGENTS.md") })).text ?? "", /PROJECT-ALPHA-MARKER/, "absolute paths inside the project are fine");
    for (const p of ["../beta/src/beta.txt", path.join(w.dirs.beta!, "src", "beta.txt"), "../.radian/workspace.json", "/etc/hosts"]) assert.match((await pi.tool("read", { path: p })).error ?? "", /PATH_OUTSIDE_SCOPE/, p);
    // Links inside the project are never followed, for reads or searches.
    symlinkSync(w.dirs.beta!, path.join(w.dirs.alpha!, "beta-link"));
    symlinkSync(path.join(w.dirs.beta!, "src", "beta.txt"), path.join(w.dirs.alpha!, "file-link"));
    assert.match((await pi.tool("read", { path: "beta-link/src/beta.txt" })).error ?? "", /symbolic link/);
    assert.match((await pi.tool("read", { path: "file-link" })).error ?? "", /symbolic link/);
    assert.match((await pi.tool("ls", { path: "beta-link" })).error ?? "", /symbolic link/);
    assert.match((await pi.tool("ls", {})).text ?? "", /beta-link@ \(link, not followed\)/);
    assert.match((await pi.tool("grep", { pattern: "x", path: "beta-link" })).error ?? "", /symbolic link/);
    assert.equal(pi.calls.length, 0, "no search ran on a refused path");
    assert.equal((await pi.tool("grep", { pattern: "content", path: "src" })).text, "grep ok");
    assert.equal((await pi.tool("find", { pattern: "*.txt" })).text, "find ok");
    assert.deepEqual(pi.calls.map((c) => [c.tool, c.root, c.params.path, c.ctxCwd]), [
      ["grep", w.dirs.alpha!, path.join(w.dirs.alpha!, "src"), w.dirs.alpha!],
      ["find", w.dirs.alpha!, w.dirs.alpha!, w.dirs.alpha!],
    ], "Pi's search runs on the validated absolute path with a project-rooted context");
    // Project instructions come from the project root, not the workspace view.
    const event = { systemPromptOptions: { cwd: w.ws, contextFiles: [] as Array<{ path: string; content: string }> } };
    await pi.host.emit("before_agent_start", event, pi.ctx());
    assert.equal(event.systemPromptOptions.cwd, w.dirs.alpha);
    const text = event.systemPromptOptions.contextFiles.map((f) => f.content).join("");
    assert.ok(text.includes("PROJECT-ALPHA-MARKER") && !text.includes("PROJECT-BETA-MARKER"));
  } finally {
    removeDir(w.root);
  }
});

test("unknown, nested, MCP, codemode, and replaced tools are refused in every managed state", opts, async () => {
  const w = await workspaceWorld(["alpha"]);
  try {
    const pi = new FakePiProcess(w.dirs.alpha!, path.join(w.root, "sessions"));
    await pi.start();
    assert.match(blocked(await pi.tool("bash", { command: "echo hi" }, { parentToolCallId: "call-1" })), /RH-COORD-SHELL/, "a nested shell call is refused");
    assert.match(blocked(await pi.tool("write", { path: "src/x" }, { parentToolCallId: "call-1" })), /RH-COORD-PRODUCTION-WRITE/);
    for (const tool of ["codemode", "tool_search", "mcp__docs__search", "some_other_extension_tool"]) assert.match(blocked(await pi.tool(tool, {})), /RH-COORD-UNKNOWN-TOOL/, tool);
    // Another extension replaces `read` after Radian: the replacement is refused.
    pi.host.foreignTools.push({ name: "read", source: "other-extension" });
    assert.match(blocked(await pi.tool("read", { path: "src/alpha.txt" })), /no longer Radian's confined implementation/);
    assert.equal(blocked(await pi.tool("ls", {})), "", "Radian's own ls is still allowed");
  } finally {
    removeDir(w.root);
  }
});

test("a deferred A operation keeps A's identity: late writes land in A, late approvals are refused, results never enter B", opts, async () => {
  const w = await workspaceWorld(["alpha", "beta"]);
  try {
    const a = new FakePiProcess(w.dirs.alpha!, path.join(w.root, "sa"));
    await a.start();
    assert.match(await a.command("radian", "task add Synthetic"), /Task (\S+) added/);
    const task = /task (\S+):/.exec((await a.command("radian", "status")).replace(/- task/, "task"))?.[1];
    mkdirSync(path.join(w.dirs.alpha!, ".radian", "planning"), { recursive: true });
    writeFileSync(path.join(w.dirs.alpha!, ".radian", "planning", "spec.md"), "# spec\n");
    // The approval dialog stays open while another view becomes current in this process.
    let release!: (v: boolean) => void;
    a.state.confirmAnswer = true;
    const ui = a.ctx().ui;
    const ctx = { ...a.ctx(), ui: { ...ui, confirm: () => new Promise<boolean>((r) => (release = r)) } };
    const pending = a.controller.command(`approve spec ${task} .radian/planning/spec.md`, ctx);
    await new Promise((r) => setTimeout(r, 20));
    const before = processRuntime().generation;
    const b = new FakePiProcess(w.dirs.beta!, path.join(w.root, "sb"));
    await b.start();
    assert.ok(processRuntime().generation > before);
    release(true);
    assert.match(await pending, /STALE_GENERATION/, "a confirmation that outlived its view records nothing");
    const run = a.controller.session()!.run!;
    assert.equal(Object.keys(run.store.state.approvals).length, 0);
    // A's planning write after the switch still targets A only.
    const written = await a.tool("radian_write_artifact", { path: "late.md", content: "A" });
    assert.match(written.text ?? "", /project prj_/);
    assert.equal(readFileSync(path.join(w.dirs.alpha!, ".radian", "planning", "late.md"), "utf8"), "A");
    assert.throws(() => readFileSync(path.join(w.dirs.beta!, ".radian", "planning", "late.md")));
    rmSync(path.join(w.dirs.alpha!, ".radian", "planning", "late.md"));
    // A background result for A while B is current: B gets a payload-free notice, A's text waits for A.
    const bMessages = b.host.messages.length;
    deliverNotice({ workspaceRoot: w.ws, project: w.id("alpha"), text: "Assignment asg_1 completed: SECRET-A-PAYLOAD", level: "info" });
    assert.equal(b.host.messages.length, bMessages, "nothing entered B's conversation");
    assert.ok(!b.state.notes.some((n) => n.includes("SECRET-A-PAYLOAD")) && b.state.notes.some((n) => /waiting in another project/.test(n)));
    const a2 = new FakePiProcess(w.dirs.alpha!, path.join(w.root, "sa2"));
    await a2.start();
    assert.ok(a2.host.messages.some((m) => m.includes("SECRET-A-PAYLOAD")), "A's own view receives it when shown again");
  } finally {
    removeDir(w.root);
  }
});
