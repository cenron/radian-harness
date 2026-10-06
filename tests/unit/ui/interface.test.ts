import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadAndResolve } from "../../../src/config/resolve.ts";
import { ModeState } from "../../../src/coordinator/mode.ts";
import { openRepository } from "../../../src/git/repository.ts";
import { CalmPreference } from "../../../src/ui/calm.ts";
import { RADIAN_TOOLS, registerRadian } from "../../../src/ui/controller.ts";
import { managedEditorFactory } from "../../../src/ui/editor.ts";
import { guardToolCall } from "../../../src/ui/guard.ts";
import { READ_TOOL_NAMES } from "../../../src/ui/read-tools.ts";
import type { HostToolRenderers } from "../../../src/ui/pi-host.ts";
import { openProjectSession } from "../../../src/ui/session.ts";
import { projectPaths } from "../../../src/workspace/layout.ts";
import { removeDir, tempDir } from "../helpers/fixture.ts";
import { type FakeCtxState, FakeEditor, FakeHost, context, fakeRuntime, managedWorld } from "../helpers/pi-host.ts";

test("unmanaged projects leave Pi untouched: no tools, editor, guards, or blocking", async () => {
  const dir = tempDir();
  try {
    const host = new FakeHost();
    registerRadian(host, { loadRuntime: async () => fakeRuntime, openSession: openProjectSession, startRun: async () => ({ ok: false, blocker: { code: "INSTALL_TARGET_INVALID", message: "x" } }) });
    const state: FakeCtxState = { confirms: [], confirmAnswer: true, notes: [] };
    const ctx = context(dir, "tui", state);
    await host.emit("session_start", {}, ctx);
    assert.deepEqual(host.tools, []);
    assert.equal(state.editorFactory, undefined);
    const results = await host.emit("tool_call", { toolName: "write", input: { path: "x" } }, ctx);
    assert.deepEqual(results, [undefined]);
  } finally {
    removeDir(dir);
  }
});

test("managed session: starts in PLAN, Shift+Tab toggles mode, Tab and other keys pass through, shutdown restores the editor", async () => {
  const w = await managedWorld();
  try {
    const host = new FakeHost();
    const controller = registerRadian(host, { loadRuntime: async () => fakeRuntime, openSession: openProjectSession, startRun: w.startRun });
    const state: FakeCtxState = { confirms: [], confirmAnswer: true, notes: [] };
    const ctx = context(w.projectDir, "tui", state);
    await host.emit("session_start", {}, ctx);
    assert.deepEqual([...host.tools].sort(), [...RADIAN_TOOLS, ...READ_TOOL_NAMES].sort(), "Radian's tools plus its confined read/ls/grep/find overrides");
    assert.ok(!host.tools.some((t) => /approv|integrat|decide|grant|recover/.test(t)), "no model-callable approval or integration writer");
    assert.equal(controller.session()?.mode.mode, "plan");
    assert.match(state.status ?? "", /^PLAN/);
    const editor = state.editorFactory!(null, null, null) as FakeEditor;
    editor.handleInput("tab");
    editor.handleInput("x");
    assert.deepEqual(editor.received, ["tab", "x"], "Tab (autocomplete) and typing reach Pi's editor");
    editor.handleInput("shift+tab");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(controller.session()?.mode.mode, "build");
    assert.ok(!editor.received.includes("shift+tab"), "Shift+Tab is consumed only in managed sessions");
    assert.match(state.status ?? "", /^BUILD/);
    // Reload: a second session_start re-installs without duplicate tools.
    await host.emit("session_start", {}, ctx);
    assert.equal(host.tools.length, RADIAN_TOOLS.length + READ_TOOL_NAMES.length);
    await host.emit("session_shutdown", {}, ctx);
    assert.equal(state.editorFactory, undefined, "default editor restored");
    assert.equal(state.status, undefined);
  } finally {
    removeDir(w.root);
  }
});

test("approvals are human-only: refused without an interactive terminal, from RPC input, or when declined", async () => {
  const w = await managedWorld();
  try {
    const host = new FakeHost();
    const controller = registerRadian(host, { loadRuntime: async () => fakeRuntime, openSession: openProjectSession, startRun: w.startRun });
    const state: FakeCtxState = { confirms: [], confirmAnswer: true, notes: [] };
    const tui = context(w.projectDir, "tui", state);
    await host.emit("session_start", {}, tui);
    const added = await controller.command("task add Synthetic task", tui);
    const task = /Task (\S+) added/.exec(added)?.[1];
    assert.ok(task, added);
    const approve = `approve spec ${task} .radian/planning/spec.md`;
    assert.match(await controller.command(approve, context(w.projectDir, "print", state)), /NONINTERACTIVE_APPROVAL_REQUIRED/);
    assert.match(await controller.command(approve, context(w.projectDir, "json", state)), /NONINTERACTIVE_APPROVAL_REQUIRED/);
    await host.emit("input", { text: "/radian approve", source: "rpc" }, tui);
    assert.match(await controller.command(approve, tui), /APPROVAL_NOT_HUMAN/);
    await host.emit("input", { text: "/radian approve", source: "interactive" }, tui);
    state.confirmAnswer = false;
    assert.match(await controller.command(approve, tui), /APPROVAL_MISSING/);
    state.confirmAnswer = true;
    assert.match(await controller.command(approve, tui), /spec approved/);
    assert.match(state.confirms.at(-1) ?? "", /content [0-9a-f]{12}/, "the user saw the exact artifact hash");
    const store = controller.session()!.run!.store;
    const approval = Object.values(store.state.approvals).at(-1)!;
    assert.equal(approval.actor.kind, "human");
    assert.equal(approval.channel, "user-ui");
    assert.match(await controller.command(`approve spec ${task} ../outside.md`, tui), /PATH_INVALID/);
  } finally {
    removeDir(w.root);
  }
});

test("returning to Plan blocks new dispatch immediately and asks before pausing live workers; noninteractive preserves them", async () => {
  const w = await managedWorld();
  try {
    const host = new FakeHost();
    const controller = registerRadian(host, { loadRuntime: async () => fakeRuntime, openSession: openProjectSession, startRun: w.startRun });
    const state: FakeCtxState = { confirms: [], confirmAnswer: false, notes: [] };
    const tui = context(w.projectDir, "tui", state);
    await host.emit("session_start", {}, tui);
    await controller.command("start", tui);
    await controller.command("mode build", tui);
    w.live.push({ assignment: "asg_fixture-live1", role: "developer" });
    const declined = await controller.command("mode plan", tui);
    assert.match(declined, /still running/);
    assert.equal(controller.session()?.mode.mode, "plan");
    assert.equal(w.paused.length, 0);
    await controller.command("mode build", tui);
    const noninteractive = await controller.command("mode plan", context(w.projectDir, "print", state));
    assert.match(noninteractive, /still running/);
    assert.equal(w.paused.length, 0, "no fabricated confirmation in noninteractive mode");
    await controller.command("mode build", tui);
    state.confirmAnswer = true;
    const accepted = await controller.command("mode plan", tui);
    assert.match(accepted, /Paused 1 worker/);
    assert.deepEqual(w.paused, ["asg_fixture-live1"]);
  } finally {
    removeDir(w.root);
  }
});

test("Calm is presentation-only: collapses routine successful output, never errors, partial output, or expanded views", async () => {
  const w = await managedWorld();
  try {
    const host = new FakeHost();
    const controller = registerRadian(host, { loadRuntime: async () => fakeRuntime, openSession: openProjectSession, startRun: w.startRun });
    const state: FakeCtxState = { confirms: [], confirmAnswer: true, notes: [] };
    const tui = context(w.projectDir, "tui", state);
    await host.emit("session_start", {}, tui);
    const base: HostToolRenderers = { renderCall: () => "CALL", renderResult: () => "FULL OUTPUT" };
    const resolve = () => host.resolvers[0]!("bash", () => base)!;
    const theme = { fg: (_t: string, s: string) => s, bold: (s: string) => s };
    assert.equal(resolve().renderResult!({ content: [] }, { expanded: false }, theme, {}), "FULL OUTPUT", "calm off by default");
    await controller.command("calm on", tui);
    const calm = resolve();
    assert.equal(calm.renderCall, base.renderCall, "tool calls stay visible and unchanged");
    const hidden = calm.renderResult!({ content: [] }, { expanded: false }, theme, {}) as { text: string };
    assert.match(hidden.text, /hidden by \/calm/);
    assert.equal(calm.renderResult!({ content: [], isError: true }, { expanded: false }, theme, {}), "FULL OUTPUT");
    assert.equal(calm.renderResult!({ content: [] }, { expanded: true }, theme, {}), "FULL OUTPUT");
    assert.equal(calm.renderResult!({ content: [] }, { expanded: false, isPartial: true }, theme, {}), "FULL OUTPUT");
    await controller.command("calm off", tui);
    assert.equal(resolve().renderResult!({ content: [] }, { expanded: false }, theme, {}), "FULL OUTPUT", "fully reversible");
    assert.ok(new CalmPreference(projectPaths(w.workspace, "prj_fixture1").state, false).enabled === false);
  } finally {
    removeDir(w.root);
  }
});

test("coordinator guard: no production writes, no shell, unknown tools blocked, planning drafts only through radian_write_artifact", async () => {
  const w = await managedWorld();
  try {
    const repo = await openRepository(w.projectDir);
    assert.ok(repo.ok);
    if (!repo.ok) return;
    const planning = path.join(repo.value.root, ".radian", "planning");
    const options = { projectRoot: repo.value.root, planningRoots: [planning], radianTools: new Set(RADIAN_TOOLS) };
    const decide = (toolName: string, input: Record<string, unknown>) => guardToolCall({ toolName, input }, options, repo.value.root);
    assert.equal(decide("write", { path: "src/a.ts" }).rule, "RH-COORD-PRODUCTION-WRITE");
    assert.equal(decide("edit", { path: path.join(repo.value.root, "src", "a.ts") }).rule, "RH-COORD-PRODUCTION-WRITE");
    assert.equal(decide("write", { path: ".radian/planning/plan.md" }).rule, "RH-COORD-PATH", "planning drafts go through radian_write_artifact (R02)");
    assert.equal(decide("radian_write_artifact", { path: "plan.md", content: "x" }).block, false);
    assert.equal(decide("write", { path: ".radian/planning/../../src/a.ts" }).rule, "RH-COORD-PRODUCTION-WRITE");
    assert.equal(decide("read", { path: "src/a.ts" }).block, false);
    assert.equal(decide("radian_status", {}).block, false);
    assert.equal(decide("bash", { command: "git status" }).rule, "RH-COORD-SHELL", "shell is not a coordinator path (R01); use radian_git_inspect");
    assert.equal(decide("radian_git_inspect", { op: "status" }).block, false);
    assert.equal(decide("bash", { command: "rm -rf src" }).rule, "RH-COORD-SHELL");
    assert.equal(decide("bash", { command: "cat a > b" }).rule, "RH-COORD-SHELL");
    assert.equal(decide("codemode", { code: "x" }).rule, "RH-COORD-UNKNOWN-TOOL");
    assert.equal(decide("mcp_tool", {}).rule, "RH-COORD-UNKNOWN-TOOL");
    assert.equal(decide("bash", { command: "git log --oneline -5" }).rule, "RH-COORD-SHELL");
    assert.equal(decide("bash", { command: "ls $(whoami)" }).rule, "RH-COORD-SHELL");
  } finally {
    removeDir(w.root);
  }
});

test("managed editor factory uses Pi's CustomEditor base and only claims Shift+Tab", () => {
  let toggles = 0;
  const factory = managedEditorFactory(fakeRuntime, () => (toggles += 1));
  const editor = factory(null, null, null) as FakeEditor;
  assert.ok(editor instanceof FakeEditor);
  for (const key of ["shift+tab", "tab", "escape", "ctrl+t"]) editor.handleInput(key);
  assert.equal(toggles, 1);
  assert.deepEqual(editor.received, ["tab", "escape", "ctrl+t"]);
});

test("mode state defaults to Plan when missing or unreadable", () => {
  const dir = tempDir();
  try {
    const mode = new ModeState(dir);
    assert.equal(mode.mode, "plan");
    writeFileSync(path.join(dir, "mode.json"), "{ corrupt");
    assert.equal(mode.mode, "plan");
    mode.set("build");
    assert.equal(mode.mode, "build");
    assert.ok(loadAndResolve({}).ok);
  } finally {
    removeDir(dir);
  }
});
