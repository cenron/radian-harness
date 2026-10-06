// Fake Pi host fixtures for coordinator-interface tests: a structural PiHost
// that records handlers, commands, and tool definitions, a fake extension
// context, and a registered synthetic workspace/project with an injected run.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { success, type Outcome } from "../../../src/contracts/blockers.ts";
import { CoordinatorLease } from "../../../src/state/lease.ts";
import { RunStore } from "../../../src/state/run-store.ts";
import type { HostContext, HostRuntime, HostToolDefinition, HostToolRenderers, PiHost } from "../../../src/ui/pi-host.ts";
import type { ProjectSession } from "../../../src/ui/session.ts";
import { makeRepo, tempDir } from "./fixture.ts";

export class FakeEditor {
  received: string[] = [];
  constructor(_tui: unknown, _theme: unknown, _kb: unknown) {}
  handleInput(data: string): void {
    this.received.push(data);
  }
}

export const fakeRuntime: HostRuntime = {
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

export class FakeHost implements PiHost {
  handlers = new Map<string, Array<(event: never, ctx: HostContext) => unknown>>();
  commands = new Map<string, (args: string, ctx: HostContext) => Promise<void>>();
  tools: string[] = [];
  definitions = new Map<string, HostToolDefinition>();
  resolvers: Array<(name: string, next: () => HostToolRenderers | undefined) => HostToolRenderers | undefined> = [];
  messages: string[] = [];
  on(event: string, handler: (event: never, ctx: HostContext) => unknown): () => void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return () => {};
  }
  registerCommand(name: string, options: { handler: (args: string, ctx: HostContext) => Promise<void> }): void {
    this.commands.set(name, options.handler);
  }
  registerTool(tool: HostToolDefinition): void {
    this.tools.push(tool.name);
    this.definitions.set(tool.name, tool);
  }
  /** Execute a registered tool the way Pi does after the tool_call handlers allowed it. */
  async callTool(name: string, params: Record<string, unknown>, ctx: HostContext): Promise<{ blocked?: string; text?: string; error?: string }> {
    const results = await this.emit("tool_call", { toolName: name, input: params }, ctx);
    const blocked = results.find((r): r is { block: true; reason: string } => typeof r === "object" && r !== null && (r as { block?: boolean }).block === true);
    if (blocked) return { blocked: blocked.reason };
    const tool = this.definitions.get(name);
    if (!tool) return { error: `tool ${name} is not registered` };
    try {
      const out = await tool.execute("call-1", params, undefined, undefined, ctx);
      return { text: out.content.map((c) => c.text).join("\n") };
    } catch (error) {
      return { error: (error as Error).message };
    }
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

export interface FakeCtxState {
  editorFactory?: ((tui: unknown, theme: unknown, kb: unknown) => unknown) | undefined;
  status?: string | undefined;
  confirms: string[];
  confirmAnswer: boolean;
  notes: string[];
}

export function context(cwd: string, mode: HostContext["mode"], state: FakeCtxState): HostContext {
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
export async function managedWorld() {
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
