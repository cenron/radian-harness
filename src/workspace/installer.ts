// Non-destructive workspace binding: preview → apply exactly the previewed plan
// → status → update → remove, with interrupted-operation recovery.
//
// Every operation is a plan of whole-file replacements, each guarded by the
// file's expected prior state (absent or content hash). Applying a plan whose
// preconditions no longer hold fails without writing. A journal records the
// plan and progress so an interrupted apply can be completed or reported, never
// rolled back over unrelated user changes.
//
// Ownership: Radian owns its workspace records under `.radian/` and exactly one
// package entry in each registered project's `.pi/settings.json`. Unrelated
// settings, other package entries, AGENTS.md, personal configuration,
// credentials, and project files are never modified. Remove deletes only
// unchanged owned material and retains runtime state and evidence.

import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { isWithin } from "../contracts/paths.ts";
import { canonicalJson, hashJson, sha256 } from "../util/canonical.ts";
import { type IdentityProbe, liveness, psProbe } from "../util/process-identity.ts";
import { git, gitText, locateGit } from "../git/exec.ts";
import { openRepository, resolveCommit, validateTarget } from "../git/repository.ts";
import { atomicWrite, atomicWriteJson, ensureDir, readJsonIfExists } from "../state/fsutil.ts";
import type { WorkspaceRecord, WorkspaceRegistry } from "../state/binding.ts";
import { loadRunDir } from "../state/run-store.ts";
import { WORKSPACE_FILE, projectPaths, workspaceAncestors, workspacePaths } from "./layout.ts";
import { succeeded } from "../util/proc.ts";

export type Source = { kind: "local"; path: string } | { kind: "pinned"; spec: string };

export interface ProjectRequest {
  path: string;
  /** Explicit protected target branch, e.g. refs/heads/main. */
  target: string;
}

export type FileState = { state: "absent" } | { state: "hash"; hash: string };
export type FileAfter = { state: "absent" } | { state: "content"; content: string };

export interface ReplaceFile {
  path: string;
  before: FileState;
  after: FileAfter;
  description: string;
}

export interface OperationPlan {
  schema: "radian.install-plan/1";
  operation: "install" | "update" | "remove";
  workspace: string;
  actions: ReplaceFile[];
  notes: string[];
  conflicts: string[];
  hash: string;
}

export interface OwnedEntry {
  settingsFile: string;
  entry: unknown;
  createdFile: boolean;
}

export interface Manifest {
  schema: "radian.manifest/1";
  workspace: string;
  source: Source & { revision?: string; locallyModified?: boolean | "unknown" };
  ownedFiles: Array<{ path: string; hash: string }>;
  settingsEntries: OwnedEntry[];
  projects: Array<{ project: string; canonicalPath: string; target: string }>;
}

/** Identifiers derived from canonical paths so a reviewed plan recomputes identically. */
export function stableId(prefix: "ws" | "prj", canonicalPath: string): string {
  return `${prefix}_${sha256(canonicalPath).slice(0, 32)}`;
}

const PINNED = /^(git:[A-Za-z0-9._/:-]+@[0-9a-f]{40}|npm:(@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+)$/;

export function fileState(file: string): FileState {
  try {
    return { state: "hash", hash: "sha256:" + sha256(readFileSync(file)) };
  } catch {
    return { state: "absent" };
  }
}

function sameState(a: FileState, b: FileState): boolean {
  return a.state === b.state && (a.state === "absent" || (b.state === "hash" && a.hash === b.hash));
}

function afterState(after: FileAfter): FileState {
  return after.state === "absent" ? { state: "absent" } : { state: "hash", hash: "sha256:" + sha256(after.content) };
}

function sealPlan(plan: Omit<OperationPlan, "hash">): OperationPlan {
  return { ...plan, hash: hashJson(plan) };
}

function refuseSymlinks(paths: readonly string[]): Outcome<true> {
  for (const p of paths) {
    try {
      if (lstatSync(p).isSymbolicLink()) return refuse("INSTALL_TARGET_INVALID", `${path.basename(p)} is a symbolic link; Radian will not write through links`);
    } catch {
      // absent is fine
    }
  }
  return success(true);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** Resolve the package entry Pi should load for a project. */
export function packageEntry(source: Source, projectRoot: string): Outcome<string> {
  if (source.kind === "pinned") {
    if (!PINNED.test(source.spec)) return refuse("CONFIG_INVALID", "release bindings must be pinned to an exact commit (git:…@<40-hex>) or exact version (npm:…@x.y.z)");
    return success(source.spec);
  }
  let harness: string;
  try {
    harness = realpathSync(source.path);
    const pkg = JSON.parse(readFileSync(path.join(harness, "package.json"), "utf8")) as { name?: string; pi?: unknown };
    if (pkg.name !== "radian-harness" || !pkg.pi) return refuse("INSTALL_TARGET_INVALID", "local source is not a Radian harness checkout");
  } catch {
    return refuse("INSTALL_TARGET_INVALID", "local harness source is missing");
  }
  const relative = path.relative(path.join(projectRoot, ".pi"), harness) || ".";
  return success(relative.startsWith(".") ? relative : `./${relative}`);
}

async function sourceProvenance(source: Source): Promise<Manifest["source"]> {
  if (source.kind === "pinned") return { ...source };
  const gitPath = locateGit();
  const root = realpathSync(source.path);
  if (!gitPath) return { kind: "local", path: root, revision: "unknown", locallyModified: "unknown" };
  const head = await git({ gitPath, cwd: root }, ["rev-parse", "--verify", "HEAD"]);
  const status = await git({ gitPath, cwd: root }, ["status", "--porcelain"]);
  return { kind: "local", path: root, revision: succeeded(head) ? head.stdout.toString("utf8").trim() : "unknown", locallyModified: succeeded(status) ? status.stdout.length > 0 : "unknown" };
}

function readSettings(file: string): Outcome<Record<string, unknown> | undefined> {
  if (!existsSync(file)) return success(undefined);
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return refuse("INSTALL_CONFLICT", `${file} is not a JSON object; left untouched`);
    return success(value as Record<string, unknown>);
  } catch {
    return refuse("INSTALL_CONFLICT", "project .pi/settings.json is not valid JSON; left untouched");
  }
}

function entryEquals(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function readManifest(workspaceRoot: string): Manifest | undefined {
  const read = readJsonIfExists(workspacePaths(workspaceRoot).manifest);
  return read.state === "ok" ? (read.value as Manifest) : undefined;
}

/** Refuse when any registered project has an active or paused run, a live lease, or reserved capacity. */
export function activeRunGuard(workspaceRoot: string, probe: IdentityProbe = psProbe): Outcome<true> {
  const ws = workspacePaths(workspaceRoot);
  const registry = readJsonIfExists(ws.registry);
  const projects = registry.state === "ok" ? (registry.value as WorkspaceRegistry).projects : [];
  for (const p of projects) {
    const paths = projectPaths(workspaceRoot, p.project);
    const active = readJsonIfExists(path.join(paths.state, "active-run.json"));
    if (active.state === "ok") {
      const run = loadRunDir(path.join(paths.state, "runs", (active.value as { run: string }).run));
      if (!run.ok) return refuse("RUN_ACTIVE", `project ${p.project} has unreadable run state; resolve it first`);
      if (run.value.state.run.status === "active" || run.value.state.run.status === "paused") {
        return refuse("RUN_ACTIVE", `project ${p.project} has an ${run.value.state.run.status} run`, "Finish or cancel the run first; updates and removal happen between runs only.");
      }
    }
    const lease = readJsonIfExists(path.join(paths.state, "coordinator-lease.json"));
    if (lease.state === "ok") {
      const owner = (lease.value as { owner?: { pid: number; start: string } }).owner;
      if (owner && owner.pid > 0 && liveness(owner, probe) !== "dead") return refuse("RUN_ACTIVE", `project ${p.project} has a live or unverifiable coordinator`);
    }
  }
  const reservations = readJsonIfExists(path.join(ws.state, "capacity", "reservations.json"));
  if (reservations.state === "ok" && ((reservations.value as { reservations?: unknown[] }).reservations ?? []).length > 0) {
    return refuse("RUN_ACTIVE", "workspace capacity reservations exist; workers may still be live");
  }
  return success(true);
}

function journalFile(workspaceRoot: string): string {
  return path.join(workspacePaths(workspaceRoot).journal, "operation.json");
}

export interface InstallRequest {
  workspaceRoot: string;
  source: Source;
  projects: ProjectRequest[];
}

/** Compute the install (or re-registration) plan. Writes nothing. */
export async function planInstall(request: InstallRequest): Promise<Outcome<OperationPlan>> {
  let wsRoot: string;
  try {
    wsRoot = realpathSync(request.workspaceRoot);
    if (!statSync(wsRoot).isDirectory()) return refuse("INSTALL_TARGET_INVALID", "workspace target is not a directory");
  } catch {
    return refuse("INSTALL_TARGET_INVALID", "workspace target does not exist");
  }
  if (request.source.kind === "local") {
    try {
      const harness = realpathSync(request.source.path);
      if (isWithin(wsRoot, harness) || isWithin(harness, wsRoot)) return refuse("INSTALL_TARGET_INVALID", "the harness checkout and the workspace must be separate directories");
    } catch {
      return refuse("INSTALL_TARGET_INVALID", "local harness source is missing");
    }
  }
  const outer = workspaceAncestors(path.dirname(wsRoot));
  if (outer.length > 0) return refuse("DUPLICATE_BINDING", "the target is inside another Radian workspace");
  if (readJsonIfExists(journalFile(wsRoot)).state !== "absent") return refuse("INTERRUPTED_OPERATION", "a previous operation was interrupted", "Run recover before any new operation.");
  const ws = workspacePaths(wsRoot);
  const guard = refuseSymlinks([ws.radian, ws.workspaceFile, ws.state, ws.registry, ws.manifest]);
  if (!guard.ok) return guard;

  const existingRecord = readJsonIfExists(ws.workspaceFile);
  const record: WorkspaceRecord = existingRecord.state === "ok" ? (existingRecord.value as WorkspaceRecord) : { schema: "radian.workspace/1", workspace: stableId("ws", wsRoot), canonicalRoot: wsRoot };
  if (record.canonicalRoot !== wsRoot) return refuse("DUPLICATE_BINDING", "workspace record belongs to another location (moved or copied workspace)");
  const manifestBefore = readManifest(wsRoot);
  const registryRead = readJsonIfExists(ws.registry);
  const registry: WorkspaceRegistry = registryRead.state === "ok" ? (registryRead.value as WorkspaceRegistry) : { schema: "radian.workspace-registry/1", workspace: record.workspace, projects: [] };
  const manifest: Manifest = manifestBefore ?? { schema: "radian.manifest/1", workspace: record.workspace, source: await sourceProvenance(request.source), ownedFiles: [], settingsEntries: [], projects: [] };
  if (manifestBefore && canonicalJson({ ...manifestBefore.source, revision: undefined, locallyModified: undefined }) !== canonicalJson({ ...(await sourceProvenance(request.source)), revision: undefined, locallyModified: undefined })) {
    return refuse("INSTALL_CONFLICT", "the workspace is bound to a different source; use update");
  }

  const actions: ReplaceFile[] = [];
  const notes: string[] = [];
  const conflicts: string[] = [];
  const harnessRoot = request.source.kind === "local" ? realpathSync(request.source.path) : undefined;
  for (const p of request.projects) {
    const repo = await openRepository(p.path);
    if (!repo.ok) return refuse("INSTALL_TARGET_INVALID", `${p.path} is not a Git working tree`);
    let canonical: string;
    try {
      canonical = realpathSync(p.path);
    } catch {
      return refuse("INSTALL_TARGET_INVALID", "project path cannot be resolved");
    }
    if (repo.value.root !== canonical) return refuse("INSTALL_TARGET_INVALID", "register the repository root explicitly, not a subdirectory");
    if (!isWithin(canonical, wsRoot) || canonical === wsRoot) return refuse("INSTALL_TARGET_INVALID", "projects must be repositories inside the workspace folder");
    if (harnessRoot && isWithin(canonical, harnessRoot)) return refuse("INSTALL_TARGET_INVALID", "the harness checkout cannot be registered as a project");
    if (workspaceAncestors(canonical).some((a) => a !== wsRoot)) return refuse("DUPLICATE_BINDING", "the project is inside another Radian workspace");
    const target = validateTarget({ ref: p.target });
    if (!target.ok) return target;
    if (!(await resolveCommit(repo.value, target.value.ref)).ok) return refuse("INSTALL_TARGET_INVALID", `target ${p.target} does not exist in the project`);
    const existing = registry.projects.filter((x) => x.canonicalPath === canonical);
    if (existing.length > 1) return refuse("DUPLICATE_BINDING", "project is registered more than once");
    if (existing.length === 0) {
      registry.projects.push({ project: stableId("prj", canonical), canonicalPath: canonical, target: target.value.ref });
    } else if (existing[0]!.target !== target.value.ref) {
      return refuse("INSTALL_CONFLICT", "project is already registered with a different target; remove and re-register explicitly");
    }
    const entryOutcome = packageEntry(request.source, canonical);
    if (!entryOutcome.ok) return entryOutcome;
    const piDir = path.join(canonical, ".pi");
    const settingsFile = path.join(piDir, "settings.json");
    const links = refuseSymlinks([piDir, settingsFile]);
    if (!links.ok) return links;
    const settings = readSettings(settingsFile);
    if (!settings.ok) return settings;
    const current = settings.value ?? {};
    const packages = Array.isArray(current.packages) ? [...(current.packages as unknown[])] : current.packages === undefined ? [] : undefined;
    if (packages === undefined) return refuse("INSTALL_CONFLICT", "project settings `packages` is not an array; left untouched");
    const entry = { source: entryOutcome.value };
    const owned = manifest.settingsEntries.find((e) => e.settingsFile === settingsFile);
    if (owned && packages.some((x) => entryEquals(x, owned.entry))) {
      notes.push(`${path.relative(wsRoot, settingsFile)} already has Radian's owned entry`);
    } else if (packages.some((x) => typeof x === "object" && x !== null && String((x as { source?: unknown }).source ?? "").includes("radian"))) {
      conflicts.push(`${path.relative(wsRoot, settingsFile)} already references a Radian-like package that Radian does not own; left untouched`);
      continue;
    } else {
      const next = { ...current, packages: [...packages, entry] };
      actions.push({ path: settingsFile, before: fileState(settingsFile), after: { state: "content", content: json(next) }, description: `add Radian package entry to ${path.relative(wsRoot, settingsFile)} (other settings preserved)` });
      manifest.settingsEntries = [...manifest.settingsEntries.filter((e) => e.settingsFile !== settingsFile), { settingsFile, entry, createdFile: settings.value === undefined }];
    }
    manifest.projects = [...manifest.projects.filter((x) => x.canonicalPath !== canonical), { project: registry.projects.find((x) => x.canonicalPath === canonical)!.project, canonicalPath: canonical, target: target.value.ref }];
  }

  if (existingRecord.state !== "ok") {
    const content = json(record);
    actions.push({ path: ws.workspaceFile, before: { state: "absent" }, after: { state: "content", content }, description: "create workspace record" });
  }
  const registryContent = json(registry);
  if (registryRead.state !== "ok" || canonicalJson(registryRead.value) !== canonicalJson(registry)) {
    actions.push({ path: ws.registry, before: fileState(ws.registry), after: { state: "content", content: registryContent }, description: `register ${request.projects.length} explicit project(s)` });
  }
  const ownedFiles = [{ path: ws.workspaceFile, hash: "sha256:" + sha256(existingRecord.state === "ok" ? readFileSync(ws.workspaceFile) : json(record)) }, { path: ws.registry, hash: "sha256:" + sha256(registryContent) }];
  manifest.ownedFiles = ownedFiles;
  actions.push({ path: ws.manifest, before: fileState(ws.manifest), after: { state: "content", content: json(manifest) }, description: "record ownership manifest" });
  notes.push("Project trust is not granted by the installer; approve it in Pi when you open each project.");
  notes.push("Worker launches stay disabled until required runtime capabilities are verified.");
  return success(sealPlan({ schema: "radian.install-plan/1", operation: "install", workspace: wsRoot, actions, notes, conflicts }));
}

/** Plan removal of owned, unchanged material only. Runtime state and evidence are retained. */
export function planRemove(workspaceRoot: string, probe: IdentityProbe = psProbe): Outcome<OperationPlan> {
  let wsRoot: string;
  try {
    wsRoot = realpathSync(workspaceRoot);
  } catch {
    return refuse("INSTALL_TARGET_INVALID", "workspace target does not exist");
  }
  if (readJsonIfExists(journalFile(wsRoot)).state !== "absent") return refuse("INTERRUPTED_OPERATION", "a previous operation was interrupted", "Run recover first.");
  const manifest = readManifest(wsRoot);
  if (!manifest) return refuse("INSTALL_TARGET_INVALID", "no Radian ownership manifest in this workspace");
  const guard = activeRunGuard(wsRoot, probe);
  if (!guard.ok) return guard;
  const actions: ReplaceFile[] = [];
  const notes: string[] = [];
  const conflicts: string[] = [];
  for (const owned of manifest.settingsEntries) {
    const settings = readSettings(owned.settingsFile);
    if (!settings.ok) {
      conflicts.push(`${owned.settingsFile}: unreadable; owned entry left in place`);
      continue;
    }
    if (!settings.value) {
      notes.push(`${owned.settingsFile}: already absent`);
      continue;
    }
    const packages = Array.isArray(settings.value.packages) ? (settings.value.packages as unknown[]) : [];
    const kept = packages.filter((x) => !entryEquals(x, owned.entry));
    if (kept.length === packages.length) {
      conflicts.push(`${owned.settingsFile}: Radian's entry was modified or removed by the user; nothing changed`);
      continue;
    }
    const next: Record<string, unknown> = { ...settings.value, packages: kept };
    if (kept.length === 0) delete next.packages;
    const empty = Object.keys(next).length === 0;
    actions.push({
      path: owned.settingsFile,
      before: fileState(owned.settingsFile),
      after: empty && owned.createdFile ? { state: "absent" } : { state: "content", content: json(next) },
      description: `remove Radian's package entry from ${owned.settingsFile}${empty && owned.createdFile ? " (file was created by Radian and is now empty)" : ""}`,
    });
  }
  for (const file of manifest.ownedFiles) {
    const state = fileState(file.path);
    if (state.state === "absent") continue;
    if (state.hash !== file.hash) {
      conflicts.push(`${path.relative(wsRoot, file.path)}: locally modified; retained`);
      continue;
    }
    actions.push({ path: file.path, before: state, after: { state: "absent" }, description: `remove unchanged owned ${path.relative(wsRoot, file.path)}` });
  }
  actions.push({ path: workspacePaths(wsRoot).manifest, before: fileState(workspacePaths(wsRoot).manifest), after: conflicts.length > 0 ? { state: "content", content: json({ ...manifest, settingsEntries: manifest.settingsEntries.filter((e) => conflicts.some((c) => c.startsWith(e.settingsFile))), ownedFiles: manifest.ownedFiles.filter((f) => conflicts.some((c) => c.startsWith(path.relative(wsRoot, f.path)))) }) } : { state: "absent" }, description: "update ownership manifest" });
  notes.push("Runs, evidence, metrics, worktrees, workspace configuration overrides, the harness checkout, projects, and credentials are retained.");
  return success(sealPlan({ schema: "radian.install-plan/1", operation: "remove", workspace: wsRoot, actions, notes, conflicts }));
}

/** Plan a source update between runs; locally modified owned entries are preserved and reported. */
export async function planUpdate(workspaceRoot: string, source: Source, probe: IdentityProbe = psProbe): Promise<Outcome<OperationPlan>> {
  let wsRoot: string;
  try {
    wsRoot = realpathSync(workspaceRoot);
  } catch {
    return refuse("INSTALL_TARGET_INVALID", "workspace target does not exist");
  }
  if (readJsonIfExists(journalFile(wsRoot)).state !== "absent") return refuse("INTERRUPTED_OPERATION", "a previous operation was interrupted", "Run recover first.");
  const manifest = readManifest(wsRoot);
  if (!manifest) return refuse("INSTALL_TARGET_INVALID", "no Radian ownership manifest in this workspace");
  const guard = activeRunGuard(wsRoot, probe);
  if (!guard.ok) return guard;
  const actions: ReplaceFile[] = [];
  const conflicts: string[] = [];
  const entries: OwnedEntry[] = [];
  for (const owned of manifest.settingsEntries) {
    const project = manifest.projects.find((p) => owned.settingsFile === path.join(p.canonicalPath, ".pi", "settings.json"));
    if (!project) {
      entries.push(owned);
      continue;
    }
    const nextEntry = packageEntry(source, project.canonicalPath);
    if (!nextEntry.ok) return nextEntry;
    const settings = readSettings(owned.settingsFile);
    if (!settings.ok || !settings.value) {
      conflicts.push(`${owned.settingsFile}: missing or unreadable; not updated`);
      entries.push(owned);
      continue;
    }
    const packages = Array.isArray(settings.value.packages) ? (settings.value.packages as unknown[]) : [];
    const index = packages.findIndex((x) => entryEquals(x, owned.entry));
    if (index === -1) {
      conflicts.push(`${owned.settingsFile}: Radian's entry was modified locally; preserved and not updated`);
      entries.push(owned);
      continue;
    }
    const entry = { source: nextEntry.value };
    const nextPackages = [...packages];
    nextPackages[index] = entry;
    actions.push({ path: owned.settingsFile, before: fileState(owned.settingsFile), after: { state: "content", content: json({ ...settings.value, packages: nextPackages }) }, description: `update Radian's package entry in ${owned.settingsFile}` });
    entries.push({ ...owned, entry });
  }
  const next: Manifest = { ...manifest, source: await sourceProvenance(source), settingsEntries: entries };
  actions.push({ path: workspacePaths(wsRoot).manifest, before: fileState(workspacePaths(wsRoot).manifest), after: { state: "content", content: json(next) }, description: "record updated source in the ownership manifest" });
  return success(sealPlan({ schema: "radian.install-plan/1", operation: "update", workspace: wsRoot, actions, notes: ["Paused runs keep their recorded harness version and configuration; adopting the new version requires an explicit migration decision."], conflicts }));
}

/** Apply exactly the previewed plan. The caller supplies the hash the user reviewed. */
export function applyPlan(plan: OperationPlan, reviewedHash: string): Outcome<{ applied: number }> {
  const { hash, ...body } = plan;
  if (hashJson(body) !== hash) return refuse("POLICY_TAMPERED", "the plan does not match its own hash");
  if (reviewedHash !== hash) return refuse("INSTALL_CONFLICT", "the reviewed plan hash does not match; preview again and review the new plan");
  const journal = journalFile(plan.workspace);
  if (readJsonIfExists(journal).state !== "absent") return refuse("INTERRUPTED_OPERATION", "a previous operation was interrupted", "Run recover first.");
  for (const action of plan.actions) {
    if (!sameState(fileState(action.path), action.before)) return refuse("INSTALL_CONFLICT", `${action.path} changed since the preview; nothing was written`, "Preview again.");
  }
  ensureDir(path.dirname(journal));
  atomicWriteJson(journal, { plan, done: [] });
  const done: number[] = [];
  for (const [index, action] of plan.actions.entries()) {
    const current = fileState(action.path);
    if (sameState(current, afterState(action.after))) {
      done.push(index);
      continue;
    }
    if (!sameState(current, action.before)) {
      return refuse("INSTALL_CONFLICT", `${action.path} changed during the operation; stopped and journaled`, "Run recover to finish or inspect the conflict.");
    }
    writeAfter(action);
    done.push(index);
    atomicWriteJson(journal, { plan, done });
  }
  rmSync(journal, { force: true });
  return success({ applied: done.length });
}

function writeAfter(action: ReplaceFile): void {
  if (action.after.state === "absent") {
    rmSync(action.path, { force: true });
    return;
  }
  ensureDir(path.dirname(action.path), 0o755);
  atomicWrite(action.path, action.after.content, 0o644);
}

/**
 * Complete an interrupted operation: actions already at their after-state are
 * done; actions still at their before-state are applied; anything else is a
 * conflict that is reported and left for the user. Unrelated changes are never
 * rolled back.
 */
export function recover(workspaceRoot: string): Outcome<{ completed: number; conflicts: string[] }> {
  const journal = journalFile(realpathSync(workspaceRoot));
  const read = readJsonIfExists(journal);
  if (read.state === "absent") return success({ completed: 0, conflicts: [] });
  if (read.state === "corrupt") return refuse("INTERRUPTED_OPERATION", "the operation journal is unreadable; inspect it manually");
  const { plan } = read.value as { plan: OperationPlan; done: number[] };
  const conflicts: string[] = [];
  let completed = 0;
  for (const action of plan.actions) {
    const current = fileState(action.path);
    if (sameState(current, afterState(action.after))) {
      completed += 1;
      continue;
    }
    if (sameState(current, action.before)) {
      writeAfter(action);
      completed += 1;
      continue;
    }
    conflicts.push(`${action.path}: neither the expected prior state nor the planned result; left untouched`);
  }
  if (conflicts.length === 0) rmSync(journal, { force: true });
  return success({ completed, conflicts });
}

export interface StatusReport {
  workspace: string;
  installed: boolean;
  interrupted: boolean;
  source?: Manifest["source"];
  projects: Array<{ project: string; path: string; target?: string; exists: boolean; entry: "owned-unchanged" | "modified-or-missing" | "not-installed" }>;
  ownedFiles: Array<{ path: string; state: "unchanged" | "modified" | "missing" }>;
  activeRuns: string | undefined;
  sourceAvailable: boolean | "pinned";
}

export function status(workspaceRoot: string, probe: IdentityProbe = psProbe): Outcome<StatusReport> {
  let wsRoot: string;
  try {
    wsRoot = realpathSync(workspaceRoot);
  } catch {
    return refuse("INSTALL_TARGET_INVALID", "workspace target does not exist");
  }
  const ws = workspacePaths(wsRoot);
  const manifest = readManifest(wsRoot);
  const registryRead = readJsonIfExists(ws.registry);
  const registry = registryRead.state === "ok" ? (registryRead.value as WorkspaceRegistry) : undefined;
  const guard = activeRunGuard(wsRoot, probe);
  const report: StatusReport = {
    workspace: wsRoot,
    installed: manifest !== undefined && existsSync(path.join(wsRoot, WORKSPACE_FILE)),
    interrupted: readJsonIfExists(journalFile(wsRoot)).state !== "absent",
    projects: (registry?.projects ?? []).map((p) => {
      const owned = manifest?.settingsEntries.find((e) => e.settingsFile === path.join(p.canonicalPath, ".pi", "settings.json"));
      let entry: StatusReport["projects"][number]["entry"] = "not-installed";
      if (owned) {
        const settings = readSettings(owned.settingsFile);
        const packages = settings.ok && settings.value && Array.isArray(settings.value.packages) ? (settings.value.packages as unknown[]) : [];
        entry = packages.some((x) => entryEquals(x, owned.entry)) ? "owned-unchanged" : "modified-or-missing";
      }
      const out: StatusReport["projects"][number] = { project: p.project, path: p.canonicalPath, exists: existsSync(p.canonicalPath), entry };
      if (p.target) out.target = p.target;
      return out;
    }),
    ownedFiles: (manifest?.ownedFiles ?? []).map((f) => {
      const state = fileState(f.path);
      return { path: f.path, state: state.state === "absent" ? "missing" : state.hash === f.hash ? "unchanged" : "modified" };
    }),
    activeRuns: guard.ok ? undefined : guard.blocker.message,
    sourceAvailable: manifest?.source.kind === "pinned" ? "pinned" : manifest?.source.kind === "local" ? existsSync(path.join(manifest.source.path, "package.json")) : false,
  };
  if (manifest) report.source = manifest.source;
  return success(report);
}

export async function harnessRevision(root: string): Promise<string> {
  const gitPath = locateGit();
  if (!gitPath) return "unknown";
  try {
    return await gitText({ gitPath, cwd: root }, ["rev-parse", "HEAD"]);
  } catch {
    return "unknown";
  }
}
