import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { success, type Outcome } from "../../../src/contracts/blockers.ts";
import { loadAndResolve } from "../../../src/config/resolve.ts";
import { ModeState } from "../../../src/coordinator/mode.ts";
import { openRepository } from "../../../src/git/repository.ts";
import { CoordinatorLease } from "../../../src/state/lease.ts";
import { RunStore } from "../../../src/state/run-store.ts";
import { CalmPreference } from "../../../src/ui/calm.ts";
import { RADIAN_TOOLS, registerRadian } from "../../../src/ui/controller.ts";
import { managedEditorFactory } from "../../../src/ui/editor.ts";
import { guardToolCall, readOnlyCommand } from "../../../src/ui/guard.ts";
import type { HostContext, HostRuntime, HostToolRenderers, PiHost } from "../../../src/ui/pi-host.ts";
import { openProjectSession, type ProjectSession } from "../../../src/ui/session.ts";
import { projectPaths } from "../../../src/workspace/layout.ts";
import { makeRepo, removeDir, tempDir } from "../helpers/fixture.ts";

class FakeEditor {
  received: string[] = [];
  constructor(_tui: unknown, _theme: unknown, _kb: unknown) {}
  handleInput(data: string): void {
    this.received.push(data);
  }
}

const fakeRuntime: HostRuntime = {
  CustomEditor: FakeEditor,
  matchesKey: (data, key) => data === key,
  Text: class {
    text: string;
    constructor(text: string) {
      this.text = text;
    }
  },
  Type: {
    Object: (p) => ({ type: "object", p }),
    String: () => ({ type: "string" }),
    Number: () => ({ type: "number" }),
    Boolean: () => ({ type: "boolean" }),
    Array: (i) => ({ type: "array", i }),
    Optional: (s) => s,
    Union: (s) => ({ anyOf: s }),
    Literal: (v) => ({ const: v }),
  },
};

class FakeHost implements PiHost {
  handlers = new Map<string, Array<(event: never, ctx: HostContext) => unknown>>();
  commands = new Map<string, (args: string, ctx: HostContext) => Promise<void>>();
  tools: string[] = [];
  resolvers: Array<(name: string, next: () => HostToolRenderers | undefined) => HostToolRenderers | undefined> = [];
  messages: string[] = [];
  on(event: string, handler: (event: never, ctx: HostContext) => unknown): () => void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return () => {};
  }
  registerCommand(name: string, options: { handler: (args: string, ctx: HostContext) => Promise<void> }): void {
    this.commands.set(name, options.handler);
  }
  registerTool(tool: { name: string }): void {
    this.tools.push(tool.name);
  }
  registerToolRenderer(resolver: (name: string, next: () => HostToolRenderers | undefined) => HostToolRenderers | undefined): void {
    this.resolvers.push(resolver);
  }
  sendMessage(message: { content: string }): void {
    this.messages.push(message.content);
  }
  async emit(event: string, payload: unknown, ctx: HostContext): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const handler of this.handlers.get(event) ?? []) out.push(await handler(payload as never, ctx));
    return out;
  }
}

interface FakeCtxState {
  editorFactory?: ((tui: unknown, theme: unknown, kb: unknown) => unknown) | undefined;
  status?: string | undefined;
  confirms: string[];
  confirmAnswer: boolean;
  notes: string[];
}

function context(cwd: string, mode: HostContext["mode"], state: FakeCtxState): HostContext {
  return {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd,
    isIdle: () => true,
    ui: {
      notify: (m) => state.notes.push(m),
      setStatus: (_k, t) => {
        state.status = t;
      },
      setWidget: () => {},
      confirm: async (title, message) => {
        state.confirms.push(`${title}\n${message ?? ""}`);
        return state.confirmAnswer;
      },
      select: async () => undefined,
      setEditorComponent: (f) => {
        state.editorFactory = f;
      },
      theme: { fg: (_t, s) => s, bold: (s) => s },
    },
  };
}

/** A registered synthetic workspace + project, with an injected run built from real state services. */
async function managedWorld() {
  const root = tempDir();
  const workspace = path.join(root, "ws");
  const projectDir = path.join(workspace, "proj");
  mkdirSync(path.join(workspace, ".radian", "state"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const fixture = await makeRepo(projectDir);
  fixture.write("src/a.ts", "export const a = 1;\n");
  fixture.write(".radian/planning/spec.md", "# Spec\n");
  await fixture.commitAll("base");
  writeFileSync(path.join(workspace, ".radian", "workspace.json"), JSON.stringify({ schema: "radian.workspace/1", workspace: "ws_fixture1", canonicalRoot: workspace }));
  writeFileSync(path.join(workspace, ".radian", "state", "projects.json"), JSON.stringify({ schema: "radian.workspace-registry/1", workspace: "ws_fixture1", projects: [{ project: "prj_fixture1", canonicalPath: projectDir, target: "refs/heads/main" }] }));
  const live: Array<{ assignment: string; role: "developer" }> = [];
  const paused: string[] = [];
  const startRun = async (session: ProjectSession): Promise<Outcome<NonNullable<ProjectSession["run"]>>> => {
    if (session.run) return success(session.run);
    const lease = await CoordinatorLease.acquire(session.project.state, session.binding.project, { ttlMs: 3_600_000 });
    if (!lease.ok) return lease;
    const store = await RunStore.create(session.project.state, lease.value, { workspace: session.binding.workspace, project: session.binding.project, configHash: session.config.hash, harness: { version: "0.0.0-test", revision: "f".repeat(40), locallyModified: false } });
    if (!store.ok) return store;
    const coordinator = {
      liveAssignments: () => live,
      pause: async (assignment: string) => {
        paused.push(assignment);
        return success({ termination: "verified" as const });
      },
      evidence: () => ({ checks: [], risks: [] }),
    };
    const supervision = { release: () => {}, dropHeartbeat: () => {}, health: () => success(true as const) };
    session.run = { store: store.value, lease: lease.value, coordinator: coordinator as never, supervision: supervision as never };
    return success(session.run);
  };
  return { root, workspace, projectDir, fixture, live, paused, startRun };
}

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
    assert.deepEqual([...host.tools].sort(), [...RADIAN_TOOLS].sort());
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
    assert.equal(host.tools.length, RADIAN_TOOLS.length);
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

test("coordinator guard: no production writes, narrow read-only shell, unknown tools blocked, planning artifacts allowed", async () => {
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
    assert.equal(decide("write", { path: ".radian/planning/plan.md" }).block, false);
    assert.equal(decide("write", { path: ".radian/planning/../../src/a.ts" }).rule, "RH-COORD-PRODUCTION-WRITE");
    assert.equal(decide("read", { path: "src/a.ts" }).block, false);
    assert.equal(decide("radian_status", {}).block, false);
    assert.equal(decide("bash", { command: "git status" }).block, false);
    assert.equal(decide("bash", { command: "rm -rf src" }).rule, "RH-COORD-SHELL");
    assert.equal(decide("bash", { command: "cat a > b" }).rule, "RH-COORD-SHELL");
    assert.equal(decide("codemode", { code: "x" }).rule, "RH-COORD-UNKNOWN-TOOL");
    assert.equal(decide("mcp_tool", {}).rule, "RH-COORD-UNKNOWN-TOOL");
    assert.equal(readOnlyCommand("git log --oneline -5"), true);
    assert.equal(readOnlyCommand("git commit -m x"), false);
    assert.equal(readOnlyCommand("ls $(whoami)"), false);
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
