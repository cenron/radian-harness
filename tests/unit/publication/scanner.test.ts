import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fingerprint, parseAllowances } from "../../../src/publication/allowances.ts";
import { loadDenylist } from "../../../src/publication/denylist.ts";
import { formatReport, parseArgs, parsePrePushInput, runCheck, whitespaceLocations, type CliOptions } from "../../../src/publication/cli.ts";
import { classifyPackagePath } from "../../../src/publication/package.ts";
import { scanMetadata, scanStaged, scanTree, scanWorktree } from "../../../src/publication/scanner.ts";
import { installHook, removeHook, hookBody } from "../../../src/publication/hooks.ts";
import { makeRepo, planted, removeDir, tempDir } from "../helpers/fixture.ts";

const scan = { denylistTerms: [] as string[], maxFileBytes: 1024 * 1024 };

function options(partial: Partial<CliOptions>): CliOptions {
  const base = parseArgs(["--staged"]);
  if ("error" in base) throw new Error(base.error);
  return { ...base, staged: false, ...partial };
}

test("partial staging scans the staged blob, not the working-tree file", async () => {
  const repo = await makeRepo();
  try {
    repo.write("notes.txt", "clean\n");
    await repo.commitAll("init");
    repo.write("notes.txt", `token ${planted.githubToken()}\n`);
    await repo.git("add", "notes.txt");
    repo.write("notes.txt", "clean again\n");
    const staged = await scanStaged(repo.ctx, scan);
    const worktree = await scanWorktree(repo.ctx, repo.root, scan);
    assert.equal(staged.findings.length, 1);
    assert.equal(staged.findings[0]?.rule, "RH-TOKEN");
    assert.equal(worktree.findings.length, 0);

    repo.write("notes.txt", "clean\n");
    await repo.git("add", "notes.txt");
    repo.write("notes.txt", `addr ${planted.email()}\n`);
    assert.equal((await scanStaged(repo.ctx, scan)).findings.length, 0);
    assert.equal((await scanWorktree(repo.ctx, repo.root, scan)).findings.length, 1);
  } finally {
    removeDir(repo.root);
  }
});

test("untracked non-ignored files are scanned; ignored files are not", async () => {
  const repo = await makeRepo();
  try {
    repo.write(".gitignore", "ignored.txt\n");
    repo.write("ignored.txt", planted.homePath());
    repo.write("new.txt", planted.homePath());
    const report = await scanWorktree(repo.ctx, repo.root, scan);
    assert.deepEqual(report.findings.map((f) => f.path), ["new.txt"]);
  } finally {
    removeDir(repo.root);
  }
});

test("symlinks are scanned as link text and never followed", async () => {
  const repo = await makeRepo();
  const outside = tempDir();
  try {
    writeFileSync(path.join(outside, "secret.txt"), planted.githubToken());
    symlinkSync(path.join(outside, "secret.txt"), path.join(repo.root, "link-out"));
    symlinkSync(planted.homePath(), path.join(repo.root, "link-home"));
    const report = await scanWorktree(repo.ctx, repo.root, scan);
    const rules = report.findings.map((f) => `${f.path}:${f.rule}`);
    assert.ok(!rules.some((r) => r.endsWith("RH-TOKEN")), "followed a symlink out of the repository");
    assert.ok(rules.includes("link-home:RH-HOME-PATH"));
    await repo.commitAll("links");
    const tree = await scanTree(repo.ctx, "HEAD", scan);
    assert.ok(tree.findings.some((f) => f.path === "link-home" && f.rule === "RH-HOME-PATH"));
  } finally {
    removeDir(repo.root);
    removeDir(outside);
  }
});

test("binary content is excluded and reported, oversized content is an error", async () => {
  const repo = await makeRepo();
  try {
    repo.write("image.bin", Buffer.from([0x89, 0x50, 0x00, 0x01, ...Buffer.from(planted.githubToken())]));
    repo.write("big.txt", "a".repeat(2048));
    const report = await scanWorktree(repo.ctx, repo.root, { ...scan, maxFileBytes: 1024 });
    assert.deepEqual(report.excluded.map((e) => e.path), ["image.bin"]);
    assert.deepEqual(report.errors.map((e) => e.path), ["big.txt"]);
  } finally {
    removeDir(repo.root);
  }
});

test("unreadable input makes the result incomplete, never clean", { skip: process.getuid?.() === 0 ? "root can read mode 000 files" : false }, async () => {
  const repo = await makeRepo();
  try {
    repo.write("locked.txt", "data\n");
    chmodSync(path.join(repo.root, "locked.txt"), 0o000);
    const outcome = await runCheck(options({ repo: repo.root, worktree: true }));
    assert.equal(outcome.exitCode, 2);
    assert.ok(outcome.lines.some((line) => line.includes("INCOMPLETE")));
  } finally {
    chmodSync(path.join(repo.root, "locked.txt"), 0o600);
    removeDir(repo.root);
  }
});

test("exit codes: clean 0, findings 1", async () => {
  const repo = await makeRepo();
  try {
    repo.write("a.txt", "hello\n");
    await repo.commitAll("init");
    assert.equal((await runCheck(options({ repo: repo.root, worktree: true, trees: ["HEAD"] }))).exitCode, 0);
    repo.write("b.txt", planted.privateKey() + "\n");
    assert.equal((await runCheck(options({ repo: repo.root, worktree: true }))).exitCode, 1);
  } finally {
    removeDir(repo.root);
  }
});

test("diagnostics never contain matched values; CI mode omits fingerprints", async () => {
  const repo = await makeRepo();
  try {
    const values = [planted.githubToken(), planted.email(), planted.homePath(), planted.privateIp()];
    repo.write("leak.txt", values.join("\n") + "\n");
    const local = await runCheck(options({ repo: repo.root, worktree: true }));
    const ci = await runCheck(options({ repo: repo.root, worktree: true, ci: true }));
    for (const value of values) {
      for (const line of [...local.lines, ...ci.lines]) assert.ok(!line.includes(value), "matched value printed");
    }
    assert.ok(local.lines.some((line) => /sha256:[0-9a-f]{16}/.test(line)));
    assert.ok(!ci.lines.some((line) => /sha256:/.test(line)));
  } finally {
    removeDir(repo.root);
  }
});

test("private denylist: case-insensitive, outside repository, honest status, values never printed", async () => {
  const repo = await makeRepo();
  const privateDir = tempDir();
  try {
    const term = planted.privateTerm();
    const denylistFile = path.join(privateDir, "terms.txt");
    writeFileSync(denylistFile, `# private terms\n${term}\n`);
    repo.write("doc.md", `Owner: ${term.toUpperCase()}\n`);

    const absent = loadDenylist(undefined, repo.root);
    assert.equal(absent.status.state, "absent");
    const loaded = loadDenylist(denylistFile, repo.root);
    assert.equal(loaded.status.state, "loaded");

    const outcome = await runCheck(options({ repo: repo.root, worktree: true, denylist: denylistFile }));
    assert.equal(outcome.exitCode, 1);
    assert.ok(outcome.lines.some((line) => line.includes("RH-PRIVATE-TERM")));
    for (const line of outcome.lines) assert.ok(!line.toLowerCase().includes(term.toLowerCase()));
    assert.ok(!outcome.lines.some((line) => line.includes("RH-PRIVATE-TERM") && line.includes("sha256:")));

    const noDenylist = await runCheck(options({ repo: repo.root, worktree: true }));
    assert.ok(noDenylist.lines.some((line) => line.includes("NOT SUPPLIED")));

    repo.write("in-repo-terms.txt", `${term}\n`);
    assert.equal(loadDenylist(path.join(repo.root, "in-repo-terms.txt"), repo.root).status.state, "error");
    assert.equal(loadDenylist(path.join(privateDir, "missing.txt"), repo.root).status.state, "error");
    writeFileSync(path.join(privateDir, "short.txt"), "ab\n");
    assert.equal(loadDenylist(path.join(privateDir, "short.txt"), repo.root).status.state, "error");
    const required = await runCheck(options({ repo: repo.root, worktree: true, requireDenylist: true }));
    assert.equal(required.exitCode, 2);
  } finally {
    removeDir(repo.root);
    removeDir(privateDir);
  }
});

test("narrow allowances suppress exactly one rule/path/value", async () => {
  const repo = await makeRepo();
  try {
    const email = planted.email();
    repo.write("a.md", `${email}\n`);
    repo.write("b.md", `${email}\n`);
    repo.write(
      "config/publication-allowances.json",
      JSON.stringify({ version: 1, allowances: [{ rule: "RH-EMAIL", path: "a.md", fingerprint: fingerprint("RH-EMAIL", email), reason: "reviewed fixture allowance" }] }),
    );
    const report = await scanWorktree(repo.ctx, repo.root, scan);
    assert.deepEqual(report.findings.map((f) => f.path), ["b.md"]);
    assert.equal(parseAllowances(JSON.stringify({ version: 1, allowances: [{ rule: "RH-EMAIL", path: "*.md", fingerprint: "sha256:0123456789abcdef", reason: "too broad wildcard" }] })).ok, false);
    assert.equal(parseAllowances(JSON.stringify({ version: 1, allowances: [{ rule: "RH-PRIVATE-TERM", path: "a.md", fingerprint: "sha256:0123456789abcdef", reason: "private terms are never allowable" }] })).ok, false);
    assert.equal(parseAllowances(JSON.stringify({ version: 1, allowances: [{ rule: "RH-EMAIL", path: "a.md", reason: "missing fingerprint entirely" }] })).ok, false);
    repo.write("config/publication-allowances.json", "{ not json");
    assert.equal((await scanWorktree(repo.ctx, repo.root, scan)).errors.length, 1);
  } finally {
    removeDir(repo.root);
  }
});

test("commit metadata: non-noreply identities and message content are findings", async () => {
  const repo = await makeRepo();
  try {
    repo.write("a.txt", "a\n");
    await repo.commitAll("clean commit", {
      GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "1+a@users.noreply.github.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "1+a@users.noreply.github.com",
    });
    assert.equal((await scanMetadata(repo.ctx, "HEAD", scan)).findings.length, 0);
    repo.write("b.txt", "b\n");
    await repo.commitAll(`message with ${planted.homePath()}`, {
      GIT_AUTHOR_NAME: "B", GIT_AUTHOR_EMAIL: planted.email(), GIT_COMMITTER_NAME: "B", GIT_COMMITTER_EMAIL: "1+b@users.noreply.github.com",
    });
    const report = await scanMetadata(repo.ctx, "HEAD", scan);
    const kinds = report.findings.map((f) => `${f.rule}:${f.kind}`).sort();
    assert.deepEqual(kinds, ["RH-EMAIL:commit-identity", "RH-HOME-PATH:unix-home"]);
    for (const line of formatReport(report, false)) assert.ok(!line.includes(planted.email()));
  } finally {
    removeDir(repo.root);
  }
});

test("whitespace diagnostics keep locations and drop echoed content", () => {
  const output = `src/a.ts:3: trailing whitespace.\n+const value = "${planted.githubToken()}"   \n`;
  assert.deepEqual(whitespaceLocations(output), ["src/a.ts:3"]);
});

test("pre-push input parsing ignores deletions", () => {
  const zero = "0".repeat(40);
  const sha = "a".repeat(40);
  assert.deepEqual(parsePrePushInput(`refs/heads/main ${sha} refs/heads/main ${zero}\nrefs/heads/x ${zero} refs/heads/x ${sha}\n`), [{ localSha: sha, remoteSha: zero }]);
});

test("package content allowlist and forbidden patterns", () => {
  assert.equal(classifyPackagePath("src/publication/scanner.ts"), undefined);
  assert.equal(classifyPackagePath("config/harness.json"), undefined);
  assert.match(classifyPackagePath("tests/unit/x.test.ts") ?? "", /forbidden/);
  assert.match(classifyPackagePath("config/.env.local") ?? "", /forbidden/);
  assert.match(classifyPackagePath("src/auth.json") ?? "", /forbidden/);
  assert.match(classifyPackagePath("config/private-denylist.txt") ?? "", /forbidden/);
  assert.match(classifyPackagePath("docs/planning/x.md") ?? "", /forbidden/);
  assert.match(classifyPackagePath("random.txt") ?? "", /allowlist/);
});

test("owned hook never overwrites a personal hook and removes only its unchanged copy", async () => {
  const repo = await makeRepo();
  try {
    const hookFile = path.join(repo.root, ".git", "hooks", "pre-push");
    writeFileSync(hookFile, "#!/bin/sh\necho personal\n", { mode: 0o755 });
    assert.equal((await installHook(repo.ctx)).ok, false);
    assert.equal((await removeHook(repo.ctx)).ok, false);
    const { unlinkSync, readFileSync } = await import("node:fs");
    unlinkSync(hookFile);
    assert.equal((await installHook(repo.ctx)).ok, true);
    assert.equal(readFileSync(hookFile, "utf8"), hookBody());
    writeFileSync(hookFile, hookBody() + "# local edit\n");
    assert.equal((await removeHook(repo.ctx)).ok, false);
    writeFileSync(hookFile, hookBody());
    assert.equal((await removeHook(repo.ctx)).ok, true);
    await repo.git("config", "--local", "core.hooksPath", ".githooks");
    assert.equal((await installHook(repo.ctx)).ok, false);
  } finally {
    removeDir(repo.root);
  }
});
