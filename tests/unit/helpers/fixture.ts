// Disposable synthetic fixtures for tests. Everything is created under the OS
// temporary directory and removed by the caller; no real workspace is touched.

import { mkdtempSync, rmSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type GitContext, gitOk, locateGit } from "../../../src/git/exec.ts";

export function tempDir(prefix = "radian-test-"): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function requireGit(): string {
  const gitPath = locateGit();
  if (!gitPath) throw new Error("git is required for this test");
  return gitPath;
}

export const FIXTURE_IDENTITY = {
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture Author",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

export interface Repo {
  root: string;
  ctx: GitContext;
  write(relative: string, content: string | Buffer): void;
  git(...args: string[]): Promise<string>;
  commitAll(message: string, env?: Record<string, string>): Promise<string>;
}

export async function makeRepo(dir = tempDir()): Promise<Repo> {
  const ctx: GitContext = { gitPath: requireGit(), cwd: dir };
  await gitOk(ctx, ["init", "-q", "-b", "main"]);
  const repo: Repo = {
    root: dir,
    ctx,
    write(relative, content) {
      const file = path.join(dir, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    },
    async git(...args) {
      return (await gitOk(ctx, args, { env: FIXTURE_IDENTITY })).toString("utf8").trim();
    },
    async commitAll(message, env = FIXTURE_IDENTITY) {
      await gitOk(ctx, ["add", "-A"]);
      await gitOk(ctx, ["commit", "-q", "--no-verify", "-m", message], { env });
      return (await gitOk(ctx, ["rev-parse", "HEAD"])).toString("utf8").trim();
    },
  };
  return repo;
}

/**
 * Planted sensitive-looking values are assembled at runtime so that this public
 * repository never contains the literal patterns it tests for.
 */
export const planted = {
  homePath: () => ["", "Users", "pl" + "anted", "project"].join("/"),
  windowsHome: () => ["C:", "Users", "pl" + "anted", "x"].join("\\"),
  macTemp: () => ["", "var", "folders", "zz", "abcdef123456", "T"].join("/"),
  email: () => "pl" + "anted.person" + "@" + "mail" + "provider.io",
  privateIp: () => ["192", "168", "7", "42"].join("."),
  privateKey: () => "-".repeat(5) + "BEGIN RSA PRI" + "VATE KEY" + "-".repeat(5),
  githubToken: () => "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  awsKey: () => "AK" + "IA" + "ABCDEFGHIJKLMNOP",
  skKey: () => "s" + "k-" + "proj-" + "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2",
  secretAssignment: () => "api" + "_key = \"" + "q7W9e2R4t6Y8u1I3" + "\"",
  envAssignment: () => "export SERVICE_" + "TOKEN=" + "abc123def456ghi789",
  privateTerm: () => "Zephyr" + "quill",
};
