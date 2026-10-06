// Synthetic coordinator world for orchestration tests: a disposable project
// repository, real run store, lease, capacity ledger, and worktree manager, with
// a scripted fake worker driver. Fake success is never support evidence.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { success, type Outcome } from "../../../src/contracts/blockers.ts";
import type { Role } from "../../../src/contracts/identity.ts";
import { loadAndResolve, resolveConfig } from "../../../src/config/resolve.ts";
import type { ConfigSnapshot } from "../../../src/config/resolve.ts";
import type { CheckExecution, DriverLaunch, SettledOutcome, WorkerDriver, WorkerHandle, WorkerLaunchRequest } from "../../../src/coordinator/driver.ts";
import { MetricsRecorder } from "../../../src/coordinator/metrics.ts";
import { ModeState } from "../../../src/coordinator/mode.ts";
import { Coordinator, type AssignmentPlan } from "../../../src/coordinator/orchestrator.ts";
import { openRepository } from "../../../src/git/repository.ts";
import { WorktreeManager } from "../../../src/git/worktrees.ts";
import { HumanChannel } from "../../../src/state/approvals.ts";
import { CapacityLedger } from "../../../src/state/capacity.ts";
import { CoordinatorLease } from "../../../src/state/lease.ts";
import { RunStore } from "../../../src/state/run-store.ts";
import { systemClock } from "../../../src/util/clock.ts";
import { CalmPreference } from "../../../src/ui/calm.ts";
import { registerRadian } from "../../../src/ui/controller.ts";
import { type ProjectSession, artifactHash } from "../../../src/ui/session.ts";
import { makeRepo, tempDir } from "./fixture.ts";
import { type FakeCtxState, FakeHost, context, fakeRuntime } from "./pi-host.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKERS = path.resolve(HERE, "../../../workers");
export const human = () => HumanChannel.fromUserInput("user-command", "fixture-user", "/radian approve");

export type Behaviour = {
  bind?: "ok" | "fail";
  settle?: "success" | "quota" | "timeout";
  termination?: "verified" | "unknown";
  edit?: Record<string, string>;
  outcome?: "completed" | "blocked";
  question?: string;
  checks?: Array<{ id: string; outcome: "passed" | "failed"; exitCode?: number | null | "omit"; argv?: string[] }>;
  /** Restore edited files to their previous content before reporting (mutate-then-restore). */
  restore?: boolean;
  /** Candidate revision the result claims its checks ran against (default: the brief's candidate). */
  claimCandidate?: string;
  /**
   * Launcher execution records for approved checks (the evidence). Default: one
   * record per approved check, exit 0 unless the scripted claim says failed.
   */
  executed?: Array<{ id: string; exitCode: number | null; timedOut?: boolean }>;
  /** Hold the launch (as if preflight/projection were still awaiting) until this resolves. */
  launchGate?: Promise<void>;
  /** Runs when the attempt is stopped (before stop returns). */
  onStop?: () => unknown;
  /** Hold binding / settlement (a long startup or execution) until resolved or the wait is aborted. */
  holdBinding?: Promise<void>;
  holdSettle?: Promise<void>;
  /** Launch result: refused before anything started, or possibly started (uncertain delivery). */
  launchResult?: "refused" | "uncertain";
  findings?: Array<{ severity: "blocker" | "minor"; summary: string }>;
  staleGeneration?: boolean;
};

/** Wait for a hold to open; false if the wait was aborted first. */
async function held(hold: Promise<void>, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return false;
  const aborted = new Promise<false>((resolve) => signal?.addEventListener("abort", () => resolve(false), { once: true }));
  return Promise.race([hold.then(() => true as const), aborted]);
}

export class FakeDriver implements WorkerDriver {
  queue: Partial<Record<Role, Behaviour[]>> = {};
  launches: WorkerLaunchRequest[] = [];
  /** Launches that passed the last-boundary authorization, i.e. where work would have started. */
  started: WorkerLaunchRequest[] = [];
  private current = new Map<string, { request: WorkerLaunchRequest; behaviour: Behaviour }>();

  script(role: Role, ...behaviours: Behaviour[]): void {
    this.queue[role] = [...(this.queue[role] ?? []), ...behaviours];
  }

  stops: string[] = [];

  async launch(request: WorkerLaunchRequest): Promise<DriverLaunch> {
    this.launches.push(request);
    const behaviour = this.queue[request.identity.role]?.shift() ?? {};
    this.current.set(request.identity.attempt, { request, behaviour });
    if (behaviour.launchGate) await behaviour.launchGate;
    // Mirrors the production session: the launch authorization is rechecked at the last boundary before delivery.
    const authorized = request.authorize?.();
    if (authorized && !authorized.ok) return { kind: "refused", blocker: authorized.blocker };
    if (behaviour.launchResult === "refused") return { kind: "refused", blocker: { code: "CAPABILITY_UNVERIFIED", message: "synthetic preflight refusal" } };
    this.started.push(request);
    const handle: WorkerHandle = { identity: request.identity, authority: request.authority, resultFile: path.join(request.authority.outputDir, "result.json"), internal: request.identity.attempt };
    if (behaviour.launchResult === "uncertain") return { kind: "uncertain", handle, blocker: { code: "TRANSPORT_FAILURE", message: "synthetic delivery error" } };
    return { kind: "launched", handle };
  }

  async awaitBinding(handle: WorkerHandle, _deadlineMs?: number, signal?: AbortSignal): Promise<Outcome<true>> {
    const { behaviour } = this.current.get(handle.internal as string)!;
    if (behaviour.holdBinding && !(await held(behaviour.holdBinding, signal))) return { ok: false, blocker: { code: "BINDING_UNCONFIRMED", message: "wait aborted" } };
    return behaviour.bind === "fail" ? { ok: false, blocker: { code: "BINDING_UNCONFIRMED", message: "synthetic crash before binding" } } : success(true);
  }

  async awaitSettled(handle: WorkerHandle, _deadlineMs?: number, signal?: AbortSignal): Promise<SettledOutcome> {
    const { request, behaviour } = this.current.get(handle.internal as string)!;
    if (behaviour.holdSettle && !(await held(behaviour.holdSettle, signal))) return { kind: "timeout" };
    if (behaviour.settle === "timeout") return { kind: "timeout" };
    if (behaviour.settle === "quota") return { kind: "settled", outcome: "error", error: { class: "quota", summary: "synthetic usage limit" } };
    const previous = new Map<string, string | undefined>();
    for (const [file, content] of Object.entries(behaviour.edit ?? {})) {
      const target = path.join(request.authority.worktree, file);
      previous.set(target, existsSync(target) ? readFileSync(target, "utf8") : undefined);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    if (behaviour.restore) {
      for (const [target, content] of previous) {
        if (content === undefined) rmSync(target, { force: true });
        else writeFileSync(target, content);
      }
    }
    const candidate = behaviour.claimCandidate ?? request.brief.brief.base.candidate;
    const identity = behaviour.staleGeneration ? { ...request.identity, generation: request.identity.generation + 5 } : request.identity;
    const result = {
      schema: "radian.result/1",
      identity,
      briefHash: request.brief.hash,
      outcome: behaviour.outcome ?? "completed",
      summary: "synthetic worker result",
      deliverables: [],
      checks: (behaviour.checks ?? []).map((c) => {
        const exitCode = c.exitCode === undefined ? (c.outcome === "passed" ? 0 : 1) : c.exitCode;
        return { id: c.id, outcome: c.outcome, candidate, ...(exitCode === "omit" ? {} : { exitCode }), ...(c.argv ? { argv: c.argv } : {}) };
      }),
      findings: behaviour.findings ?? [],
      unmetCriteria: [],
      risks: [],
      decisionRequests: behaviour.question ? [{ question: behaviour.question }] : [],
      handoff: { dirty: Object.keys(behaviour.edit ?? {}).length > 0, incomplete: [], runningServices: [], ownedResources: [] },
      usage: { status: "unknown" },
      modelAttestation: "unverified",
    };
    writeFileSync(path.join(request.authority.outputDir, "result.json"), JSON.stringify(result));
    return { kind: "settled", outcome: "success" };
  }

  async stop(handle: WorkerHandle): Promise<{ termination: "verified" | "unknown" }> {
    const { behaviour } = this.current.get(handle.internal as string)!;
    this.stops.push(handle.identity.attempt);
    await behaviour.onStop?.();
    return { termination: behaviour.termination ?? "verified" };
  }

  checkExecutions(handle: WorkerHandle): CheckExecution[] {
    const { request, behaviour } = this.current.get(handle.internal as string)!;
    const runs = request.checks?.runs ?? [];
    const executed: NonNullable<Behaviour["executed"]> = behaviour.executed ?? runs.map((r) => ({ id: r.id, exitCode: behaviour.checks?.find((c) => c.id === r.id)?.outcome === "failed" ? 1 : 0 }));
    return executed.map((e) => ({ id: e.id, exitCode: e.exitCode, signal: null, timedOut: e.timedOut ?? false }));
  }
}

export async function world() {
  const root = tempDir();
  const projectDir = path.join(root, "project");
  mkdirSync(projectDir);
  const fixture = await makeRepo(projectDir);
  fixture.write("src/a.ts", "export const a = 1;\n");
  fixture.write("tests/a.test.ts", "// test\n");
  fixture.write("docs/spec.md", "# Spec\nSynthetic behavior.\n");
  fixture.write("docs/plan.md", "# Plan\nSynthetic plan.\n");
  const base = await fixture.commitAll("base");
  const repo = await openRepository(projectDir);
  if (!repo.ok) throw new Error("repo");
  const stateDir = path.join(root, "project-state");
  const workspaceState = path.join(root, "workspace-state");
  for (const d of [stateDir, workspaceState]) mkdirSync(d, { recursive: true });
  const shipped = loadAndResolve({});
  if (!shipped.ok) throw new Error("config");
  const snapshot = resolveConfig([
    { layer: "shipped", label: "shipped", harness: shipped.value.harness, dispatch: shipped.value.dispatch },
    { layer: "project", label: "project", dispatch: { default: "codex", profiles: { codex: { model: "gpt-test-1" } } } },
  ]);
  if (!snapshot.ok) throw new Error(snapshot.blocker.message);
  const lease = await CoordinatorLease.acquire(stateDir, "prj_fixture1", { ttlMs: 3_600_000 });
  if (!lease.ok) throw new Error("lease");
  const store = await RunStore.create(stateDir, lease.value, { workspace: "ws_fixture1", project: "prj_fixture1", configHash: snapshot.value.hash, harness: { version: "0.0.0-test", revision: "f".repeat(40), locallyModified: false } });
  if (!store.ok) throw new Error("store");
  const driver = new FakeDriver();
  const mode = new ModeState(stateDir);
  const metrics = new MetricsRecorder(stateDir, { provenance: store.value.state.run.harness, configHash: snapshot.value.hash, run: store.value.state.run.id });
  const capacity = new CapacityLedger(workspaceState);
  const coordinator = new Coordinator({
    store: store.value,
    repo: repo.value,
    worktrees: new WorktreeManager(repo.value, stateDir, path.join(root, "worktrees")),
    capacity,
    capacityCeiling: 3,
    driver,
    mode,
    metrics,
    config: snapshot.value as ConfigSnapshot,
    target: { ref: "refs/heads/main" },
    commitIdentity: { name: "Radian Fixture", email: "radian@example.com" },
    paths: { stateDir, exchangeRoot: path.join(root, "exchange"), scratchRoot: path.join(root, "scratch") },
    workspace: "ws_fixture1",
    project: "prj_fixture1",
    clock: systemClock,
    // The production hasher: confined, link-refusing reads (R02).
    artifactHash: (relative) => artifactHash(projectDir, relative),
    roleGuide: (role) => readFileSync(path.join(WORKERS, `${role}.md`), "utf8"),
    credentialSourceFor: () => ({ runtime: "codex", provider: "openai", describe: "unused by fake driver", read: async () => ({ ok: false, blocker: { code: "CREDENTIAL_UNAVAILABLE", message: "fake" } }) }),
    supervisionHealthy: () => success(true as const),
    startupMs: 10_000,
  });
  const taskId = "task_fixture-1";
  await store.value.addTask("Synthetic task", 3, taskId);
  const spec = coordinator.deps.artifactHash("docs/spec.md")!;
  const plan = coordinator.deps.artifactHash("docs/plan.md")!;
  await store.value.recordApproval(human(), { kind: "spec", task: taskId, artifact: { path: "docs/spec.md", hash: spec }, decision: "approved" });
  await store.value.recordApproval(human(), { kind: "plan", task: taskId, artifact: { path: "docs/plan.md", hash: plan }, decision: "approved" });
  mode.set("build");
  return { root, fixture, repo: repo.value, base, store: store.value, lease: lease.value, stateDir, driver, mode, metrics, capacity, coordinator, taskId, artifacts: { spec, plan } };
}

export type World = Awaited<ReturnType<typeof world>>;

export function plan(w: World, role: Role, overrides: Partial<AssignmentPlan> = {}): AssignmentPlan {
  const modifying = role === "developer" || role === "tester";
  return {
    task: w.taskId,
    role,
    purpose: "assignment",
    objective: `Synthetic ${role} objective`,
    acceptanceCriteria: ["synthetic criterion"],
    writeRoots: role === "developer" ? ["src"] : role === "tester" ? ["tests"] : [],
    operations: modifying ? ["read", "edit", "shell", "run-checks", "deliver-changes", "write-report"] : role === "reviewer" ? ["read", "git-inspect", "write-report"] : ["read", "write-report"],
    selection: {},
    newCandidateRound: role === "developer",
    base: { kind: "target" },
    artifacts: w.artifacts,
    ...overrides,
  };
}

export async function candidateRound(w: World, devBase: { kind: "target" } | { kind: "commit"; commit: string }, newRound = true) {
  w.driver.script("developer", { edit: { "src/a.ts": `export const a = ${Math.random()};\n` } });
  const dev = await w.coordinator.runAssignment(plan(w, "developer", { base: devBase, newCandidateRound: newRound }));
  assert.equal(dev.state, "completed", JSON.stringify(dev));
  w.driver.script("tester", { edit: { "tests/a.test.ts": "// acceptance\n" } });
  const tester = await w.coordinator.runAssignment(plan(w, "tester", { base: devBase }));
  assert.equal(tester.state, "completed", JSON.stringify(tester));
  if (dev.state !== "completed" || tester.state !== "completed") throw new Error("round");
  const mergeBase = devBase.kind === "target" ? w.base : devBase.commit;
  const candidate = await w.coordinator.assemble(w.taskId, [dev.delivery!, tester.delivery!], mergeBase);
  assert.ok(candidate.ok, candidate.ok ? "" : candidate.blocker.message);
  if (!candidate.ok) throw new Error("candidate");
  return candidate.value;
}

export async function checkAndReview(w: World, candidate: { commit: string }, review: Behaviour) {
  w.driver.script("tester", { checks: [{ id: "unit", outcome: "passed" }] });
  const check = await w.coordinator.runAssignment(plan(w, "tester", { purpose: "candidate-check", base: { kind: "commit", commit: candidate.commit }, writeRoots: [], requiredChecks: [{ id: "unit", description: "unit tests", argv: ["npm", "test"] }] }));
  assert.equal(check.state, "completed", JSON.stringify(check));
  w.driver.script("reviewer", review);
  const reviewOutcome = await w.coordinator.runAssignment(plan(w, "reviewer", { base: { kind: "commit", commit: candidate.commit } }));
  assert.equal(reviewOutcome.state, "completed");
  if (reviewOutcome.state === "completed") w.coordinator.recordReview(w.taskId, candidate.commit, reviewOutcome.result);
}

/**
 * Drive a real Coordinator through Radian's registered Pi tools and commands
 * (the production model-callable path), over a fabricated managed session.
 */
export async function controllerOver(w: World) {
  const host = new FakeHost();
  const supervision = { release: () => {}, dropHeartbeat: () => {}, health: () => success(true as const) };
  const run = { store: w.store, lease: w.lease, coordinator: w.coordinator, supervision };
  const session = {
    binding: { workspace: "ws_fixture1", project: "prj_fixture1", workspaceRoot: w.root },
    workspace: {},
    project: { state: w.stateDir },
    repo: w.repo,
    config: w.coordinator.deps.config,
    mode: w.mode,
    calm: new CalmPreference(w.stateDir, false),
    planningRoots: [path.join(w.repo.root, ".radian", "planning")],
    target: { ref: "refs/heads/main" },
    run,
  } as unknown as ProjectSession;
  const controller = registerRadian(host, { loadRuntime: async () => fakeRuntime, openSession: async () => success(session), startRun: async () => success(session.run!) });
  const state: FakeCtxState = { confirms: [], confirmAnswer: true, notes: [] };
  const ctx = context(w.repo.root, "tui", state);
  await host.emit("session_start", {}, ctx);
  await host.emit("input", { text: "/radian", source: "interactive" }, ctx);
  const base = { task: w.taskId, objective: "Synthetic objective", planPath: "docs/plan.md", specPath: "docs/spec.md" };
  /** Dispatch through radian_dispatch and wait for the reported outcome. */
  const dispatch = async (params: Record<string, unknown>): Promise<{ text: string; assignment?: string }> => {
    const before = host.messages.length;
    const requested = await host.callTool("radian_dispatch", { ...base, ...params }, ctx);
    if (requested.text?.startsWith("BLOCKED")) return { text: requested.text };
    assert.ok(requested.text?.startsWith("Dispatch requested"), JSON.stringify(requested));
    const deadline = Date.now() + 20_000;
    while (host.messages.length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    const text = host.messages.at(-1) ?? "(no outcome)";
    const assignment = /Assignment (asg_\S+)/.exec(text)?.[1];
    return assignment ? { text, assignment } : { text };
  };
  const assemble = async (assignments: string[], mergeBase: string) => host.callTool("radian_assemble", { task: w.taskId, assignments, mergeBase }, ctx);
  return { host, controller, ctx, state, dispatch, assemble };
}
