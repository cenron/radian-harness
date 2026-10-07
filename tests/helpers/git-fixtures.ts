import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Tests never depend on the developer's own git configuration or identity.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = "Radian Test";
process.env.GIT_AUTHOR_EMAIL = "test@example.invalid";
process.env.GIT_COMMITTER_NAME = "Radian Test";
process.env.GIT_COMMITTER_EMAIL = "test@example.invalid";

export function makeTempDir(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "radian-test-")));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repository on `main` with one commit. */
export function makeRepository(directory = makeTempDir()): string {
  git(directory, "init", "-q", "-b", "main");
  commitFile(directory, "README.md", "hello\n", "initial");
  return directory;
}

export function commitFile(repo: string, file: string, content: string, message: string): void {
  writeFileSync(path.join(repo, file), content);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", message);
}
