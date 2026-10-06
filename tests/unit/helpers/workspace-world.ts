// Disposable workspace-first fixtures: an installer-built workspace (empty or
// with registered Git projects), a fake Pi host per extension runtime, and a
// fake session manager / command context that emulate Pi's in-process session
// replacement (new runtime per switch, per W01) without starting Pi.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { success, type Outcome } from "../../../src/contracts/blockers.ts";
import { CoordinatorLease } from "../../../src/state/lease.ts";
import { RunStore } from "../../../src/state/run-store.ts";
import { registerRadian, type RadianController } from "../../../src/ui/controller.ts";
import type { HostContext, HostRuntime, HostSessionEntry, HostWritableSessionManager } from "../../../src/ui/pi-host.ts";
import { type ProjectSession, openProjectSession } from "../../../src/ui/session.ts";
import { applyPlan, planInstall } from "../../../src/workspace/installer.ts";
import { makeRepo, tempDir } from "./fixture.ts";
import { type FakeCtxState, FakeHost, context, fakeRuntime } from "./pi-host.ts";

export const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export interface DelegateCall {
  tool: "grep" | "find";
  root: string;
  params: Record<string, unknown>;
  ctxCwd: string;
}

/** A fake host runtime whose Pi-provided pieces record how Radian used them. */
export function recordingRuntime(calls: DelegateCall[]): HostRuntime {
  const delegate = (tool: "grep" | "find") => (root: string) => ({
    execute: async (...args: unknown[]) => {
      const params = args[1] as Record<string, unknown>;
      const ctx = args[4] as { cwd: string };
      calls.push({ tool, root, params, ctxCwd: ctx.cwd });
      return { content: [{ type: "text", text: `${tool} ok` }], details: undefined };
    },
  });
  return {
    ...fakeRuntime,
    getAgentDir: () => "/nonexistent-agent-dir",
    loadProjectContextFiles: ({ cwd }) => {
      const out: Array<{ path: string; content: string }> = [];
      for (let dir = cwd; ; dir = path.dirname(dir)) {
        try {
          out.unshift({ path: path.join(dir, "AGENTS.md"), content: readFileSync(path.join(dir, "AGENTS.md"), "utf8") });
        } catch {
          // no context file here
        }
        if (path.dirname(dir) === dir) break;
      }
      return out;
    },
    createGrepToolDefinition: delegate("grep"),
    createFindToolDefinition: delegate("find"),
  };
}

/** A start-run stub over real lease/run-store services and a fake coordinator. */
export function stubStartRun(live: Array<{ assignment: string; role: "developer" }> = []) {
  return async (session: ProjectSession): Promise<Outcome<NonNullable<ProjectSession["run"]>>> => {
    if (session.run) return success(session.run);
    const lease = await CoordinatorLease.acquire(session.project.state, session.binding.project, { ttlMs: 3_600_000 });
    if (!lease.ok) return lease;
    const store = await RunStore.create(session.project.state, lease.value, { workspace: session.binding.workspace, project: session.binding.project, configHash: session.config.hash, harness: { version: "0.0.0-test", revision: "f".repeat(40), locallyModified: false } });
    if (!store.ok) return store;
    const coordinator = { liveAssignments: () => live, pause: async () => success({ termination: "verified" as const }), evidence: () => ({ checks: [], risks: [] }), stopMonitoring: () => {} };
    const supervision = { release: () => {}, dropHeartbeat: () => {}, health: () => success(true as const) };
    session.run = { store: store.value, lease: lease.value, coordinator: coordinator as never, supervision: supervision as never };
    return success(session.run);
  };
}

export async function workspaceWorld(names: string[] = []) {
  const root = tempDir("radian-ws-");
  const ws = path.join(root, "ws");
  mkdirSync(ws);
  writeFileSync(path.join(ws, "AGENTS.md"), "WORKSPACE-MARKER\n");
  const dirs: Record<string, string> = {};
  for (const name of names) {
    const dir = path.join(ws, name);
    mkdirSync(dir);
    const repo = await makeRepo(dir);
    repo.write("AGENTS.md", `PROJECT-${name.toUpperCase()}-MARKER\n`);
    repo.write(`src/${name}.txt`, `content-of-${name}\n`);
    await repo.commitAll("base");
    dirs[name] = dir;
  }
  const plan = await planInstall({ workspaceRoot: ws, source: { kind: "local", path: HARNESS }, projects: names.map((n) => ({ path: dirs[n]!, target: "refs/heads/main" })) });
  if (!plan.ok) throw new Error(plan.blocker.message);
  const applied = applyPlan(plan.value, plan.value.hash);
  if (!applied.ok) throw new Error(applied.blocker.message);
  const registry = JSON.parse(readFileSync(path.join(ws, ".radian", "state", "projects.json"), "utf8")) as { projects: Array<{ project: string; canonicalPath: string }> };
  const id = (name: string) => registry.projects.find((p) => p.canonicalPath === dirs[name])!.project;
  return { root, ws, dirs, id };
}

/** One Pi session file with entries, as Pi's session manager exposes it. */
export class FakeSession implements HostWritableSessionManager {
  readonly entries: HostSessionEntry[] = [];
  readonly id = randomUUID();
  readonly file: string;
  readonly sessionDir: string;
  readonly cwd: string;
  constructor(sessionDir: string, cwd: string) {
    this.sessionDir = sessionDir;
    this.cwd = cwd;
    mkdirSync(sessionDir, { recursive: true });
    this.file = path.join(sessionDir, `${this.id}.jsonl`);
    this.persist();
  }
  persist(): void {
    writeFileSync(this.file, [JSON.stringify({ type: "session", id: this.id, cwd: this.cwd }), ...this.entries.map((e) => JSON.stringify(e))].join("\n") + "\n");
  }
  appendCustomEntry(customType: string, data?: unknown): string {
    this.entries.push({ type: "custom", customType, data });
    this.persist();
    return `e${this.entries.length}`;
  }
  getBranch(): HostSessionEntry[] {
    return [...this.entries];
  }
  getEntries(): HostSessionEntry[] {
    return [...this.entries];
  }
  getSessionFile(): string {
    return this.file;
  }
  getSessionId(): string {
    return this.id;
  }
  getHeader(): { id: string; cwd: string } {
    return { id: this.id, cwd: this.cwd };
  }
}

/**
 * Emulates one Pi process at the workspace root: every session switch tears
 * down the current extension runtime (session_shutdown with the switch
 * reason) and loads a fresh one (new FakeHost + registerRadian), as Pi does.
 */
export class FakePiProcess {
  host!: FakeHost;
  controller!: RadianController;
  session: FakeSession;
  readonly sessions = new Map<string, FakeSession>();
  readonly state: FakeCtxState = { confirms: [], confirmAnswer: true, notes: [] };
  readonly calls: DelegateCall[] = [];
  readonly shutdownReasons: string[] = [];
  busy = false;
  pending = false;
  thinking = "medium";
  model: unknown = { provider: "fake", id: "model-1" };

  readonly cwd: string;
  readonly sessionDir: string;
  readonly options: { startRun?: ReturnType<typeof stubStartRun>; mode?: HostContext["mode"] };

  constructor(cwd: string, sessionDir: string, options: { startRun?: ReturnType<typeof stubStartRun>; mode?: HostContext["mode"] } = {}) {
    this.cwd = cwd;
    this.sessionDir = sessionDir;
    this.options = options;
    this.session = new FakeSession(sessionDir, cwd);
    this.sessions.set(this.session.file, this.session);
  }

  ctx(): HostContext {
    return context(this.cwd, this.options.mode ?? "tui", this.state, {
      isIdle: () => !this.busy,
      hasPendingMessages: () => this.pending,
      sessionManager: this.session,
      model: this.model,
      newSession: async (opts) => this.replace("new", new FakeSession(this.sessionDir, this.cwd), opts?.setup, opts?.withSession),
      switchSession: async (file, opts) => {
        const target = this.sessions.get(file);
        if (!target) throw new Error(`missing session ${file}`);
        return this.replace("resume", target, undefined, opts?.withSession);
      },
    });
  }

  async start(): Promise<void> {
    await this.load("startup");
  }

  private async load(reason: string): Promise<void> {
    this.host = new FakeHost();
    this.host.thinking = this.thinking;
    const host = this.host;
    const origSet = host.setThinkingLevel.bind(host);
    host.setThinkingLevel = (level: string) => {
      origSet(level);
      this.thinking = level;
    };
    host.setModel = async (model: unknown) => {
      this.model = model;
      return true;
    };
    this.controller = registerRadian(this.host, { loadRuntime: async () => recordingRuntime(this.calls), openSession: openProjectSession, startRun: this.options.startRun ?? stubStartRun() });
    await this.host.emit("session_start", { reason }, this.ctx());
    await this.host.emit("input", { text: "", source: "interactive" }, this.ctx());
  }

  private async replace(reason: "new" | "resume", target: FakeSession, setup?: (sm: HostWritableSessionManager) => Promise<void>, withSession?: (ctx: HostContext) => Promise<void>): Promise<{ cancelled: boolean }> {
    await this.host.emit("session_shutdown", { reason }, this.ctx());
    this.shutdownReasons.push(reason);
    // Pi resets thinking on a new session and restores the saved level on resume (W01).
    this.thinking = reason === "new" ? "medium" : "saved-level";
    this.model = { provider: "fake", id: reason === "new" ? "default-model" : "saved-model" };
    this.session = target;
    this.sessions.set(target.file, target);
    if (setup) await setup(target);
    await this.load(reason);
    if (withSession) await withSession(this.ctx());
    return { cancelled: false };
  }

  async command(name: "radian" | "projects" | "workspace", args = ""): Promise<string> {
    const ctx = this.ctx();
    if (name === "radian") return this.controller.command(args, ctx);
    if (name === "projects") return this.controller.projectsCommand(args, ctx);
    return this.controller.workspaceCommand(args, ctx);
  }

  async tool(name: string, params: Record<string, unknown>, extra: { parentToolCallId?: string } = {}) {
    return this.host.callTool(name, params, this.ctx(), extra);
  }

  async quit(): Promise<void> {
    await this.host.emit("session_shutdown", { reason: "quit" }, this.ctx());
  }
}
