// Process-wide Radian state that must outlive one Pi extension runtime.
//
// Pi replaces the whole extension runtime on every session switch (W01): the
// extension factory runs again and the previous instance's contexts become
// stale. Views (what the current conversation shows and may touch) therefore
// belong to one extension instance, while execution owners (project sessions
// with their runs, leases, supervision, and coordinators) live here, keyed by
// workspace and project, and are only shut down on a real process quit.
//
// The registry is reached through a global symbol so that a re-evaluated
// module (for example after /reload) still finds the same owners.

import type { ProjectSession } from "./session.ts";

export interface PendingActivation {
  workspaceRoot: string;
  /** Target project id, or undefined for the dashboard. */
  project: string | undefined;
  contextId: string | undefined;
  generation: number;
  /** The interface's model and thinking level before the switch, re-applied after it. */
  model: unknown;
  thinking: string | undefined;
}

export interface OwnerNotice {
  workspaceRoot: string;
  project: string;
  text: string;
  level: "info" | "warning";
}

/** The view currently attached to the live Pi runtime, if any. */
export interface ActiveView {
  workspaceRoot: string | undefined;
  project: string | undefined;
  generation: number;
  notify(notice: OwnerNotice): void;
}

export interface ProcessRuntime {
  readonly schema: 1;
  /** Increments on every view activation in this process. */
  generation: number;
  owners: Map<string, ProjectSession>;
  pending: PendingActivation | undefined;
  active: ActiveView | undefined;
  /** Notices for owners whose view is not current, delivered when that project is shown again. */
  inbox: Map<string, OwnerNotice[]>;
  /** A view switch in progress in this process; overlapping switches are refused. */
  switching: boolean;
}

const KEY = Symbol.for("radian.workspace-runtime/1");

export function processRuntime(): ProcessRuntime {
  const store = globalThis as unknown as Record<symbol, ProcessRuntime | undefined>;
  let runtime = store[KEY];
  if (!runtime) {
    runtime = { schema: 1, generation: 0, owners: new Map(), pending: undefined, active: undefined, inbox: new Map(), switching: false };
    store[KEY] = runtime;
  }
  return runtime;
}

export function ownerKey(workspaceRoot: string, project: string): string {
  return `${workspaceRoot}\u0000${project}`;
}

export function nextGeneration(): number {
  const runtime = processRuntime();
  runtime.generation += 1;
  return runtime.generation;
}

/**
 * Route a background result to its owning project without placing it in
 * another project's model context: the owner's own view receives it; any
 * other view gets a payload-free notification, and the full text waits in the
 * owner's inbox.
 */
export function deliverNotice(notice: OwnerNotice): void {
  const runtime = processRuntime();
  const active = runtime.active;
  if (active && active.workspaceRoot === notice.workspaceRoot && active.project === notice.project) {
    active.notify(notice);
    return;
  }
  const key = ownerKey(notice.workspaceRoot, notice.project);
  runtime.inbox.set(key, [...(runtime.inbox.get(key) ?? []), notice].slice(-50));
  active?.notify({ ...notice, text: `A background Radian result is waiting in another project; select it with /projects to see it.`, level: "info" });
}

export function takeInbox(workspaceRoot: string, project: string): OwnerNotice[] {
  const runtime = processRuntime();
  const key = ownerKey(workspaceRoot, project);
  const notices = runtime.inbox.get(key) ?? [];
  runtime.inbox.delete(key);
  return notices;
}

/** Test seam: forget all process-wide state (fixtures only). */
export function resetProcessRuntimeForTests(): void {
  const store = globalThis as unknown as Record<symbol, ProcessRuntime | undefined>;
  delete store[KEY];
}
