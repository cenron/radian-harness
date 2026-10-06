// Project activation in the same Pi interface (W01 design, W05).
//
// A project conversation is a Pi session created with the command context's
// `newSession({ setup })`, tagged by a `radian-project-context` custom entry,
// and referenced from private workspace state. Selecting a project, returning
// to it, or returning to the dashboard replaces Pi's session (and therefore
// Radian's extension runtime) in the same process, at the workspace root:
//
//   1. Preconditions: a command context at an idle boundary with no queued
//      input; a registered, present project; a revalidated repository,
//      binding, and configuration; no other live process holding its context.
//   2. Everything is validated before calling Pi, because a failed switch is a
//      fatal error in interactive Pi.
//   3. The interface's model and thinking level are carried over and
//      re-applied in the new runtime; selection never changes them.
//   4. A cancelled or failed switch leaves the previous view; the new view is
//      published only by the new runtime after it revalidates the tag.
//
// Execution owners (project sessions with their runs) are process-wide and
// reused across switches, so background work continues and a retained run is
// never acquired twice.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { type Blocker, type Outcome, blocker, refuse, success } from "../contracts/blockers.ts";
import { loadAndResolve } from "../config/resolve.ts";
import { checkProjectBinding } from "../state/binding.ts";
import { readJsonIfExists } from "../state/fsutil.ts";
import { type IdentityProbe, type ProcessIdentity, currentIdentity, liveness, psProbe } from "../util/process-identity.ts";
import { writeFileAtomicConfined, removeFileConfined } from "../util/safe-dir.ts";
import { type Discovery, type RegisteredProject, type WorkspaceInfo, loadWorkspace } from "../workspace/discovery.ts";
import { projectPaths } from "../workspace/layout.ts";
import type { ControllerOptions, View } from "./controller.ts";
import type { HostContext, HostWritableSessionManager, PiHost } from "./pi-host.ts";
import type { ProjectSession } from "./session.ts";
import { nextGeneration, ownerKey, processRuntime } from "./workspace-runtime.ts";

export const CONTEXT_TAG = "radian-project-context";

export interface ContextTag {
  schema: 1;
  workspace: string;
  project: string;
  contextId: string;
}

export interface ContextReference {
  schema: "radian.context-reference/1";
  workspace: string;
  project: string;
  contextId: string;
  sessionFile: string;
  sessionId: string;
}

interface ViewLock {
  schema: "radian.view-lock/1";
  owner: ProcessIdentity;
  project: string;
}

function relativeIn(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function contextFile(ws: string, project: string): string {
  return path.join(projectPaths(ws, project).state, "context.json");
}

function lockFile(ws: string, project: string): string {
  return path.join(projectPaths(ws, project).state, "view-lock.json");
}

export function readContextReference(ws: WorkspaceInfo, project: string): ContextReference | undefined {
  const read = readJsonIfExists(contextFile(ws.root, project));
  if (read.state !== "ok") return undefined;
  const ref = read.value as Partial<ContextReference>;
  if (ref.schema !== "radian.context-reference/1" || ref.workspace !== ws.id || ref.project !== project || typeof ref.contextId !== "string" || typeof ref.sessionFile !== "string" || typeof ref.sessionId !== "string") return undefined;
  return ref as ContextReference;
}

function writeContextReference(ws: WorkspaceInfo, ref: ContextReference): Outcome<true> {
  const written = writeFileAtomicConfined(ws.root, relativeIn(ws.root, contextFile(ws.root, ref.project)), JSON.stringify(ref, null, 2) + "\n", { mode: 0o600, dirMode: 0o700 });
  return written.ok ? success(true) : written;
}

/** The latest Radian context tag in a session, if any. */
export function readTag(ctx: HostContext): ContextTag | undefined {
  const entries = ctx.sessionManager?.getEntries?.() ?? ctx.sessionManager?.getBranch() ?? [];
  const tag = entries.filter((e) => e.type === "custom" && e.customType === CONTEXT_TAG).at(-1);
  const data = tag?.data as Partial<ContextTag> | undefined;
  if (!data || data.schema !== 1 || typeof data.workspace !== "string" || typeof data.project !== "string" || typeof data.contextId !== "string") return undefined;
  return data as ContextTag;
}

/** A session file that Pi can resume at the workspace root without a fatal cwd error. */
function resumable(ws: WorkspaceInfo, ref: ContextReference): boolean {
  if (!path.isAbsolute(ref.sessionFile) || !existsSync(ref.sessionFile)) return false;
  try {
    const first = readFileSync(ref.sessionFile, "utf8").split("\n", 1)[0] ?? "";
    const header = JSON.parse(first) as { type?: string; id?: string; cwd?: string };
    return header.type === "session" && header.id === ref.sessionId && header.cwd === ws.root;
  } catch {
    return false;
  }
}

/** Hold a project's conversation context for this process; another live process holding it refuses. */
export function acquireViewLock(ws: WorkspaceInfo, project: string, probe: IdentityProbe = psProbe): Outcome<true> {
  const self = currentIdentity(probe);
  if (!self) return refuse("CONTEXT_LOCKED", "this process's identity cannot be verified");
  const read = readJsonIfExists(lockFile(ws.root, project));
  if (read.state === "corrupt") return refuse("CONTEXT_LOCKED", "the project's context lock is unreadable", "Inspect it; Radian does not break locks it cannot verify.");
  if (read.state === "ok") {
    const lock = read.value as Partial<ViewLock>;
    const owner = lock.owner;
    if (owner && !(owner.pid === self.pid && owner.start === self.start)) {
      const state = liveness(owner, probe);
      if (state !== "dead") return refuse("CONTEXT_LOCKED", `the project's context is open in another Pi process${state === "unknown" ? " (unverifiable)" : ""}`, "Close it there first; one Pi session holds a project's context at a time.");
    }
    if (owner && owner.pid === self.pid && owner.start === self.start) return success(true);
  }
  const record: ViewLock = { schema: "radian.view-lock/1", owner: self, project };
  const written = writeFileAtomicConfined(ws.root, relativeIn(ws.root, lockFile(ws.root, project)), JSON.stringify(record) + "\n", { mode: 0o600, dirMode: 0o700 });
  return written.ok ? success(true) : written;
}

/** Release this process's hold on a project's context (never another process's). */
export function releaseViewLock(workspaceRoot: string, project: string, probe: IdentityProbe = psProbe): void {
  const self = currentIdentity(probe);
  const read = readJsonIfExists(lockFile(workspaceRoot, project));
  if (!self || read.state !== "ok") return;
  const owner = (read.value as Partial<ViewLock>).owner;
  if (owner && owner.pid === self.pid && owner.start === self.start) removeFileConfined(workspaceRoot, relativeIn(workspaceRoot, lockFile(workspaceRoot, project)));
}

/** Project-local Pi resources that the workspace interface never loads (reported, not executed). */
export function unloadedProjectResources(projectRoot: string): string[] {
  const found: string[] = [];
  for (const rel of [".pi/extensions", ".pi/skills", ".pi/prompts", ".pi/themes", ".pi/mcp.json", ".pi/SYSTEM.md", ".pi/APPEND_SYSTEM.md", ".agents/skills"]) if (existsSync(path.join(projectRoot, rel))) found.push(rel);
  const settings = readJsonIfExists(path.join(projectRoot, ".pi", "settings.json"));
  if (settings.state === "ok") {
    const keys = Object.keys(settings.value as Record<string, unknown>).filter((k) => k !== "packages");
    const packages = (settings.value as { packages?: unknown[] }).packages ?? [];
    if (keys.length > 0 || packages.length > 1) found.push(".pi/settings.json (non-Radian settings)");
  } else if (settings.state === "corrupt") found.push(".pi/settings.json (unreadable)");
  return found;
}

export interface ActivationDeps {
  pi: PiHost;
  options: ControllerOptions;
  viewOf: () => View;
  blockerText: (b: Blocker) => string;
  probe?: IdentityProbe;
}

export function createActivation(deps: ActivationDeps) {
  const probe = deps.probe ?? psProbe;
  const text = deps.blockerText;

  /** Open (or reuse) the process-wide execution owner for a registered project, revalidating it. */
  const owner = async (ws: WorkspaceInfo, entry: RegisteredProject): Promise<Outcome<ProjectSession>> => {
    if (entry.presence !== "present") return refuse("PROJECT_UNAVAILABLE", `project ${entry.name} is ${entry.presence}`, "Restore it at its registered path or register it again.");
    const rt = processRuntime();
    const key = ownerKey(ws.root, entry.project);
    const existing = rt.owners.get(key);
    const binding = checkProjectBinding(entry.canonicalPath);
    if (!binding.ok) return binding;
    if (binding.value.project !== entry.project || binding.value.workspaceRoot !== ws.root) return refuse("IDENTITY_MISMATCH", "the project's identity changed");
    if (existing?.run) {
      // A retained run keeps its configuration snapshot: policy never changes beneath active workers.
      if (existing.repo.root !== entry.canonicalPath) return refuse("IDENTITY_MISMATCH", "the project's repository moved while its run is retained");
      return success(existing);
    }
    const opened = await deps.options.openSession(entry.canonicalPath);
    if (!opened.ok) return opened;
    if (opened.value.binding.project !== entry.project) return refuse("IDENTITY_MISMATCH", "the opened project does not match the registry");
    rt.owners.set(key, opened.value);
    return success(opened.value);
  };

  const ownerForDirect = async (cwd: string): Promise<Outcome<ProjectSession>> => {
    const opened = await deps.options.openSession(cwd);
    if (!opened.ok) return opened;
    const rt = processRuntime();
    const key = ownerKey(opened.value.binding.workspaceRoot, opened.value.binding.project);
    const existing = rt.owners.get(key);
    if (existing?.run) return success(existing);
    rt.owners.set(key, opened.value);
    return success(opened.value);
  };

  /** Re-apply the interface's model and thinking level after a Radian-initiated switch. */
  const applyCarry = async (ws: string | undefined, ctx: HostContext): Promise<void> => {
    const rt = processRuntime();
    const pending = rt.pending;
    rt.pending = undefined;
    if (!pending || pending.workspaceRoot !== ws) return;
    if (pending.thinking && deps.pi.setThinkingLevel && deps.pi.getThinkingLevel?.() !== pending.thinking) deps.pi.setThinkingLevel(pending.thinking);
    if (pending.model && deps.pi.setModel && ctx.model !== pending.model) {
      const same = (a: unknown, b: unknown) => typeof a === "object" && typeof b === "object" && a !== null && b !== null && (a as { id?: unknown; provider?: unknown }).id === (b as { id?: unknown }).id && (a as { provider?: unknown }).provider === (b as { provider?: unknown }).provider;
      if (!same(ctx.model, pending.model) && !(await deps.pi.setModel(pending.model))) ctx.ui.notify("Radian kept your selection, but Pi could not re-apply the previous model; check /model.", "warning");
    }
  };

  const resolve = async (found: Discovery, ctx: HostContext, _reason: string | undefined): Promise<View> => {
    if (found.state === "blocked") return { kind: "blocked", blocker: found.blocker, workspaceRoot: found.workspaceRoot };
    if (found.state === "unmanaged") {
      const opened = await ownerForDirect(ctx.cwd);
      if (!opened.ok) return { kind: "unmanaged" };
      return { kind: "project", project: opened.value, workspace: undefined, direct: true, generation: nextGeneration() };
    }
    if (found.state === "direct") {
      const opened = await ownerForDirect(found.project.canonicalPath);
      if (!opened.ok) return { kind: "blocked", blocker: opened.blocker, workspaceRoot: found.workspace.root };
      const locked = acquireViewLock(found.workspace, found.project.project, probe);
      if (!locked.ok) return { kind: "blocked", blocker: locked.blocker, workspaceRoot: found.workspace.root };
      return { kind: "project", project: opened.value, workspace: found.workspace, direct: true, generation: nextGeneration() };
    }
    const ws = found.workspace;
    const tag = readTag(ctx);
    await applyCarry(ws.root, ctx);
    if (!tag) return { kind: "dashboard", workspace: ws, generation: nextGeneration() };
    // A project conversation: restore only after revalidating its identity, reference, and project.
    const unavailable = (message: string, next?: string): View => ({ kind: "blocked", blocker: blocker("PROJECT_UNAVAILABLE", `this conversation belongs to project ${tag.project}, which ${message}`, next ?? "Return to the dashboard with /workspace or select another project with /projects."), workspaceRoot: ws.root });
    if (tag.workspace !== ws.id) return unavailable("belongs to another workspace");
    const entry = ws.projects.find((p) => p.project === tag.project);
    if (!entry) return unavailable("is no longer registered");
    const ref = readContextReference(ws, entry.project);
    if (!ref || ref.contextId !== tag.contextId) return unavailable("has a newer context; this one is stale");
    const opened = await owner(ws, entry);
    if (!opened.ok) return unavailable(`cannot be opened: ${opened.blocker.message}`);
    const locked = acquireViewLock(ws, entry.project, probe);
    if (!locked.ok) return { kind: "blocked", blocker: locked.blocker, workspaceRoot: ws.root };
    const sessionFile = ctx.sessionManager?.getSessionFile();
    const sessionId = ctx.sessionManager?.getSessionId();
    if (sessionFile && sessionId && (ref.sessionFile !== sessionFile || ref.sessionId !== sessionId)) {
      // The same project context reached through Pi's own resume or fork: follow it.
      writeContextReference(ws, { ...ref, sessionFile, sessionId });
    }
    return { kind: "project", project: opened.value, workspace: ws, direct: false, generation: nextGeneration(), contextId: tag.contextId };
  };

  const switchable = (ctx: HostContext): Outcome<true> => {
    if (!ctx.newSession || !ctx.switchSession) return refuse("SESSION_BUSY", "switching projects needs an interactive command context");
    if (!ctx.isIdle() || ctx.hasPendingMessages?.()) return refuse("SESSION_BUSY", "Pi is still working or has queued input", "Wait for the current turn to finish (or cancel it), then select again; queued input never moves to another project.");
    return success(true);
  };

  const carry = (ws: WorkspaceInfo, project: string | undefined, contextId: string | undefined, ctx: HostContext): void => {
    processRuntime().pending = { workspaceRoot: ws.root, project, contextId, generation: processRuntime().generation, model: ctx.model, thinking: deps.pi.getThinkingLevel?.() };
  };

  const select = async (v: View, ws: WorkspaceInfo, name: string, ctx: HostContext): Promise<string> => {
    const entry = ws.projects.find((p) => p.name === name || p.project === name || path.basename(p.canonicalPath) === name);
    if (!entry) return text(blocker("PROJECT_UNAVAILABLE", `no registered project named ${name}`, "List projects with /projects; register one with /add-project."));
    if (v.kind === "project" && v.project.binding.project === entry.project && !v.direct) return `Project ${entry.name} is already selected.`;
    if (v.kind === "project" && v.direct) return text(blocker("SESSION_BUSY", "this Pi session was started inside a project (direct entry)", "Start Pi at the workspace root to switch projects."));
    const ready = switchable(ctx);
    if (!ready.ok) return text(ready.blocker);
    const opened = await owner(ws, entry);
    if (!opened.ok) return text(opened.blocker);
    const config = loadAndResolve({ workspaceRoot: ws.root, projectRoot: entry.canonicalPath });
    if (!config.ok) return text(config.blocker);
    const locked = acquireViewLock(ws, entry.project, probe);
    if (!locked.ok) return text(locked.blocker);
    const notes = unloadedProjectResources(entry.canonicalPath);
    const notice = `Project ${entry.name} selected (same Pi session, workspace root unchanged).${notes.length ? ` Project-local Pi resources are not loaded here: ${notes.join(", ")}. Use direct entry with Pi's own trust to use them.` : ""}${opened.value.run ? " Its run and background work were retained." : ""}`;
    const ref = readContextReference(ws, entry.project);
    let result: { cancelled: boolean };
    try {
      if (ref && resumable(ws, ref)) {
        carry(ws, entry.project, ref.contextId, ctx);
        result = await ctx.switchSession!(ref.sessionFile, { withSession: async (next) => next.ui.notify(notice, "info") });
      } else {
        const contextId = `ctx_${randomUUID()}`;
        carry(ws, entry.project, contextId, ctx);
        let recorded: Outcome<true> = refuse("STATE_CORRUPT", "the project context was not recorded");
        result = await ctx.newSession!({
          setup: async (sm: HostWritableSessionManager) => {
            const tag: ContextTag = { schema: 1, workspace: ws.id, project: entry.project, contextId };
            sm.appendCustomEntry(CONTEXT_TAG, tag);
            const file = sm.getSessionFile();
            recorded = file ? writeContextReference(ws, { schema: "radian.context-reference/1", workspace: ws.id, project: entry.project, contextId, sessionFile: file, sessionId: sm.getSessionId() }) : refuse("STATE_CORRUPT", "Pi did not create a session file (is the session ephemeral?)");
          },
          withSession: async (next) => next.ui.notify(recorded.ok ? notice : text(recorded.blocker), recorded.ok ? "info" : "warning"),
        });
      }
    } catch (error) {
      processRuntime().pending = undefined;
      if (!(v.kind === "project" && v.project.binding.project === entry.project)) releaseViewLock(ws.root, entry.project, probe);
      return text(blocker("SESSION_BUSY", `Pi could not switch: ${(error as Error).message}`));
    }
    if (result.cancelled) {
      processRuntime().pending = undefined;
      releaseViewLock(ws.root, entry.project, probe);
      return "Selection cancelled; the previous view is unchanged.";
    }
    return "";
  };

  const dashboard = async (v: View, ctx: HostContext): Promise<string> => {
    if (v.kind === "project" && v.direct) return text(blocker("SESSION_BUSY", "this Pi session was started inside a project (direct entry)", "Start Pi at the workspace root for the dashboard."));
    const root = v.kind === "project" ? v.workspace?.root : v.kind === "blocked" ? v.workspaceRoot : undefined;
    if (!root) return text(blocker("WORKSPACE_BLOCKED", "no workspace dashboard is available here"));
    const loaded = loadWorkspace(root);
    if (!loaded.ok) return text(loaded.blocker);
    const ready = switchable(ctx);
    if (!ready.ok) return text(ready.blocker);
    carry(loaded.value, undefined, undefined, ctx);
    const result = await ctx.newSession!({ withSession: async (next) => next.ui.notify("Workspace dashboard. Background project work continues; /projects lists projects.", "info") });
    if (result.cancelled) {
      processRuntime().pending = undefined;
      return "Cancelled; the previous view is unchanged.";
    }
    return "";
  };

  return { resolve, select, dashboard };
}
