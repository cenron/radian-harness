// Project creation (`/new-project`) and registration (`/add-project`) inside an
// installed workspace: previewed plans bound to a hash, applied under a
// workspace lock, journaled step by step, and recoverable without ever deleting
// a destination.
//
// New project bootstrap is deliberately minimal: an independent Git repository
// on a confirmed initial branch, a README, narrow ignore rules (only Radian's
// machine-specific direct-entry binding), and the planning location — one
// initial commit containing exactly those reviewed files. No framework,
// dependency, hook, remote, product specification, or approval is created, and
// no worker is started. Git runs as plumbing under the controlled environment
// (no global/system configuration, hooks, filters, signing, or helpers), inside
// the verified destination directory. The user's configured Git identity is
// required and never invented.
//
// Registering an existing repository validates its root, requires an explicit
// commit-backed protected target, never commits or rewrites user files, and
// preserves dirty work, history, and settings.

import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { isWithin } from "../contracts/paths.ts";
import { controlledGitEnv, gitArgv, locateGit } from "../git/exec.ts";
import { openRepository, resolveCommit, validateTarget } from "../git/repository.ts";
import type { WorkspaceRegistry } from "../state/binding.ts";
import { readJsonIfExists } from "../state/fsutil.ts";
import { canonicalJson, hashJson, sha256 } from "../util/canonical.ts";
import { type IdentityProbe, type ProcessIdentity, currentIdentity, liveness, psProbe } from "../util/process-identity.ts";
import { type SafeDirHooks, ensureDirConfined, readFileConfinedBytes, removeFileConfined, runInVerifiedDir, verifiedDirIdentity, writeFileAtomicConfined } from "../util/safe-dir.ts";
import { type Manifest, type Source, packageEntry, readManifest, stableId } from "./installer.ts";
import { workspaceAncestors, workspacePaths } from "./layout.ts";
import { loadWorkspace } from "./discovery.ts";

const O_NOFOLLOW_ANY = 0x20000000;

export interface GitIdentity {
  name: string;
  email: string;
}

export interface BootstrapFile {
  path: string;
  content: string;
}

interface PlanBase {
  workspace: string;
  workspaceId: string;
  /** Registry and manifest content the plan was computed against (stale plans are refused). */
  registryHash: string;
  manifestHash: string;
  projectId: string;
  destination: string;
  name: string;
  settingsEntry: { source: string } | undefined;
  notes: string[];
}

export interface NewProjectPlan extends PlanBase {
  schema: "radian.project-plan/1";
  operation: "new-project";
  branch: string;
  files: BootstrapFile[];
  commitMessage: string;
  identity: GitIdentity;
  hash: string;
}

export interface AddProjectPlan extends PlanBase {
  schema: "radian.project-plan/1";
  operation: "add-project";
  target: string;
  targetCommit: string;
  /** `.pi/settings.json` before the direct-entry binding is added (absent = create). */
  settingsBefore: { state: "absent" } | { state: "hash"; hash: string } | { state: "skipped"; reason: string };
  hash: string;
}

export type ProjectPlan = NewProjectPlan | AddProjectPlan;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED = new Set(["radian", "pi", "git", "node_modules", "con", "nul", "aux", "prn"]);
const IGNORE = "# Radian: the machine-specific Pi binding for direct project entry\n/.pi/settings.json\n";
const PLANNING_README = "Planning artifacts (specs, briefs, plans) for this project. Radian's coordinator writes drafts here; approvals are recorded privately in the workspace.\n";

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function fileHash(anchor: string, relative: string): Outcome<string> {
  const read = readFileConfinedBytes(anchor, relative);
  if (!read.ok) return read;
  return success(read.value === undefined ? "absent" : "sha256:" + sha256(read.value));
}

function relativeIn(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** The user's configured Git identity (global configuration), read without executing any helper. */
export function readGitIdentity(env: NodeJS.ProcessEnv = process.env): Outcome<GitIdentity> {
  const gitPath = locateGit();
  if (!gitPath) return refuse("PREREQUISITE_MISSING", "Git was not found");
  const home = env.HOME ?? os.homedir();
  const read = (key: string): string | undefined => {
    const result = spawnSync(gitPath, gitArgv(["config", "--global", "--get", key]), {
      cwd: os.tmpdir(),
      env: { ...controlledGitEnv(), HOME: home, GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL ?? path.join(home, ".gitconfig"), ...(env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } : {}) },
      encoding: "utf8",
      timeout: 5000,
    });
    return result.status === 0 ? result.stdout.trim() || undefined : undefined;
  };
  const name = read("user.name");
  const email = read("user.email");
  if (!name || !email) return refuse("GIT_IDENTITY_MISSING", "Git user.name/user.email is not configured; Radian will not invent a commit identity", "Configure your Git identity yourself (git config --global user.name/user.email), then try again.");
  return success({ name, email });
}

interface Context {
  root: string;
  id: string;
  registry: WorkspaceRegistry;
  registryHash: string;
  manifest: Manifest;
  manifestHash: string;
}

function workspaceContext(workspaceRoot: string): Outcome<Context> {
  const loaded = loadWorkspace(workspaceRoot);
  if (!loaded.ok) return refuse(loaded.blocker.code, loaded.blocker.message);
  const ws = workspacePaths(workspaceRoot);
  if (readJsonIfExists(path.join(ws.journal, "operation.json")).state !== "absent" || readJsonIfExists(journalFile(workspaceRoot)).state !== "absent") return refuse("INTERRUPTED_OPERATION", "a previous workspace operation was interrupted", "Recover it first (/new-project --recover, or the installer's recover).");
  const manifest = readManifest(workspaceRoot);
  if (!manifest) return refuse("INSTALL_TARGET_INVALID", "the workspace has no ownership manifest");
  if (manifest.legacy) return refuse("INSTALL_CONFLICT", "the workspace still has a project-first manifest", "Preview and apply the installer's install command to migrate it first.");
  const registryHash = fileHash(workspaceRoot, relativeIn(workspaceRoot, ws.registry));
  const manifestHash = fileHash(workspaceRoot, relativeIn(workspaceRoot, ws.manifest));
  if (!registryHash.ok) return registryHash;
  if (!manifestHash.ok) return manifestHash;
  const registry = JSON.parse(readFileSync(ws.registry, "utf8")) as WorkspaceRegistry;
  return success({ root: workspaceRoot, id: loaded.value.id, registry, registryHash: registryHash.value, manifest, manifestHash: manifestHash.value });
}

function harnessRoot(manifest: Manifest): string | undefined {
  if (manifest.source.kind !== "local") return undefined;
  try {
    return realpathSync(manifest.source.path);
  } catch {
    return undefined;
  }
}

function settingsEntryFor(manifest: Manifest, projectRoot: string): Outcome<{ source: string }> {
  const source: Source = manifest.source.kind === "local" ? { kind: "local", path: manifest.source.path } : { kind: "pinned", spec: manifest.source.spec };
  const entry = packageEntry(source, projectRoot);
  return entry.ok ? success({ source: entry.value }) : entry;
}

function seal<T extends { hash: string }>(plan: Omit<T, "hash">): T {
  return { ...plan, hash: hashJson(plan) } as T;
}

/** Plan a new minimal Git + Radian project. Writes nothing. */
export function planNewProject(workspaceRoot: string, name: string, options: { branch?: string; identity?: () => Outcome<GitIdentity> } = {}): Outcome<NewProjectPlan> {
  const context = workspaceContext(workspaceRoot);
  if (!context.ok) return context;
  const c = context.value;
  if (!NAME.test(name) || RESERVED.has(name.toLowerCase())) return refuse("PATH_INVALID", "project names use letters, digits, '.', '_', or '-', start with a letter or digit, and are not reserved", "Choose another name.");
  const destination = path.join(c.root, name);
  // macOS volumes are usually case-insensitive: compare names case-insensitively.
  const existing = readdirSync(c.root).find((entry) => entry.toLowerCase() === name.toLowerCase());
  if (existing) return refuse("INSTALL_CONFLICT", `${existing} already exists in the workspace; Radian never overwrites it`, "Register an existing repository with /add-project, or choose another name.");
  const harness = harnessRoot(c.manifest);
  if (harness && (isWithin(destination, harness) || isWithin(harness, destination))) return refuse("INSTALL_TARGET_INVALID", "the destination overlaps the Radian harness source");
  if (c.registry.projects.some((p) => isWithin(destination, p.canonicalPath) || isWithin(p.canonicalPath, destination))) return refuse("INSTALL_TARGET_INVALID", "the destination overlaps a registered project");
  const branch = options.branch ?? "main";
  const target = validateTarget({ ref: `refs/heads/${branch}` });
  if (!target.ok || /^-|\.\.|[\s~^:?*[\\]|\.lock$|\/$|^\/|@\{/.test(branch)) return refuse("CONFIG_INVALID", `${branch} is not a valid branch name`);
  const identity = (options.identity ?? readGitIdentity)();
  if (!identity.ok) return identity;
  const entry = settingsEntryFor(c.manifest, destination);
  if (!entry.ok) return entry;
  const files: BootstrapFile[] = [
    { path: ".gitignore", content: IGNORE },
    { path: "README.md", content: `# ${name}\n` },
    { path: ".radian/planning/README.md", content: PLANNING_README },
  ];
  return success(seal<NewProjectPlan>({
    schema: "radian.project-plan/1",
    operation: "new-project",
    workspace: c.root,
    workspaceId: c.id,
    registryHash: c.registryHash,
    manifestHash: c.manifestHash,
    projectId: stableId("prj", destination),
    destination,
    name,
    branch,
    files,
    commitMessage: `Initial ${name} project (created by Radian)`,
    identity: identity.value,
    settingsEntry: entry.value,
    notes: [
      `Creates ${name}/ with a new Git repository on branch ${branch}${options.branch ? "" : " (the default; pass --branch to choose another)"}.`,
      `Initial commit by ${identity.value.name} contains exactly: ${files.map((f) => f.path).join(", ")}.`,
      "Adds the ignored direct-entry binding .pi/settings.json and registers the project with protected target refs/heads/" + branch + ".",
      "No dependencies, frameworks, hooks, remotes, specifications, approvals, or workers.",
    ],
  }));
}

/** Plan registration of an existing repository with an explicit protected target. Writes nothing. */
export async function planAddProject(workspaceRoot: string, input: string, target: string | undefined): Promise<Outcome<AddProjectPlan>> {
  const context = workspaceContext(workspaceRoot);
  if (!context.ok) return context;
  const c = context.value;
  let canonical: string;
  try {
    canonical = realpathSync(path.resolve(c.root, input));
  } catch {
    return refuse("INSTALL_TARGET_INVALID", "the path does not exist");
  }
  if (!isWithin(canonical, c.root) || canonical === c.root) return refuse("INSTALL_TARGET_INVALID", "projects must be repositories inside the workspace folder");
  if (isWithin(canonical, path.join(c.root, ".radian"))) return refuse("INSTALL_TARGET_INVALID", "Radian's private state cannot be a project");
  const harness = harnessRoot(c.manifest);
  if (harness && (isWithin(canonical, harness) || isWithin(harness, canonical))) return refuse("INSTALL_TARGET_INVALID", "the Radian harness source cannot be registered as a project");
  if (workspaceAncestors(canonical).some((a) => a !== c.root)) return refuse("DUPLICATE_BINDING", "the repository is inside another Radian workspace");
  if (c.registry.projects.some((p) => p.canonicalPath === canonical)) return refuse("DUPLICATE_BINDING", "the repository is already registered");
  if (c.registry.projects.some((p) => isWithin(canonical, p.canonicalPath) || isWithin(p.canonicalPath, canonical))) return refuse("INSTALL_TARGET_INVALID", "registered projects cannot be nested inside each other");
  const repo = await openRepository(canonical);
  if (!repo.ok) return refuse("INSTALL_TARGET_INVALID", "the path is not a Git working tree");
  if (repo.value.root !== canonical) return refuse("INSTALL_TARGET_INVALID", "register the repository root explicitly, not a subdirectory");
  if (!target) return refuse("CONFIG_INVALID", "an explicit protected target branch is required", "Pass --target refs/heads/<branch>; Radian never assumes main for an existing repository.");
  const validated = validateTarget({ ref: target });
  if (!validated.ok) return validated;
  const commit = await resolveCommit(repo.value, validated.value.ref);
  if (!commit.ok) return refuse("INSTALL_TARGET_INVALID", `target ${target} has no commit (an unborn or missing branch cannot be protected)`, "Commit to it yourself first, or choose a commit-backed branch.");
  const entry = settingsEntryFor(c.manifest, canonical);
  if (!entry.ok) return entry;
  // The direct-entry binding is added to .pi/settings.json unless that file is tracked (then it would dirty the user's repository).
  const tracked = spawnSync(repo.value.ctx.gitPath, gitArgv(["ls-files", "--error-unmatch", "--", ".pi/settings.json"]), { cwd: canonical, env: controlledGitEnv(), encoding: "utf8", timeout: 10_000 }).status === 0;
  let settingsBefore: AddProjectPlan["settingsBefore"];
  const notes = [`Registers ${relativeIn(c.root, canonical)} with protected target ${validated.value.ref} at ${commit.value.slice(0, 12)}. Nothing is committed; dirty work, history, and settings are preserved.`];
  if (tracked) {
    settingsBefore = { state: "skipped", reason: ".pi/settings.json is tracked in the repository" };
    notes.push("Direct-entry binding not written because .pi/settings.json is tracked; add Radian's package entry yourself if you want direct entry.");
  } else {
    const before = fileHash(c.root, relativeIn(c.root, path.join(canonical, ".pi", "settings.json")));
    if (!before.ok) return refuse("INSTALL_TARGET_INVALID", `.pi/settings.json cannot be read safely: ${before.blocker.message}`);
    settingsBefore = before.value === "absent" ? { state: "absent" } : { state: "hash", hash: before.value };
    notes.push("Adds Radian's package entry to the untracked .pi/settings.json for direct entry (other settings are kept).");
  }
  return success(seal<AddProjectPlan>({
    schema: "radian.project-plan/1",
    operation: "add-project",
    workspace: c.root,
    workspaceId: c.id,
    registryHash: c.registryHash,
    manifestHash: c.manifestHash,
    projectId: stableId("prj", canonical),
    destination: canonical,
    name: relativeIn(c.root, canonical),
    target: validated.value.ref,
    targetCommit: commit.value,
    settingsBefore,
    settingsEntry: settingsBefore.state === "skipped" ? undefined : entry.value,
    notes,
  }));
}

export function renderProjectPlan(plan: ProjectPlan): string {
  const lines = plan.operation === "new-project"
    ? [`Create project ${plan.name} at ${plan.destination}`, `Initial branch: ${plan.branch}`, `Commit identity: ${plan.identity.name} <${plan.identity.email}>`, "Initial commit files:", ...plan.files.map((f) => `  ${f.path}`)]
    : [`Register existing repository ${plan.name}`, `Protected target: ${plan.target} (${plan.targetCommit.slice(0, 12)})`];
  return [...lines, ...plan.notes.map((n) => `- ${n}`), `Plan hash: ${plan.hash.slice(0, 19)}…`].join("\n");
}

// --- Serialization and journal -------------------------------------------------

interface LockRecord {
  owner: ProcessIdentity;
  operation: string;
}

function journalFile(workspaceRoot: string): string {
  return path.join(workspacePaths(workspaceRoot).journal, "project-operation.json");
}

function lockFile(workspaceRoot: string): string {
  return path.join(workspacePaths(workspaceRoot).state, "locks", "projects.lock");
}

/** Locks this process holds right now (a lock it left behind after a failed release is stale). */
const heldLocks = new Set<string>();

/** A workspace-wide lock for project operations: an exclusive file created through a link-free path. */
export async function withProjectLock<T>(workspaceRoot: string, operation: string, fn: () => Promise<Outcome<T>>, probe: IdentityProbe = psProbe): Promise<Outcome<T>> {
  const self = currentIdentity(probe);
  if (!self) return refuse("CONTEXT_LOCKED", "this process's identity cannot be verified");
  const dir = ensureDirConfined(workspaceRoot, relativeIn(workspaceRoot, path.dirname(lockFile(workspaceRoot))), 0o700);
  if (!dir.ok) return dir;
  const file = lockFile(workspaceRoot);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW_ANY, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return refuse("CONTEXT_LOCKED", "the project-operation lock cannot be created safely");
      const held = readJsonIfExists(file);
      const owner = held.state === "ok" ? (held.value as Partial<LockRecord>).owner : undefined;
      const ownStale = owner !== undefined && owner.pid === self.pid && owner.start === self.start && !heldLocks.has(file);
      if (!owner || (!ownStale && liveness(owner, probe) !== "dead")) return refuse("CONTEXT_LOCKED", "another project operation is in progress", "Wait for it to finish; Radian never breaks a lock it cannot prove abandoned.");
      const removed = removeFileConfined(workspaceRoot, relativeIn(workspaceRoot, file));
      if (!removed.ok) return removed;
      continue;
    }
    try {
      writeSync(fd, JSON.stringify({ owner: self, operation } satisfies LockRecord));
    } finally {
      closeSync(fd);
    }
    heldLocks.add(file);
    try {
      return await fn();
    } finally {
      heldLocks.delete(file);
      removeFileConfined(workspaceRoot, relativeIn(workspaceRoot, file));
    }
  }
  return refuse("CONTEXT_LOCKED", "the project-operation lock could not be acquired");
}

type Step = "destination" | "files" | "repository" | "commit" | "binding" | "registry" | "manifest";

interface Journal {
  schema: "radian.project-journal/1";
  id: string;
  owner: ProcessIdentity | undefined;
  plan: ProjectPlan;
  done: Step[];
  destinationIdentity?: { dev: string; ino: string };
  commit?: string;
}

function writeJournal(journal: Journal): Outcome<true> {
  const written = writeFileAtomicConfined(journal.plan.workspace, relativeIn(journal.plan.workspace, journalFile(journal.plan.workspace)), json(journal), { mode: 0o600, dirMode: 0o700 });
  return written.ok ? success(true) : written;
}

function stepDone(journal: Journal, step: Step): Outcome<true> {
  journal.done.push(step);
  return writeJournal(journal);
}

// --- Apply ---------------------------------------------------------------------

export interface ApplyOptions {
  hooks?: SafeDirHooks;
  /** Test seam: called after a step is journaled; returning false simulates an interruption there. */
  afterStep?: (step: Step) => boolean;
  probe?: IdentityProbe;
}

export interface ProjectResult {
  projectId: string;
  destination: string;
  name: string;
  target: string;
  commit: string | undefined;
}

function git(journal: Journal, args: string[], extraEnv: Record<string, string> = {}, input?: string): Outcome<string> {
  const gitPath = locateGit();
  if (!gitPath) return refuse("PREREQUISITE_MISSING", "Git was not found");
  const op = { op: "spawn" as const, file: gitPath, argv: gitArgv(args), env: controlledGitEnv(extraEnv), ...(input !== undefined ? { input } : {}) };
  const ran = runInVerifiedDir(journal.plan.destination, [op], {}, journal.destinationIdentity);
  return ran.ok ? success(ran.value[0]?.stdout ?? "") : ran;
}

function identityEnv(identity: GitIdentity): Record<string, string> {
  return { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email };
}

/** The exact tree the plan's bootstrap files produce: paths and blob contents. */
function expectedTree(plan: NewProjectPlan, journal: Journal): Outcome<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of plan.files) {
    const hashed = git(journal, ["hash-object", "--stdin"], {}, f.content);
    if (!hashed.ok) return hashed;
    out.set(f.path, hashed.value.trim());
  }
  return success(out);
}

function runSteps(journal: Journal, options: ApplyOptions): Outcome<ProjectResult> {
  const plan = journal.plan;
  const ws = plan.workspace;
  const has = (step: Step) => journal.done.includes(step);
  const interrupted = (step: Step) => options.afterStep && !options.afterStep(step);
  const fail = (o: { ok: false; blocker: { code: string; message: string } }, step: Step): Outcome<ProjectResult> => refuse(o.blocker.code as never, `${step}: ${o.blocker.message}; the operation is journaled and the destination is preserved`, "Inspect it, then run /new-project --recover.");

  if (plan.operation === "new-project") {
    if (!has("destination")) {
      // Create only a new destination, through the verified workspace root (never through a link).
      if (existsSync(plan.destination)) return refuse("INSTALL_CONFLICT", `${plan.name} appeared before creation; nothing was changed`);
      const made = ensureDirConfined(ws, plan.name, 0o755, options.hooks ?? {});
      if (!made.ok) return fail(made, "destination");
      const id = verifiedDirIdentity(plan.destination);
      if (!id.ok) return fail(id, "destination");
      journal.destinationIdentity = id.value;
      const recorded = stepDone(journal, "destination");
      if (!recorded.ok) return fail(recorded, "destination");
      if (interrupted("destination")) return refuse("INTERRUPTED_OPERATION", "interrupted after creating the destination");
    }
    if (!has("files")) {
      for (const f of plan.files) {
        const existing = readFileConfinedBytes(plan.destination, f.path);
        if (!existing.ok) return fail(existing, "files");
        if (existing.value !== undefined && existing.value.toString("utf8") !== f.content) return refuse("WORK_UNPRESERVED", `${f.path} was edited before the bootstrap finished; it is preserved and nothing was committed`, "Commit it yourself, or remove your edit and recover.");
        if (existing.value === undefined) {
          const written = writeFileAtomicConfined(ws, `${plan.name}/${f.path}`, f.content, { mode: 0o644, dirMode: 0o755, ...(options.hooks ? { hooks: options.hooks } : {}) });
          if (!written.ok) return fail(written, "files");
        }
      }
      const recorded = stepDone(journal, "files");
      if (!recorded.ok) return fail(recorded, "files");
      if (interrupted("files")) return refuse("INTERRUPTED_OPERATION", "interrupted after writing bootstrap files");
    }
    if (!has("repository")) {
      if (!existsSync(path.join(plan.destination, ".git"))) {
        const init = git(journal, ["init", "-q", "--template=", `--initial-branch=${plan.branch}`]);
        if (!init.ok) return fail(init, "repository");
      }
      const recorded = stepDone(journal, "repository");
      if (!recorded.ok) return fail(recorded, "repository");
      if (interrupted("repository")) return refuse("INTERRUPTED_OPERATION", "interrupted after creating the repository");
    }
    if (!has("commit")) {
      const head = git(journal, ["rev-parse", "--verify", "--quiet", `refs/heads/${plan.branch}`]);
      if (head.ok && head.value.trim()) {
        journal.commit = head.value.trim();
      } else {
        // Only the reviewed files, byte for byte: their blobs are hashed from the plan and compared with the working files.
        const expected = expectedTree(plan, journal);
        if (!expected.ok) return fail(expected, "commit");
        for (const f of plan.files) {
          const current = readFileConfinedBytes(plan.destination, f.path);
          if (!current.ok || current.value?.toString("utf8") !== f.content) return refuse("WORK_UNPRESERVED", `${f.path} changed before the initial commit; it is preserved and nothing was committed`, "Commit it yourself, or restore the reviewed content and recover.");
        }
        const add = git(journal, ["add", "--", ...plan.files.map((f) => f.path)]);
        if (!add.ok) return fail(add, "commit");
        const tree = git(journal, ["write-tree"]);
        if (!tree.ok) return fail(tree, "commit");
        const listed = git(journal, ["ls-tree", "-r", "-z", tree.value.trim()]);
        if (!listed.ok) return fail(listed, "commit");
        const entries = listed.value.split("\0").filter(Boolean).map((line) => {
          const [meta, file] = line.split("\t");
          return { file: file!, blob: meta!.split(" ")[2]! };
        });
        if (entries.length !== expected.value.size || entries.some((e) => expected.value.get(e.file) !== e.blob)) return refuse("CANDIDATE_MISMATCH", "the staged tree is not exactly the reviewed bootstrap files; nothing was committed");
        const commit = git(journal, ["commit-tree", tree.value.trim(), "-F", "-"], identityEnv(plan.identity), plan.commitMessage + "\n");
        if (!commit.ok) return fail(commit, "commit");
        const updated = git(journal, ["update-ref", `refs/heads/${plan.branch}`, commit.value.trim(), "0".repeat(commit.value.trim().length)]);
        if (!updated.ok) return fail(updated, "commit");
        journal.commit = commit.value.trim();
      }
      const recorded = stepDone(journal, "commit");
      if (!recorded.ok) return fail(recorded, "commit");
      if (interrupted("commit")) return refuse("INTERRUPTED_OPERATION", "interrupted after the initial commit");
    }
  }

  if (!has("binding")) {
    if (plan.settingsEntry) {
      const rel = `${relativeIn(ws, plan.destination)}/.pi/settings.json`;
      const current = readFileConfinedBytes(ws, rel);
      if (!current.ok) return fail(current, "binding");
      let settings: Record<string, unknown> = {};
      if (current.value !== undefined) {
        const before = "sha256:" + sha256(current.value);
        if (plan.operation === "add-project" && plan.settingsBefore.state === "hash" && plan.settingsBefore.hash !== before && !journal.done.includes("binding")) return refuse("INSTALL_CONFLICT", ".pi/settings.json changed since the preview; nothing was written", "Preview again.");
        try {
          settings = JSON.parse(current.value.toString("utf8")) as Record<string, unknown>;
        } catch {
          return refuse("INSTALL_CONFLICT", ".pi/settings.json is not valid JSON; left untouched");
        }
      }
      const packages = Array.isArray(settings.packages) ? (settings.packages as unknown[]) : [];
      if (!packages.some((p) => canonicalJson(p) === canonicalJson(plan.settingsEntry))) {
        const written = writeFileAtomicConfined(ws, rel, json({ ...settings, packages: [...packages, plan.settingsEntry] }), { mode: 0o644, dirMode: 0o755 });
        if (!written.ok) return fail(written, "binding");
      }
    }
    const recorded = stepDone(journal, "binding");
    if (!recorded.ok) return fail(recorded, "binding");
    if (interrupted("binding")) return refuse("INTERRUPTED_OPERATION", "interrupted after writing the direct-entry binding");
  }

  const target = plan.operation === "new-project" ? `refs/heads/${plan.branch}` : plan.target;
  const wsPaths = workspacePaths(ws);
  if (!has("registry")) {
    const registry = JSON.parse(readFileSync(wsPaths.registry, "utf8")) as WorkspaceRegistry;
    if (!registry.projects.some((p) => p.project === plan.projectId)) {
      registry.projects.push({ project: plan.projectId, canonicalPath: plan.destination, target });
      const written = writeFileAtomicConfined(ws, relativeIn(ws, wsPaths.registry), json(registry), { mode: 0o600, dirMode: 0o700 });
      if (!written.ok) return fail(written, "registry");
    }
    const recorded = stepDone(journal, "registry");
    if (!recorded.ok) return fail(recorded, "registry");
    if (interrupted("registry")) return refuse("INTERRUPTED_OPERATION", "interrupted after registration");
  }
  if (!has("manifest")) {
    const manifest = readManifest(ws);
    if (!manifest || manifest.legacy) return refuse("INSTALL_CONFLICT", "the ownership manifest changed during the operation");
    const registryState = readFileConfinedBytes(ws, relativeIn(ws, wsPaths.registry));
    if (!registryState.ok || !registryState.value) return fail(registryState.ok ? refuse("STATE_CORRUPT", "registry missing") as never : registryState, "manifest");
    const settingsFile = path.join(plan.destination, ".pi", "settings.json");
    const next: Manifest = {
      ...manifest,
      ownedFiles: manifest.ownedFiles.map((f) => (f.path === wsPaths.registry ? { ...f, hash: "sha256:" + sha256(registryState.value!) } : f)),
      settingsEntries: plan.settingsEntry && !manifest.settingsEntries.some((e) => e.settingsFile === settingsFile) ? [...manifest.settingsEntries, { settingsFile, entry: plan.settingsEntry, createdFile: plan.operation === "new-project" || (plan.operation === "add-project" && plan.settingsBefore.state === "absent") }] : manifest.settingsEntries,
      projects: manifest.projects.some((p) => p.project === plan.projectId) ? manifest.projects : [...manifest.projects, { project: plan.projectId, canonicalPath: plan.destination, target }],
    };
    delete (next as { legacy?: true }).legacy;
    const written = writeFileAtomicConfined(ws, relativeIn(ws, wsPaths.manifest), json(next), { mode: 0o600, dirMode: 0o700 });
    if (!written.ok) return fail(written, "manifest");
    const recorded = stepDone(journal, "manifest");
    if (!recorded.ok) return fail(recorded, "manifest");
  }
  const cleared = removeFileConfined(ws, relativeIn(ws, journalFile(ws)));
  if (!cleared.ok) return fail(cleared, "manifest");
  return success({ projectId: plan.projectId, destination: plan.destination, name: plan.name, target, commit: plan.operation === "new-project" ? journal.commit : plan.targetCommit });
}

/** Apply exactly the reviewed plan; stale plans (registry, manifest, destination) are refused before any write. */
export async function applyProjectPlan(plan: ProjectPlan, reviewedHash: string, options: ApplyOptions = {}): Promise<Outcome<ProjectResult>> {
  const { hash, ...body } = plan;
  if (hashJson(body) !== hash) return refuse("POLICY_TAMPERED", "the plan does not match its own hash");
  if (reviewedHash !== hash) return refuse("INSTALL_CONFLICT", "the reviewed plan hash does not match; preview again");
  return withProjectLock(plan.workspace, plan.operation, async () => {
    const context = workspaceContext(plan.workspace);
    if (!context.ok) return context;
    if (context.value.id !== plan.workspaceId || context.value.registryHash !== plan.registryHash || context.value.manifestHash !== plan.manifestHash) return refuse("INSTALL_CONFLICT", "the workspace changed since the preview (another project operation?); nothing was written", "Preview again.");
    if (plan.operation === "new-project" && existsSync(plan.destination)) return refuse("INSTALL_CONFLICT", `${plan.name} already exists; nothing was written`);
    const journal: Journal = { schema: "radian.project-journal/1", id: `op_${randomUUID()}`, owner: currentIdentity(options.probe ?? psProbe), plan, done: [] };
    const started = writeJournal(journal);
    if (!started.ok) return started;
    return runSteps(journal, options);
  }, options.probe ?? psProbe);
}

/**
 * Finish an interrupted project operation from its journal: completed steps
 * are skipped, remaining steps are re-validated and applied. User edits are
 * preserved and reported; a destination is never deleted.
 */
export async function recoverProjectOperation(workspaceRoot: string, options: ApplyOptions = {}): Promise<Outcome<ProjectResult | undefined>> {
  const read = readJsonIfExists(journalFile(workspaceRoot));
  if (read.state === "absent") return success(undefined);
  if (read.state === "corrupt") return refuse("INTERRUPTED_OPERATION", "the project-operation journal is unreadable; inspect it manually");
  const journal = read.value as Journal;
  if (journal.schema !== "radian.project-journal/1" || journal.plan.workspace !== workspaceRoot) return refuse("POLICY_TAMPERED", "the project-operation journal does not belong to this workspace");
  const { hash, ...body } = journal.plan;
  if (hashJson(body) !== hash) return refuse("POLICY_TAMPERED", "the journaled plan does not match its hash");
  if (journal.owner && liveness(journal.owner, options.probe ?? psProbe) !== "dead" && !(journal.owner.pid === process.pid)) return refuse("CONTEXT_LOCKED", "the interrupted operation's process is still alive");
  return withProjectLock(workspaceRoot, "recover", async () => {
    if (journal.plan.operation === "new-project" && journal.done.includes("destination")) {
      const id = verifiedDirIdentity(journal.plan.destination);
      if (!id.ok || !journal.destinationIdentity || id.value.dev !== journal.destinationIdentity.dev || id.value.ino !== journal.destinationIdentity.ino) return refuse("OWNERSHIP_AMBIGUOUS", "the destination is no longer the directory Radian created; it is left untouched", "Inspect it; Radian never deletes or reuses a directory it cannot prove it owns.");
    }
    return runSteps(journal, options);
  }, options.probe ?? psProbe);
}

/** A pending interrupted project operation, if any (for status and refusal messages). */
export function interruptedProjectOperation(workspaceRoot: string): string | undefined {
  const read = readJsonIfExists(journalFile(workspaceRoot));
  if (read.state === "absent") return undefined;
  if (read.state === "corrupt") return "unreadable journal";
  const j = read.value as Journal;
  return `${j.plan.operation} ${j.plan.name} (completed: ${j.done.join(", ") || "nothing"})`;
}

/** True when `fd`-level inspection confirms a regular file (used by tests). */
export function isRegularFile(file: string): boolean {
  try {
    const fd = openSync(file, constants.O_RDONLY | O_NOFOLLOW_ANY);
    try {
      return fstatSync(fd).isFile();
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}
