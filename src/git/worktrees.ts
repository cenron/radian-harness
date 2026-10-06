// Owned worktree allocation, exclusive mutable ownership, identity validation,
// and conservative cleanup. Worktrees separate changes; they are not sandboxes.
// Retiring execution is separate from deleting a worktree: only provably owned,
// clean, integrated work with preserved evidence is removable.

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { newId, type Role } from "../contracts/identity.ts";
import { isWithin } from "../contracts/paths.ts";
import { type Clock, iso, systemClock } from "../util/clock.ts";
import { succeeded } from "../util/proc.ts";
import { atomicWriteJson, ensureDir, readJsonIfExists, withLock } from "../state/fsutil.ts";
import { git, gitText } from "./exec.ts";
import { type Repository, isClean, resolveCommit } from "./repository.ts";

export type WorktreePurpose = "assignment" | "candidate-check" | "integration";

export interface WorktreeRecord {
  id: string;
  path: string;
  purpose: WorktreePurpose;
  task: string;
  assignment?: string;
  role?: Role;
  base: string;
  createdAt: string;
  owner: { attempt: string; generation: number } | null;
  executionRetired: boolean;
  /** Commits delivered from this worktree (controlled delivery). */
  delivered: string[];
  state: "active" | "preserved" | "removed";
}

interface Manifest {
  schema: "radian.worktrees/1";
  worktrees: WorktreeRecord[];
}

export type CleanupClass =
  | { removable: true }
  | { removable: false; reason: "execution-not-retired" | "dirty" | "unintegrated" | "ownership-ambiguous" | "evidence-not-preserved" | "no-integrated-delivery" };

export class WorktreeManager {
  readonly repo: Repository;
  private readonly stateDir: string;
  private readonly root: string;
  private readonly clock: Clock;

  /**
   * @param stateDir protected coordinator state directory (manifest lives here)
   * @param worktreeRoot directory outside the project tree where owned worktrees are created
   */
  constructor(repo: Repository, stateDir: string, worktreeRoot: string, clock: Clock = systemClock) {
    this.repo = repo;
    this.stateDir = stateDir;
    this.root = worktreeRoot;
    this.clock = clock;
  }

  private manifestFile(): string {
    return path.join(this.stateDir, "worktrees.json");
  }

  private locked<T>(fn: (manifest: Manifest) => Promise<T> | T): Promise<T> {
    return withLock(path.join(this.stateDir, "locks", "worktrees"), "worktree manifest", () => {
      const read = readJsonIfExists(this.manifestFile());
      if (read.state === "corrupt") throw new Error("worktree manifest is unreadable");
      const manifest: Manifest = read.state === "ok" ? (read.value as Manifest) : { schema: "radian.worktrees/1", worktrees: [] };
      return fn(manifest);
    });
  }

  private save(manifest: Manifest): void {
    atomicWriteJson(this.manifestFile(), manifest);
  }

  async list(): Promise<WorktreeRecord[]> {
    return this.locked((m) => m.worktrees.map((w) => ({ ...w })));
  }

  async get(id: string): Promise<WorktreeRecord | undefined> {
    return this.locked((m) => m.worktrees.find((w) => w.id === id));
  }

  async allocate(input: { purpose: WorktreePurpose; task: string; assignment?: string; role?: Role; base: string }): Promise<Outcome<WorktreeRecord>> {
    const base = await resolveCommit(this.repo, input.base);
    if (!base.ok) return base;
    if (base.value !== input.base) return refuse("PATCH_BASE_MISMATCH", "base must be an exact commit id");
    ensureDir(this.root);
    let rootReal: string;
    try {
      rootReal = realpathSync(this.root);
    } catch {
      return refuse("PATH_INVALID", "worktree root cannot be resolved");
    }
    if (isWithin(rootReal, this.repo.root) || isWithin(rootReal, this.repo.commonDir)) {
      return refuse("PATH_OUTSIDE_SCOPE", "owned worktrees must live outside the project checkout and Git directory");
    }
    const id = newId("wt");
    const wtPath = path.join(rootReal, id);
    return this.locked(async (manifest) => {
      if (input.assignment && manifest.worktrees.some((w) => w.assignment === input.assignment && w.state === "active")) {
        return refuse("OWNERSHIP_AMBIGUOUS", "assignment already owns an active worktree");
      }
      const added = await git(this.repo.ctx, ["worktree", "add", "--detach", "--", wtPath, base.value]);
      if (!succeeded(added)) return refuse("GIT_FAILURE", "worktree creation failed");
      const record: WorktreeRecord = {
        id,
        path: wtPath,
        purpose: input.purpose,
        task: input.task,
        base: base.value,
        createdAt: iso(this.clock.now()),
        owner: null,
        executionRetired: false,
        delivered: [],
        state: "active",
      };
      if (input.assignment) record.assignment = input.assignment;
      if (input.role) record.role = input.role;
      manifest.worktrees.push(record);
      this.save(manifest);
      return success({ ...record });
    });
  }

  /** Give one attempt exclusive mutable ownership; a previous unretired owner blocks. */
  async claim(id: string, attempt: string, generation: number): Promise<Outcome<WorktreeRecord>> {
    return this.locked((manifest) => {
      const record = manifest.worktrees.find((w) => w.id === id);
      if (!record || record.state !== "active") return refuse("OWNERSHIP_AMBIGUOUS", "worktree is not active");
      if (record.owner && record.owner.attempt !== attempt && !record.executionRetired) {
        return refuse("OWNERSHIP_AMBIGUOUS", "worktree is owned by another unretired attempt", "Verify and retire the previous attempt first.");
      }
      if (record.owner && record.owner.generation > generation) return refuse("STALE_GENERATION", "a newer generation owns this worktree");
      record.owner = { attempt, generation };
      record.executionRetired = false;
      this.save(manifest);
      return success({ ...record });
    });
  }

  async markRetired(id: string, attempt: string): Promise<Outcome<WorktreeRecord>> {
    return this.locked((manifest) => {
      const record = manifest.worktrees.find((w) => w.id === id);
      if (!record) return refuse("OWNERSHIP_AMBIGUOUS", "unknown worktree");
      if (!record.owner || record.owner.attempt !== attempt) return refuse("OWNERSHIP_AMBIGUOUS", "attempt does not own this worktree");
      record.executionRetired = true;
      this.save(manifest);
      return success({ ...record });
    });
  }

  async recordDelivery(id: string, commit: string): Promise<void> {
    await this.locked((manifest) => {
      const record = manifest.worktrees.find((w) => w.id === id);
      if (record && !record.delivered.includes(commit)) {
        record.delivered.push(commit);
        this.save(manifest);
      }
    });
  }

  /** Verify the worktree on disk is the owned one: path, Git pointer, top-level. */
  async validate(record: WorktreeRecord): Promise<Outcome<true>> {
    let real: string;
    try {
      real = realpathSync(record.path);
    } catch {
      return refuse("OWNERSHIP_AMBIGUOUS", "worktree path is missing");
    }
    if (real !== record.path) return refuse("OWNERSHIP_AMBIGUOUS", "worktree path resolves elsewhere");
    let pointer: string;
    try {
      pointer = readFileSync(path.join(real, ".git"), "utf8").trim();
    } catch {
      return refuse("OWNERSHIP_AMBIGUOUS", "worktree Git pointer is missing");
    }
    const match = /^gitdir: (.+)$/.exec(pointer);
    if (!match?.[1]) return refuse("POLICY_TAMPERED", "worktree Git pointer is malformed");
    let gitdir: string;
    try {
      gitdir = realpathSync(path.resolve(real, match[1]));
    } catch {
      return refuse("POLICY_TAMPERED", "worktree Git pointer does not resolve");
    }
    if (!isWithin(gitdir, path.join(this.repo.commonDir, "worktrees")) || gitdir === path.join(this.repo.commonDir, "worktrees")) {
      return refuse("POLICY_TAMPERED", "worktree Git pointer does not point into this repository");
    }
    try {
      const top = realpathSync(await gitText({ ...this.repo.ctx, cwd: real }, ["rev-parse", "--show-toplevel"]));
      if (top !== real) return refuse("OWNERSHIP_AMBIGUOUS", "worktree top-level mismatch");
    } catch {
      return refuse("OWNERSHIP_AMBIGUOUS", "worktree is not a valid checkout");
    }
    return success(true);
  }

  async classify(record: WorktreeRecord, integrated: (commit: string) => Promise<boolean>, evidencePreserved: boolean): Promise<CleanupClass> {
    if (!record.executionRetired) return { removable: false, reason: "execution-not-retired" };
    const valid = await this.validate(record);
    if (!valid.ok) return { removable: false, reason: "ownership-ambiguous" };
    const clean = await isClean({ ...this.repo.ctx, cwd: record.path });
    if (!clean.ok) return { removable: false, reason: "ownership-ambiguous" };
    if (!clean.value) return { removable: false, reason: "dirty" };
    if (record.delivered.length === 0) return { removable: false, reason: "no-integrated-delivery" };
    for (const commit of record.delivered) if (!(await integrated(commit))) return { removable: false, reason: "unintegrated" };
    if (!evidencePreserved) return { removable: false, reason: "evidence-not-preserved" };
    return { removable: true };
  }

  /** Remove only a removable worktree, without --force; anything else is preserved and reported. */
  async remove(id: string, integrated: (commit: string) => Promise<boolean>, evidencePreserved: boolean): Promise<Outcome<CleanupClass>> {
    return this.locked(async (manifest) => {
      const record = manifest.worktrees.find((w) => w.id === id);
      if (!record || record.state !== "active") return refuse("OWNERSHIP_AMBIGUOUS", "worktree is not an active owned worktree");
      const cls = await this.classify(record, integrated, evidencePreserved);
      if (!cls.removable) {
        record.state = "preserved";
        this.save(manifest);
        return success(cls);
      }
      const removed = await git(this.repo.ctx, ["worktree", "remove", "--", record.path]);
      if (!succeeded(removed)) {
        record.state = "preserved";
        this.save(manifest);
        return refuse("WORK_UNPRESERVED", "Git refused to remove the worktree; it was preserved");
      }
      record.state = "removed";
      this.save(manifest);
      return success(cls);
    });
  }
}
