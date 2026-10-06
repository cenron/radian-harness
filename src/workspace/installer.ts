// Non-destructive workspace binding: preview → apply exactly the previewed plan
// → status → update → remove, with interrupted-operation recovery.
//
// Every operation is a plan of whole-file replacements, each guarded by the
// file's expected prior state (absent or content hash). Applying a plan whose
// preconditions no longer hold fails without writing. A journal records the
// plan and progress so an interrupted apply can be completed or reported, never
// rolled back over unrelated user changes.
//
// Ownership: Radian owns its workspace records under `.radian/`, exactly one
// package entry in the workspace's `.pi/settings.json` (so Pi started at the
// workspace root loads Radian), and exactly one package entry in each
// explicitly registered project's `.pi/settings.json` (direct project entry).
// A workspace may have zero projects and need not be a Git repository.
// Unrelated settings, other package entries, AGENTS.md, personal
// configuration, credentials, and project files are never modified. Remove
// deletes only unchanged owned material and retains runtime state and evidence.
//
// Every write, replacement, and removal goes through the namespace-safe
// primitives in util/safe-dir.ts, anchored at the canonical workspace root:
// no link is followed and no parent directory is created or replaced through
// a substituted path. Manifests from project-first installations
// (`radian.manifest/1`) are read as legacy and migrated only by an explicit,
// previewed install or update.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { isWithin } from "../contracts/paths.ts";
import { canonicalJson, hashJson, sha256 } from "../util/canonical.ts";
import { type IdentityProbe, liveness, psProbe } from "../util/process-identity.ts";
import { git, gitText, locateGit } from "../git/exec.ts";
import { openRepository, resolveCommit, validateTarget } from "../git/repository.ts";
import { readJsonIfExists } from "../state/fsutil.ts";
import { type SafeDirHooks, readFileConfinedBytes, removeFileConfined, writeFileAtomicConfined } from "../util/safe-dir.ts";
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
  schema: "radian.manifest/2";
  workspace: string;
  source: Source & { revision?: string; locallyModified?: boolean | "unknown" };
  ownedFiles: Array<{ path: string; hash: string }>;
  /** The owned package entry in the workspace's own `.pi/settings.json`. */
  workspaceEntry?: OwnedEntry;
  /** Owned package entries in registered projects' `.pi/settings.json` (direct project entry). */
  settingsEntries: OwnedEntry[];
  projects: Array<{ project: string; canonicalPath: string; target: string }>;
}

/** Project-first installations (before workspace-first) wrote this schema. */
export const LEGACY_MANIFEST_SCHEMA = "radian.manifest/1";

/** Identifiers derived from canonical paths so a reviewed plan recomputes identically. */
export function stableId(prefix: "ws" | "prj", canonicalPath: string): string {
  return `${prefix}_${sha256(canonicalPath).slice(0, 32)}`;
}

const PINNED = /^(git:[A-Za-z0-9._/:-]+@[0-9a-f]{40}|npm:(@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+)$/;

/** Content state of a file, read without following links. Links and unreadable paths never match a plan. */
export function fileState(file: string): FileState | { state: "unsafe" } {
  const anchor = anchorFor(file);
  if (!anchor) return { state: "unsafe" };
  const read = readFileConfinedBytes(anchor.root, anchor.relative);
  if (!read.ok) return { state: "unsafe" };
  return read.value === undefined ? { state: "absent" } : { state: "hash", hash: "sha256:" + sha256(read.value) };
}

/**
 * Owned files live inside a canonical workspace root; the anchor is the
 * nearest ancestor that holds a workspace record, or (for a first install) the
 * directory that will hold it.
 */
const pendingAnchors = new Set<string>();
function anchorFor(file: string): { root: string; relative: string } | undefined {
  for (const root of [...pendingAnchors, ...workspaceAncestors(path.dirname(file))]) {
    if (isWithin(file, root) && file !== root) return { root, relative: path.relative(root, file).split(path.sep).join("/") };
  }
  return undefined;
}

function sameState(a: FileState | { state: "unsafe" }, b: FileState): boolean {
  if (a.state === "unsafe") return false;
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
  const anchor = anchorFor(file);
  if (!anchor) return refuse("INSTALL_TARGET_INVALID", "settings file is outside the workspace");
  const read = readFileConfinedBytes(anchor.root, anchor.relative);
  if (!read.ok) return refuse("INSTALL_TARGET_INVALID", `${path.basename(path.dirname(file))}/${path.basename(file)} cannot be read safely: ${read.blocker.message}`);
  if (read.value === undefined) return success(undefined);
  try {
    const value = JSON.parse(read.value.toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return refuse("INSTALL_CONFLICT", `${file} is not a JSON object; left untouched`);
    return success(value as Record<string, unknown>);
  } catch {
    return refuse("INSTALL_CONFLICT", ".pi/settings.json is not valid JSON; left untouched");
  }
}

function entryEquals(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** The ownership manifest, with project-first (v1) manifests normalized; `legacy` marks them. */
export function readManifest(workspaceRoot: string): (Manifest & { legacy?: true }) | undefined {
  const read = readJsonIfExists(workspacePaths(workspaceRoot).manifest);
  if (read.state !== "ok") return undefined;
  const value = read.value as { schema?: string } & Omit<Manifest, "schema">;
  if (value.schema === LEGACY_MANIFEST_SCHEMA) return { ...value, schema: "radian.manifest/2", legacy: true };
  return value.schema === "radian.manifest/2" ? (value as Manifest) : undefined;
}

function withoutLegacy(manifest: Manifest & { legacy?: true }): Manifest {
  const { legacy: _legacy, ...rest } = manifest;
  return rest;
}

/** A Radian workspace marker below `root` (bounded depth), which would make bindings ambiguous. */
function nestedWorkspaceBelow(root: string, depth = 3): string | undefined {
  const walk = (dir: string, level: number): string | undefined => {
    if (level > depth) return undefined;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules" || (dir === root && entry.name === ".radian")) continue;
      const child = path.join(dir, entry.name);
      if (existsSync(path.join(child, WORKSPACE_FILE))) return child;
      const found = walk(child, level + 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(root, 1);
}

function ownedEntryFor(source: Source, root: string, settingsFile: string, manifest: Manifest, current: Record<string, unknown> | undefined, wsRoot: string, label: string): Outcome<{ action?: ReplaceFile; owned?: OwnedEntry; note?: string; conflict?: string }> {
  const entryOutcome = packageEntry(source, root);
  if (!entryOutcome.ok) return entryOutcome;
  const value = current ?? {};
  const packages = Array.isArray(value.packages) ? [...(value.packages as unknown[])] : value.packages === undefined ? [] : undefined;
  if (packages === undefined) return refuse("INSTALL_CONFLICT", `${label} settings \`packages\` is not an array; left untouched`);
  const entry = { source: entryOutcome.value };
  const owned = settingsFile === manifest.workspaceEntry?.settingsFile ? manifest.workspaceEntry : manifest.settingsEntries.find((e) => e.settingsFile === settingsFile);
  if (owned && packages.some((x) => entryEquals(x, owned.entry))) return success({ owned, note: `${path.relative(wsRoot, settingsFile) || settingsFile} already has Radian's owned entry` });
  if (packages.some((x) => String((typeof x === "object" && x !== null ? (x as { source?: unknown }).source : x) ?? "").includes("radian"))) {
    return success({ conflict: `${path.relative(wsRoot, settingsFile)} already references a Radian-like package that Radian does not own; left untouched` });
  }
  const next = { ...value, packages: [...packages, entry] };
  return success({
    action: { path: settingsFile, before: fileState(settingsFile) as FileState, after: { state: "content", content: json(next) }, description: `add Radian package entry to ${path.relative(wsRoot, settingsFile)} (other settings preserved)` },
    owned: { settingsFile, entry, createdFile: current === undefined },
  });
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
  /** Existing repositories to register now; a workspace may start with none. */
  projects?: ProjectRequest[];
  /** Process-identity probe for the active-run guard (tests inject a fake). */
  probe?: IdentityProbe;
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
  pendingAnchors.add(wsRoot);
  try {
    return await planInstallAt(wsRoot, request);
  } finally {
    pendingAnchors.delete(wsRoot);
  }
}

async function planInstallAt(wsRoot: string, request: InstallRequest): Promise<Outcome<OperationPlan>> {
  const requested = request.projects ?? [];
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
  const inner = nestedWorkspaceBelow(wsRoot);
  if (inner) return refuse("DUPLICATE_BINDING", `a Radian workspace already exists below the target (${path.relative(wsRoot, inner)}); nested workspaces are ambiguous`);
  if (readJsonIfExists(journalFile(wsRoot)).state !== "absent") return refuse("INTERRUPTED_OPERATION", "a previous operation was interrupted", "Run recover before any new operation.");
  const ws = workspacePaths(wsRoot);
  const guard = refuseSymlinks([ws.radian, ws.workspaceFile, ws.state, ws.registry, ws.manifest, ws.config, ws.journal, path.join(wsRoot, ".pi"), path.join(wsRoot, ".pi", "settings.json")]);
  if (!guard.ok) return guard;

  const existingRecord = readJsonIfExists(ws.workspaceFile);
  const record: WorkspaceRecord = existingRecord.state === "ok" ? (existingRecord.value as WorkspaceRecord) : { schema: "radian.workspace/1", workspace: stableId("ws", wsRoot), canonicalRoot: wsRoot };
  if (record.canonicalRoot !== wsRoot) return refuse("DUPLICATE_BINDING", "workspace record belongs to another location (moved or copied workspace)");
  const manifestBefore = readManifest(wsRoot);
  if (manifestBefore?.legacy) {
    // Migrating a project-first installation never happens beneath live work.
    const guard = activeRunGuard(wsRoot, request.probe ?? psProbe);
    if (!guard.ok) return guard;
  }
  const registryRead = readJsonIfExists(ws.registry);
  const registry: WorkspaceRegistry = registryRead.state === "ok" ? (registryRead.value as WorkspaceRegistry) : { schema: "radian.workspace-registry/1", workspace: record.workspace, projects: [] };
  const manifest: Manifest = manifestBefore ? withoutLegacy(manifestBefore) : { schema: "radian.manifest/2", workspace: record.workspace, source: await sourceProvenance(request.source), ownedFiles: [], settingsEntries: [], projects: [] };
  if (manifestBefore && canonicalJson({ ...manifestBefore.source, revision: undefined, locallyModified: undefined }) !== canonicalJson({ ...(await sourceProvenance(request.source)), revision: undefined, locallyModified: undefined })) {
    return refuse("INSTALL_CONFLICT", "the workspace is bound to a different source; use update");
  }

  const actions: ReplaceFile[] = [];
  const notes: string[] = [];
  const conflicts: string[] = [];
  const harnessRoot = request.source.kind === "local" ? realpathSync(request.source.path) : undefined;
  for (const p of requested) {
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
    if (registry.projects.some((x) => x.canonicalPath !== canonical && (isWithin(canonical, x.canonicalPath) || isWithin(x.canonicalPath, canonical)))) return refuse("INSTALL_TARGET_INVALID", "registered projects cannot be nested inside each other");
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
    const piDir = path.join(canonical, ".pi");
    const settingsFile = path.join(piDir, "settings.json");
    const links = refuseSymlinks([piDir, settingsFile]);
    if (!links.ok) return links;
    const settings = readSettings(settingsFile);
    if (!settings.ok) return settings;
    const planned = ownedEntryFor(request.source, canonical, settingsFile, manifest, settings.value, wsRoot, "project");
    if (!planned.ok) return planned;
    if (planned.value.conflict) {
      conflicts.push(planned.value.conflict);
      continue;
    }
    if (planned.value.note) notes.push(planned.value.note);
    if (planned.value.action) actions.push(planned.value.action);
    if (planned.value.owned) manifest.settingsEntries = [...manifest.settingsEntries.filter((e) => e.settingsFile !== settingsFile), planned.value.owned];
    manifest.projects = [...manifest.projects.filter((x) => x.canonicalPath !== canonical), { project: registry.projects.find((x) => x.canonicalPath === canonical)!.project, canonicalPath: canonical, target: target.value.ref }];
  }

  // The workspace's own Pi binding: Pi started at the workspace root loads Radian.
  const wsSettingsFile = path.join(wsRoot, ".pi", "settings.json");
  const wsSettings = readSettings(wsSettingsFile);
  if (!wsSettings.ok) return wsSettings;
  const wsEntry = ownedEntryFor(request.source, wsRoot, wsSettingsFile, manifest, wsSettings.value, wsRoot, "workspace");
  if (!wsEntry.ok) return wsEntry;
  if (wsEntry.value.conflict) conflicts.push(wsEntry.value.conflict);
  if (wsEntry.value.note) notes.push(wsEntry.value.note);
  if (wsEntry.value.action) actions.push(wsEntry.value.action);
  if (wsEntry.value.owned) manifest.workspaceEntry = wsEntry.value.owned;

  if (existingRecord.state !== "ok") {
    const content = json(record);
    actions.push({ path: ws.workspaceFile, before: { state: "absent" }, after: { state: "content", content }, description: "create workspace record" });
  }
  const registryContent = json(registry);
  if (registryRead.state !== "ok" || canonicalJson(registryRead.value) !== canonicalJson(registry)) {
    actions.push({ path: ws.registry, before: fileState(ws.registry) as FileState, after: { state: "content", content: registryContent }, description: requested.length ? `register ${requested.length} explicit project(s)` : "create an empty project registry" });
  }
  const recordState = fileState(ws.workspaceFile);
  const ownedFiles = [{ path: ws.workspaceFile, hash: recordState.state === "hash" ? recordState.hash : "sha256:" + sha256(json(record)) }, { path: ws.registry, hash: "sha256:" + sha256(registryContent) }];
  manifest.ownedFiles = ownedFiles;
  const manifestContent = json(manifest);
  const manifestState = fileState(ws.manifest);
  if (manifestBefore?.legacy) notes.push("Migrates the project-first ownership manifest to the workspace-first format; existing project bindings, identities, and state are retained.");
  if (actions.length > 0 || manifestBefore?.legacy || manifestState.state !== "hash" || manifestState.hash !== "sha256:" + sha256(manifestContent)) {
    actions.push({ path: ws.manifest, before: manifestState as FileState, after: { state: "content", content: manifestContent }, description: "record ownership manifest" });
  }
  if (actions.length === 0) notes.push("Already installed; nothing to change.");
  if (registry.projects.length === 0) notes.push("The workspace has no projects yet; create one with /new-project or register an existing repository with /add-project in Pi.");
  notes.push("Pi asks you to trust the workspace the first time you start it there; the installer never grants trust.");
  notes.push("Worker launches stay disabled until required runtime capabilities are verified.");
  return success(sealPlan({ schema: "radian.install-plan/1", operation: "install", workspace: wsRoot, actions, notes, conflicts }));
}

/** Plan state of a file; a link or unreadable path is a refusal, never a matching state. */
function planState(file: string): Outcome<FileState> {
  const state = fileState(file);
  return state.state === "unsafe" ? refuse("INSTALL_TARGET_INVALID", `${path.basename(path.dirname(file))}/${path.basename(file)} is a link or cannot be read safely; left untouched`) : success(state);
}

function canonicalWorkspace(workspaceRoot: string): Outcome<string> {
  try {
    return success(realpathSync(workspaceRoot));
  } catch {
    return refuse("INSTALL_TARGET_INVALID", "workspace target does not exist");
  }
}

/** Plan removal of owned, unchanged material only. Runtime state and evidence are retained. */
export function planRemove(workspaceRoot: string, probe: IdentityProbe = psProbe): Outcome<OperationPlan> {
  const root = canonicalWorkspace(workspaceRoot);
  if (!root.ok) return root;
  const wsRoot = root.value;
  if (readJsonIfExists(journalFile(wsRoot)).state !== "absent") return refuse("INTERRUPTED_OPERATION", "a previous operation was interrupted", "Run recover first.");
  const read = readManifest(wsRoot);
  if (!read) return refuse("INSTALL_TARGET_INVALID", "no Radian ownership manifest in this workspace");
  const manifest = withoutLegacy(read);
  const guard = activeRunGuard(wsRoot, probe);
  if (!guard.ok) return guard;
  const actions: ReplaceFile[] = [];
  const notes: string[] = [];
  const conflicts: string[] = [];
  const kept: OwnedEntry[] = [];
  for (const owned of [...(manifest.workspaceEntry ? [manifest.workspaceEntry] : []), ...manifest.settingsEntries]) {
    const label = path.relative(wsRoot, owned.settingsFile);
    const settings = readSettings(owned.settingsFile);
    if (!settings.ok) {
      conflicts.push(`${label}: unreadable; owned entry left in place`);
      kept.push(owned);
      continue;
    }
    if (!settings.value) {
      notes.push(`${label}: already absent`);
      continue;
    }
    const packages = Array.isArray(settings.value.packages) ? (settings.value.packages as unknown[]) : [];
    const remaining = packages.filter((x) => !entryEquals(x, owned.entry));
    if (remaining.length === packages.length) {
      conflicts.push(`${label}: Radian's entry was modified or removed by the user; nothing changed`);
      kept.push(owned);
      continue;
    }
    const next: Record<string, unknown> = { ...settings.value, packages: remaining };
    if (remaining.length === 0) delete next.packages;
    const empty = Object.keys(next).length === 0;
    const before = planState(owned.settingsFile);
    if (!before.ok) return before;
    actions.push({
      path: owned.settingsFile,
      before: before.value,
      after: empty && owned.createdFile ? { state: "absent" } : { state: "content", content: json(next) },
      description: `remove Radian's package entry from ${label}${empty && owned.createdFile ? " (file was created by Radian and is now empty)" : ""}`,
    });
  }
  const keptFiles: Manifest["ownedFiles"] = [];
  for (const file of manifest.ownedFiles) {
    const state = fileState(file.path);
    if (state.state === "absent") continue;
    if (state.state === "unsafe" || state.hash !== file.hash) {
      conflicts.push(`${path.relative(wsRoot, file.path)}: locally modified; retained`);
      keptFiles.push(file);
      continue;
    }
    actions.push({ path: file.path, before: state, after: { state: "absent" }, description: `remove unchanged owned ${path.relative(wsRoot, file.path)}` });
  }
  const manifestState = planState(workspacePaths(wsRoot).manifest);
  if (!manifestState.ok) return manifestState;
  const residual: Manifest = { ...manifest, settingsEntries: kept.filter((e) => e !== manifest.workspaceEntry), ownedFiles: keptFiles };
  if (manifest.workspaceEntry && kept.includes(manifest.workspaceEntry)) residual.workspaceEntry = manifest.workspaceEntry;
  else delete residual.workspaceEntry;
  actions.push({ path: workspacePaths(wsRoot).manifest, before: manifestState.value, after: conflicts.length > 0 ? { state: "content", content: json(residual) } : { state: "absent" }, description: "update ownership manifest" });
  notes.push("Runs, evidence, metrics, worktrees, workspace configuration overrides, project context references, the harness checkout, projects, and credentials are retained.");
  return success(sealPlan({ schema: "radian.install-plan/1", operation: "remove", workspace: wsRoot, actions, notes, conflicts }));
}

/** Plan a source update between runs; locally modified owned entries are preserved and reported. */
export async function planUpdate(workspaceRoot: string, source: Source, probe: IdentityProbe = psProbe): Promise<Outcome<OperationPlan>> {
  const root = canonicalWorkspace(workspaceRoot);
  if (!root.ok) return root;
  const wsRoot = root.value;
  if (readJsonIfExists(journalFile(wsRoot)).state !== "absent") return refuse("INTERRUPTED_OPERATION", "a previous operation was interrupted", "Run recover first.");
  const read = readManifest(wsRoot);
  if (!read) return refuse("INSTALL_TARGET_INVALID", "no Radian ownership manifest in this workspace");
  const manifest = withoutLegacy(read);
  const guard = activeRunGuard(wsRoot, probe);
  if (!guard.ok) return guard;
  const actions: ReplaceFile[] = [];
  const conflicts: string[] = [];
  const notes: string[] = ["Paused runs keep their recorded harness version and configuration; adopting the new version requires an explicit migration decision."];
  const updateEntry = (owned: OwnedEntry, root: string): Outcome<OwnedEntry> => {
    const nextEntry = packageEntry(source, root);
    if (!nextEntry.ok) return nextEntry;
    const label = path.relative(wsRoot, owned.settingsFile);
    const settings = readSettings(owned.settingsFile);
    if (!settings.ok || !settings.value) {
      conflicts.push(`${label}: missing or unreadable; not updated`);
      return success(owned);
    }
    const packages = Array.isArray(settings.value.packages) ? (settings.value.packages as unknown[]) : [];
    const index = packages.findIndex((x) => entryEquals(x, owned.entry));
    if (index === -1) {
      conflicts.push(`${label}: Radian's entry was modified locally; preserved and not updated`);
      return success(owned);
    }
    const entry = { source: nextEntry.value };
    if (entryEquals(entry, owned.entry)) return success(owned);
    const nextPackages = [...packages];
    nextPackages[index] = entry;
    const before = planState(owned.settingsFile);
    if (!before.ok) return before;
    actions.push({ path: owned.settingsFile, before: before.value, after: { state: "content", content: json({ ...settings.value, packages: nextPackages }) }, description: `update Radian's package entry in ${label}` });
    return success({ ...owned, entry });
  };
  const entries: OwnedEntry[] = [];
  for (const owned of manifest.settingsEntries) {
    const project = manifest.projects.find((p) => owned.settingsFile === path.join(p.canonicalPath, ".pi", "settings.json"));
    if (!project) {
      entries.push(owned);
      continue;
    }
    const updated = updateEntry(owned, project.canonicalPath);
    if (!updated.ok) return updated;
    entries.push(updated.value);
  }
  const next: Manifest = { ...manifest, source: await sourceProvenance(source), settingsEntries: entries };
  if (manifest.workspaceEntry) {
    const updated = updateEntry(manifest.workspaceEntry, wsRoot);
    if (!updated.ok) return updated;
    next.workspaceEntry = updated.value;
  } else {
    notes.push("This project-first installation has no workspace entry; run install (preview first) to add one.");
  }
  if (read.legacy) notes.push("Migrates the project-first ownership manifest to the workspace-first format.");
  const manifestState = planState(workspacePaths(wsRoot).manifest);
  if (!manifestState.ok) return manifestState;
  actions.push({ path: workspacePaths(wsRoot).manifest, before: manifestState.value, after: { state: "content", content: json(next) }, description: "record updated source in the ownership manifest" });
  return success(sealPlan({ schema: "radian.install-plan/1", operation: "update", workspace: wsRoot, actions, notes, conflicts }));
}

/** Apply exactly the previewed plan. The caller supplies the hash the user reviewed. */
export function applyPlan(plan: OperationPlan, reviewedHash: string, options: { hooks?: SafeDirHooks } = {}): Outcome<{ applied: number }> {
  const { hash, ...body } = plan;
  if (hashJson(body) !== hash) return refuse("POLICY_TAMPERED", "the plan does not match its own hash");
  if (reviewedHash !== hash) return refuse("INSTALL_CONFLICT", "the reviewed plan hash does not match; preview again and review the new plan");
  pendingAnchors.add(plan.workspace);
  try {
    if (plan.actions.some((a) => !isWithin(a.path, plan.workspace) || a.path === plan.workspace)) return refuse("POLICY_TAMPERED", "the plan writes outside its workspace");
    if (readJsonIfExists(journalFile(plan.workspace)).state !== "absent") return refuse("INTERRUPTED_OPERATION", "a previous operation was interrupted", "Run recover first.");
    for (const action of plan.actions) {
      if (!sameState(fileState(action.path), action.before)) return refuse("INSTALL_CONFLICT", `${path.relative(plan.workspace, action.path)} changed since the preview; nothing was written`, "Preview again.");
    }
    if (plan.actions.length === 0) return success({ applied: 0 });
    const journaled = writeJournal(plan, []);
    if (!journaled.ok) return journaled;
    const done: number[] = [];
    for (const [index, action] of plan.actions.entries()) {
      const current = fileState(action.path);
      if (sameState(current, afterState(action.after))) {
        done.push(index);
        continue;
      }
      if (!sameState(current, action.before)) {
        return refuse("INSTALL_CONFLICT", `${path.relative(plan.workspace, action.path)} changed during the operation; stopped and journaled`, "Run recover to finish or inspect the conflict.");
      }
      const written = writeAfter(plan.workspace, action, options.hooks);
      if (!written.ok) return refuse(written.blocker.code, `${written.blocker.message}; stopped and journaled`, "Inspect the path, then run recover.");
      done.push(index);
      const progress = writeJournal(plan, done);
      if (!progress.ok) return progress;
    }
    return clearJournal(plan.workspace);
  } finally {
    pendingAnchors.delete(plan.workspace);
  }
}

function relativeTo(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function writeJournal(plan: OperationPlan, done: number[]): Outcome<{ applied: number }> {
  const written = writeFileAtomicConfined(plan.workspace, relativeTo(plan.workspace, journalFile(plan.workspace)), json({ plan, done }), { mode: 0o600, dirMode: 0o700 });
  return written.ok ? success({ applied: done.length }) : written;
}

function clearJournal(wsRoot: string): Outcome<{ applied: number }> {
  const read = readJsonIfExists(journalFile(wsRoot));
  const done = read.state === "ok" ? ((read.value as { done?: number[] }).done ?? []).length : 0;
  const removed = removeFileConfined(wsRoot, relativeTo(wsRoot, journalFile(wsRoot)));
  return removed.ok ? success({ applied: done }) : removed;
}

/** Owned workspace records are private; Pi settings files keep ordinary permissions. */
function modesFor(relative: string): { mode: number; dirMode: number } {
  return relative.startsWith(".radian/") ? { mode: 0o600, dirMode: 0o700 } : { mode: 0o644, dirMode: 0o755 };
}

function writeAfter(wsRoot: string, action: ReplaceFile, hooks: SafeDirHooks = {}): Outcome<true> {
  const relative = relativeTo(wsRoot, action.path);
  if (action.after.state === "absent") return removeFileConfined(wsRoot, relative, hooks);
  const written = writeFileAtomicConfined(wsRoot, relative, action.after.content, { ...modesFor(relative), hooks });
  return written.ok ? success(true) : written;
}

/**
 * Complete an interrupted operation: actions already at their after-state are
 * done; actions still at their before-state are applied; anything else is a
 * conflict that is reported and left for the user. Unrelated changes are never
 * rolled back.
 */
export function recover(workspaceRoot: string): Outcome<{ completed: number; conflicts: string[] }> {
  const root = canonicalWorkspace(workspaceRoot);
  if (!root.ok) return root;
  const wsRoot = root.value;
  const read = readJsonIfExists(journalFile(wsRoot));
  if (read.state === "absent") return success({ completed: 0, conflicts: [] });
  if (read.state === "corrupt") return refuse("INTERRUPTED_OPERATION", "the operation journal is unreadable; inspect it manually");
  const { plan } = read.value as { plan: OperationPlan; done: number[] };
  if (plan.workspace !== wsRoot || plan.actions.some((a) => !isWithin(a.path, wsRoot) || a.path === wsRoot)) return refuse("POLICY_TAMPERED", "the journaled plan does not belong to this workspace; inspect it manually");
  const conflicts: string[] = [];
  let completed = 0;
  pendingAnchors.add(wsRoot);
  try {
    for (const action of plan.actions) {
      const current = fileState(action.path);
      if (sameState(current, afterState(action.after))) {
        completed += 1;
        continue;
      }
      if (sameState(current, action.before)) {
        const written = writeAfter(wsRoot, action);
        if (!written.ok) {
          conflicts.push(`${relativeTo(wsRoot, action.path)}: ${written.blocker.message}; left untouched`);
          continue;
        }
        completed += 1;
        continue;
      }
      conflicts.push(`${relativeTo(wsRoot, action.path)}: neither the expected prior state nor the planned result; left untouched`);
    }
    if (conflicts.length === 0) {
      const cleared = removeFileConfined(wsRoot, relativeTo(wsRoot, journalFile(wsRoot)));
      if (!cleared.ok) conflicts.push(`journal: ${cleared.blocker.message}`);
    }
  } finally {
    pendingAnchors.delete(wsRoot);
  }
  return success({ completed, conflicts });
}

export type EntryState = "owned-unchanged" | "modified-or-missing" | "not-installed";

export interface StatusReport {
  workspace: string;
  installed: boolean;
  interrupted: boolean;
  /** The manifest predates workspace-first installation (project-first). */
  legacy: boolean;
  source?: Manifest["source"];
  workspaceEntry: EntryState;
  projects: Array<{ project: string; path: string; target?: string; exists: boolean; entry: EntryState }>;
  ownedFiles: Array<{ path: string; state: "unchanged" | "modified" | "missing" }>;
  activeRuns: string | undefined;
  sourceAvailable: boolean | "pinned";
}

function entryState(owned: OwnedEntry | undefined): EntryState {
  if (!owned) return "not-installed";
  const settings = readSettings(owned.settingsFile);
  const packages = settings.ok && settings.value && Array.isArray(settings.value.packages) ? (settings.value.packages as unknown[]) : [];
  return packages.some((x) => entryEquals(x, owned.entry)) ? "owned-unchanged" : "modified-or-missing";
}

export function status(workspaceRoot: string, probe: IdentityProbe = psProbe): Outcome<StatusReport> {
  const root = canonicalWorkspace(workspaceRoot);
  if (!root.ok) return root;
  const wsRoot = root.value;
  const ws = workspacePaths(wsRoot);
  const manifest = readManifest(wsRoot);
  const registryRead = readJsonIfExists(ws.registry);
  const registry = registryRead.state === "ok" ? (registryRead.value as WorkspaceRegistry) : undefined;
  const guard = activeRunGuard(wsRoot, probe);
  pendingAnchors.add(wsRoot);
  try {
    const report: StatusReport = {
      workspace: wsRoot,
      installed: manifest !== undefined && existsSync(path.join(wsRoot, WORKSPACE_FILE)),
      interrupted: readJsonIfExists(journalFile(wsRoot)).state !== "absent",
      legacy: manifest?.legacy === true,
      workspaceEntry: entryState(manifest?.workspaceEntry),
      projects: (registry?.projects ?? []).map((p) => {
        const owned = manifest?.settingsEntries.find((e) => e.settingsFile === path.join(p.canonicalPath, ".pi", "settings.json"));
        const out: StatusReport["projects"][number] = { project: p.project, path: p.canonicalPath, exists: existsSync(p.canonicalPath), entry: entryState(owned) };
        if (p.target) out.target = p.target;
        return out;
      }),
      ownedFiles: (manifest?.ownedFiles ?? []).map((f) => {
        const state = fileState(f.path);
        return { path: f.path, state: state.state === "absent" ? "missing" : state.state === "hash" && state.hash === f.hash ? "unchanged" : "modified" };
      }),
      activeRuns: guard.ok ? undefined : guard.blocker.message,
      sourceAvailable: manifest?.source.kind === "pinned" ? "pinned" : manifest?.source.kind === "local" ? existsSync(path.join(manifest.source.path, "package.json")) : false,
    };
    if (manifest) report.source = manifest.source;
    return success(report);
  } finally {
    pendingAnchors.delete(wsRoot);
  }
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
