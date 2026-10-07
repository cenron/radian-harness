import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { commitFile, git, makeRepository, makeTempDir } from "../../helpers/git-fixtures.ts";

const scriptPath = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../scripts/publication-check.ts",
);

// Assembled at runtime so this file stays clean under the scanner.
const githubToken = "gh" + "p_" + "a".repeat(36);
const homePath = "/Us" + "ers/jane/work";

function runCheck(repo: string, environment: Record<string, string> = {}) {
  const env = { ...process.env, ...environment };
  if (!("RADIAN_PUBLICATION_DENYLIST" in environment)) delete env.RADIAN_PUBLICATION_DENYLIST;
  return spawnSync(process.execPath, [scriptPath, "--repo", repo], { encoding: "utf8", env });
}

test("a clean repository passes and discloses missing denylist coverage", () => {
  const repo = makeRepository();
  const result = runCheck(repo);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Private denylist coverage is absent/);
  assert.match(result.stdout, /clean/);
});

test("a token in a tracked file fails and names path:line", () => {
  const repo = makeRepository();
  commitFile(repo, "config.txt", `first line\ntoken=${githubToken}\n`, "add config");
  const result = runCheck(repo);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /token {2}config\.txt:2 {2}ghp_\*\*\*/);
  assert.doesNotMatch(result.stdout, new RegExp(githubToken));
});

test("a home path in a commit message fails and names the commit", () => {
  const repo = makeRepository();
  commitFile(repo, "notes.txt", "notes\n", `copied from ${homePath}`);
  const shortHash = git(repo, "rev-parse", "--short=12", "HEAD");
  const result = runCheck(repo);
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`home-path {2}commit ${shortHash}`));
});

test("literals from the private denylist file are reported", () => {
  const repo = makeRepository();
  commitFile(repo, "about.md", "Made for Acme Corp.\n", "add about");
  const denylistPath = path.join(makeTempDir(), "denylist.txt");
  fs.writeFileSync(denylistPath, "# private names\nacme corp\n");
  const result = runCheck(repo, { RADIAN_PUBLICATION_DENYLIST: denylistPath });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /denylist {2}about\.md:1 {2}entry 1/);
  assert.doesNotMatch(result.stdout, /coverage is absent/);
});

test("binary files are skipped", () => {
  const repo = makeRepository();
  fs.writeFileSync(path.join(repo, "image.bin"), Buffer.from(`\0\x01${githubToken}`));
  git(repo, "add", "image.bin");
  git(repo, "commit", "-q", "-m", "add binary");
  assert.equal(runCheck(repo).status, 0);
});

test("usage and git errors exit 2", () => {
  const usage = spawnSync(process.execPath, [scriptPath, "--bogus"], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage:/);
  assert.equal(runCheck(makeTempDir()).status, 2);
});
