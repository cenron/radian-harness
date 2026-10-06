// Composition root for a managed Pi coordinator session: resolves the project's
// workspace binding, configuration, repository, and state directories, and —
// only when the user starts or resumes a run — acquires the project lease,
// starts independent supervision, and builds the coordinator with the
// production runtime driver. Runtime launches remain capability-gated.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { type Blocker, type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { Role } from "../contracts/identity.ts";
import type { ResolvedProfile } from "../config/provider-policy.ts";
import { type ConfigSnapshot, loadAndResolve } from "../config/resolve.ts";
import { RuntimeWorkerDriver } from "../coordinator/driver.ts";
import { MetricsRecorder } from "../coordinator/metrics.ts";
import { ModeState } from "../coordinator/mode.ts";
import { Coordinator } from "../coordinator/orchestrator.ts";
import { harnessProvenance, harnessRoot } from "../coordinator/provenance.ts";
import type { CommitIdentity } from "../git/delivery.ts";
import { controlledGitEnv, gitArgv } from "../git/exec.ts";
import { type ProtectedTarget, type Repository, openRepository, validateTarget } from "../git/repository.ts";
import { WorktreeManager } from "../git/worktrees.ts";
import { CapabilityRegistry } from "../isolation/capabilities.ts";
import { CredentialBroker, type CredentialSource, claudeKeychainSource, codexAuthFileSource, piAuthFileSource } from "../isolation/credentials.ts";
import { systemProcessOps } from "../isolation/processes.ts";
import { SupervisionClient } from "../isolation/supervision.ts";
import { HerdrTransport, herdrEnvironment, locateHerdr, systemHerdrRunner } from "../runtimes/herdr.ts";
import { defaultAdapters } from "../runtimes/registry.ts";
import { type ResolvedBinding, type WorkspaceRegistry, checkProjectBinding } from "../state/binding.ts";
import { CapacityLedger } from "../state/capacity.ts";
import { atomicWriteJson, ensureDir, readJsonIfExists } from "../state/fsutil.ts";
import { CoordinatorLease, startLeaseRenewal } from "../state/lease.ts";
import { RunStore } from "../state/run-store.ts";
import { systemClock } from "../util/clock.ts";
import { readConfined } from "../util/confined-fs.ts";
import { type ProjectPaths, type WorkspacePaths, projectPaths, workspacePaths } from "../workspace/layout.ts";
import { CalmPreference } from "./calm.ts";

export interface ProjectSession {
  binding: ResolvedBinding;
  workspace: WorkspacePaths;
  project: ProjectPaths;
  repo: Repository;
  config: ConfigSnapshot;
  mode: ModeState;
  calm: CalmPreference;
  planningRoots: string[];
  target?: ProtectedTarget;
  run?: { store: RunStore; lease: CoordinatorLease; coordinator: Coordinator; supervision: SupervisionClient; safety?: { stop(): void } };
}

export const PLANNING_DIR = path.join(".radian", "planning");

export async function openProjectSession(cwd: string): Promise<Outcome<ProjectSession>> {
  const repo = await openRepository(cwd);
  if (!repo.ok) return repo;
  const binding = checkProjectBinding(repo.value.root);
  if (!binding.ok) return binding;
  const ws = workspacePaths(binding.value.workspaceRoot);
  const project = projectPaths(binding.value.workspaceRoot, binding.value.project);
  const config = loadAndResolve({ workspaceRoot: binding.value.workspaceRoot, projectRoot: repo.value.root });
  if (!config.ok) return config;
  ensureDir(project.state);
  const registry = readJsonIfExists(ws.registry);
  const entry = registry.state === "ok" ? (registry.value as WorkspaceRegistry).projects.find((p) => p.project === binding.value.project) : undefined;
  const session: ProjectSession = {
    binding: binding.value,
    workspace: ws,
    project,
    repo: repo.value,
    config: config.value,
    mode: new ModeState(project.state),
    calm: new CalmPreference(project.state, config.value.harness.interface?.calmDefault ?? false),
    planningRoots: [path.join(repo.value.root, PLANNING_DIR)],
  };
  if (entry?.target) {
    const target = validateTarget({ ref: entry.target });
    if (target.ok) session.target = target.value;
  }
  return success(session);
}

/** The user's configured commit identity, read without executing any repository helper. */
export function readCommitIdentity(repo: Repository): Outcome<CommitIdentity> {
  const read = (key: string): string | undefined => {
    const result = spawnSync(repo.ctx.gitPath, gitArgv(["config", "--get", key], repo.objectFormat), {
      cwd: repo.root,
      env: { ...controlledGitEnv(), HOME: os.homedir(), GIT_CONFIG_GLOBAL: path.join(os.homedir(), ".gitconfig") },
      encoding: "utf8",
      timeout: 5000,
    });
    return result.status === 0 ? result.stdout.trim() || undefined : undefined;
  };
  const name = read("user.name");
  const email = read("user.email");
  if (!name || !email) return refuse("CONFIG_INVALID", "Git user.name/user.email is not configured; Radian will not invent a commit identity");
  return success({ name, email });
}

/** Personal credential stores that workers may never read directly. */
export function personalCredentialStores(): string[] {
  const home = os.homedir();
  return [path.join(home, ".pi"), path.join(home, ".codex"), path.join(home, ".claude"), path.join(home, "Library", "Keychains"), path.join(home, ".ssh"), path.join(home, ".aws"), path.join(home, ".config", "gh")].filter((p) => existsSync(p)).map((p) => realpathSync(p));
}

export function credentialSourceFor(profile: ResolvedProfile): CredentialSource {
  const home = os.homedir();
  switch (profile.runtime) {
    case "pi":
      return piAuthFileSource(path.join(home, ".pi", "agent", "auth.json"), profile.provider);
    case "codex":
      return codexAuthFileSource(path.join(home, ".codex", "auth.json"));
    case "claude-code":
      return claudeKeychainSource("Claude Code-credentials");
  }
}

function osVersion(): string {
  const result = spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : os.release();
}

function activeRunFile(session: ProjectSession): string {
  return path.join(session.project.state, "active-run.json");
}

/**
 * Start (or reopen) the project's single active run: acquire the coordinator
 * lease, start the independent watcher, and build the coordinator. Fails
 * closed when the target, commit identity, Herdr pane, or lease is missing.
 */
export async function startRun(session: ProjectSession): Promise<Outcome<NonNullable<ProjectSession["run"]>>> {
  if (session.run) return success(session.run);
  if (!session.target) return refuse("CONFIG_INVALID", "the project's protected target branch is not registered", "Re-register the project with an explicit target branch.");
  const identity = readCommitIdentity(session.repo);
  if (!identity.ok) return identity;
  const parentPane = process.env.HERDR_PANE_ID;
  const herdr = locateHerdr();
  if (!parentPane || !herdr) return refuse("TRANSPORT_FAILURE", "the coordinator is not running inside a Herdr pane", "Start Pi from a Herdr pane so worker panes can be created next to it.");
  const lease = await CoordinatorLease.acquire(session.project.state, session.binding.project, { ttlMs: session.config.harness.supervision.leaseSeconds * 1000 * 4 });
  if (!lease.ok) return lease;
  const harness = await harnessProvenance();
  const existing = readJsonIfExists(activeRunFile(session));
  let store;
  if (existing.state === "ok") {
    store = await RunStore.open(session.project.state, (existing.value as { run: string }).run, lease.value);
    if (store.ok && store.value.state.run.status === "paused") {
      const resumed = await store.value.resume(session.config.hash);
      if (!resumed.ok) {
        await lease.value.release();
        return resumed;
      }
    }
  } else {
    store = await RunStore.create(session.project.state, lease.value, { workspace: session.binding.workspace, project: session.binding.project, configHash: session.config.hash, harness });
    if (store.ok) atomicWriteJson(activeRunFile(session), { run: store.value.state.run.id });
  }
  if (!store.ok) {
    await lease.value.release();
    return store;
  }
  const supervision = new SupervisionClient({ stateDir: session.project.state, leaseMs: session.config.harness.supervision.leaseSeconds * 1000, graceMs: session.config.harness.supervision.terminationGraceSeconds * 1000 });
  const started = await supervision.start();
  if (!started.ok) {
    await lease.value.release();
    return started;
  }
  const leaseMs = session.config.harness.supervision.leaseSeconds * 1000;
  // Supervision is healthy only while the watcher is healthy and this coordinator still holds its lease.
  const supervisionHealthy = () => {
    const watcher = supervision.health();
    return watcher.ok ? lease.value.checkHeld() : watcher;
  };
  const capabilities = new CapabilityRegistry(session.project.state);
  const driver = new RuntimeWorkerDriver({
    adapters: defaultAdapters(),
    capabilities,
    broker: new CredentialBroker(),
    transport: new HerdrTransport({ runner: systemHerdrRunner(herdr, herdrEnvironment()), stateDir: session.project.state }),
    supervision,
    ops: systemProcessOps,
    stateDir: session.project.state,
    projectionRoot: session.project.projections,
    osVersion: osVersion(),
    launcherArgv: [process.execPath, path.join(harnessRoot(), "src", "isolation", "launcher-main.ts")],
    parentPane,
    denyRead: personalCredentialStores(),
    graceMs: session.config.harness.supervision.terminationGraceSeconds * 1000,
  });
  const workerDocs = path.join(harnessRoot(), "workers");
  const coordinator = new Coordinator({
    store: store.value,
    repo: session.repo,
    worktrees: new WorktreeManager(session.repo, session.project.state, session.project.worktrees),
    capacity: new CapacityLedger(session.workspace.state),
    capacityCeiling: session.config.harness.concurrency.maxActiveWorkers,
    driver,
    mode: session.mode,
    metrics: new MetricsRecorder(session.project.state, { provenance: store.value.state.run.harness, configHash: store.value.state.run.configHash, run: store.value.state.run.id }),
    config: session.config,
    target: session.target,
    commitIdentity: identity.value,
    paths: { stateDir: session.project.state, exchangeRoot: session.project.exchange, scratchRoot: session.project.scratch },
    workspace: session.binding.workspace,
    project: session.binding.project,
    clock: systemClock,
    artifactHash: (relative) => artifactHash(session.repo.root, relative),
    roleGuide: (role: Role) => readFileSync(path.join(workerDocs, `${role}.md`), "utf8"),
    credentialSourceFor,
    supervisionHealthy,
    safetyIntervalMs: Math.max(250, Math.min(1000, Math.floor(leaseMs / 2))),
    startupMs: session.config.harness.assignment.startupTimeoutSeconds * 1000,
  });
  // Watcher exit, heartbeat-pipe failure, and every lease-renewal refusal or error stop owned work.
  const onLoss = (blocker: Blocker) => void coordinator.supervisionLost(blocker).catch(() => undefined);
  const unsubscribe = supervision.onLoss(onLoss);
  const renewal = startLeaseRenewal(lease.value, leaseMs, onLoss);
  const safety = {
    stop() {
      renewal.stop();
      unsubscribe();
      coordinator.stopMonitoring();
    },
  };
  session.run = { store: store.value, lease: lease.value, coordinator, supervision, safety };
  return success(session.run);
}

/**
 * Content digest of an approved artifact inside the project (planning artifacts
 * live under .radian/planning). Read without following any link, so a link to
 * a production file is never hashed, approved, or revalidated as an artifact.
 */
export function artifactHash(projectRoot: string, relative: string): string | undefined {
  const read = readConfined(projectRoot, relative);
  return read.ok ? Coordinator.artifactDigest(read.value) : undefined;
}

export function shortHash(hash: string): string {
  return hash.replace(/^sha256:/, "").slice(0, 12);
}
