import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { newId } from "../../../src/contracts/identity.ts";
import { success } from "../../../src/contracts/blockers.ts";
import { assembleCandidate } from "../../../src/git/candidate.ts";
import { deliverFromWorktree, deliverPatch, inScope, safeSymlinkTarget } from "../../../src/git/delivery.ts";
import { gitOk, gitText } from "../../../src/git/exec.ts";
import { inspectArgv } from "../../../src/git/inspect.ts";
import { integrateCandidate, type IntegrationEvidence } from "../../../src/git/integration.ts";
import { openRepository, type Repository, validateTarget } from "../../../src/git/repository.ts";
import { WorktreeManager } from "../../../src/git/worktrees.ts";
import { makeRepo, removeDir, tempDir, type Repo } from "../helpers/fixture.ts";

const IDENTITY = { name: "Radian Fixture", email: "radian@example.com" };

interface World {
  root: string;
  fixture: Repo;
  repo: Repository;
  base: string;
  manager: WorktreeManager;
  markers: string;
  scratch: string;
}

/** A synthetic project with planted hooks and filter drivers that must never run. */
async function world(): Promise<World> {
  const root = tempDir();
  const projectDir = path.join(root, "project");
  mkdirSync(projectDir);
  const fixture = await makeRepo(projectDir);
  const markers = path.join(root, "markers");
  mkdirSync(markers);
  fixture.write("src/a.ts", "export const a = 1;\n");
  fixture.write("src/old.ts", "export const old = 1;\n");
  fixture.write("tests/a.test.ts", "// test\n");
  fixture.write("README.md", "fixture\n");
  const base = await fixture.commitAll("base");
  for (const hook of ["pre-commit", "post-commit", "post-checkout", "post-merge", "reference-transaction", "pre-push", "post-rewrite"]) {
    writeFileSync(path.join(projectDir, ".git", "hooks", hook), `#!/bin/sh\ntouch "${markers}/hook-${hook}"\n`, { mode: 0o755 });
  }
  await fixture.git("config", "filter.planted.clean", `sh -c 'touch "${markers}/filter-clean"; cat'`);
  await fixture.git("config", "filter.planted.smudge", `sh -c 'touch "${markers}/filter-smudge"; cat'`);
  await fixture.git("config", "diff.planted.textconv", `sh -c 'touch "${markers}/textconv"; cat'`);
  await fixture.git("config", "merge.planted.driver", `sh -c 'touch "${markers}/merge-driver"; false'`);
  const opened = await openRepository(projectDir);
  assert.ok(opened.ok);
  if (!opened.ok) throw new Error("repo");
  const stateDir = path.join(root, "state");
  const scratch = path.join(root, "scratch");
  mkdirSync(scratch);
  const manager = new WorktreeManager(opened.value, stateDir, path.join(root, "worktrees"));
  return { root, fixture, repo: opened.value, base, manager, markers, scratch };
}

function markersRan(w: World): string[] {
  return readdirSync(w.markers);
}

async function allocate(w: World, role: "developer" | "tester" = "developer") {
  const assignment = newId("asg");
  const record = await w.manager.allocate({ purpose: "assignment", task: "task_fixture-1", assignment, role, base: w.base });
  assert.ok(record.ok);
  if (!record.ok) throw new Error("allocate");
  return { assignment, attempt: newId("att"), record: record.value };
}

test("worktrees: allocated outside the project, validated, exclusively owned", async () => {
  const w = await world();
  try {
    const { record, attempt } = await allocate(w);
    assert.ok(!record.path.startsWith(w.repo.root + path.sep));
    assert.ok((await w.manager.validate(record)).ok);
    assert.ok((await w.manager.claim(record.id, attempt, 1)).ok);
    const other = await w.manager.claim(record.id, newId("att"), 2);
    assert.equal(other.ok ? "ok" : other.blocker.code, "OWNERSHIP_AMBIGUOUS");
    assert.ok((await w.manager.markRetired(record.id, attempt)).ok);
    assert.ok((await w.manager.claim(record.id, newId("att"), 2)).ok);
    const stale = await w.manager.claim(record.id, newId("att"), 1);
    assert.equal(stale.ok ? "ok" : stale.blocker.code, "OWNERSHIP_AMBIGUOUS");
    const inside = new WorktreeManager(w.repo, path.join(w.root, "state2"), path.join(w.repo.root, "nested"));
    const refused = await inside.allocate({ purpose: "assignment", task: "task_fixture-1", base: w.base });
    assert.equal(refused.ok ? "ok" : refused.blocker.code, "PATH_OUTSIDE_SCOPE");
    // Tampered Git pointer is detected.
    writeFileSync(path.join(record.path, ".git"), `gitdir: ${w.root}/elsewhere\n`);
    const tampered = await w.manager.validate(record);
    assert.equal(tampered.ok ? "ok" : tampered.blocker.code, "POLICY_TAMPERED");
  } finally {
    removeDir(w.root);
  }
});

test("worktree delivery: scoped controlled commit, no hooks or filters executed", async () => {
  const w = await world();
  try {
    const { record, assignment, attempt } = await allocate(w);
    writeFileSync(path.join(record.path, "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(path.join(record.path, "src", "new.ts"), "export const n = 1;\n", { mode: 0o755 });
    rmSync(path.join(record.path, "src", "old.ts"));
    writeFileSync(path.join(record.path, "src", ".gitattributes"), "*.ts filter=planted diff=planted merge=planted\n");
    symlinkSync("a.ts", path.join(record.path, "src", "link.ts"));
    const delivery = await deliverFromWorktree({ repo: w.repo, worktreePath: record.path, expectedBase: w.base, scope: { writeRoots: ["src"] }, assignment, attempt, message: "developer delivery", identity: IDENTITY, scratchDir: w.scratch });
    assert.ok(delivery.ok, delivery.ok ? "" : delivery.blocker.message);
    if (!delivery.ok) return;
    assert.deepEqual(markersRan(w), [], "no hook, filter, or helper may run");
    const files = (await gitText(w.repo.ctx, ["ls-tree", "-r", "--name-only", delivery.value.commit])).split("\n");
    assert.ok(files.includes("src/new.ts") && files.includes("src/link.ts") && !files.includes("src/old.ts"));
    assert.equal(await gitText(w.repo.ctx, ["show", `${delivery.value.commit}:src/a.ts`]), "export const a = 2;");
    const modes = await gitText(w.repo.ctx, ["ls-tree", delivery.value.commit, "src/new.ts", "src/link.ts"]);
    assert.match(modes, /100755 blob .*src\/new\.ts/);
    assert.match(modes, /120000 blob .*src\/link\.ts/);
    assert.equal(await gitText(w.repo.ctx, ["rev-parse", delivery.value.ref]), delivery.value.commit);
    // The target branch did not move and the worker's worktree index was not used.
    assert.equal(await gitText(w.repo.ctx, ["rev-parse", "refs/heads/main"]), w.base);
    const again = await deliverFromWorktree({ repo: w.repo, worktreePath: record.path, expectedBase: w.base, scope: { writeRoots: ["src"] }, assignment, attempt, message: "x", identity: IDENTITY, scratchDir: w.scratch });
    assert.equal(again.ok ? "ok" : again.blocker.code, "GIT_FAILURE", "a delivery ref is create-only");
  } finally {
    removeDir(w.root);
  }
});

test("worktree delivery refuses out-of-scope paths, escaping symlinks, and moved bases", async () => {
  const w = await world();
  try {
    const one = await allocate(w);
    writeFileSync(path.join(one.record.path, "README.md"), "changed\n");
    const scope = await deliverFromWorktree({ repo: w.repo, worktreePath: one.record.path, expectedBase: w.base, scope: { writeRoots: ["src"] }, assignment: one.assignment, attempt: one.attempt, message: "x", identity: IDENTITY, scratchDir: w.scratch });
    assert.equal(scope.ok ? "ok" : scope.blocker.code, "PATCH_OUT_OF_SCOPE");
    const two = await allocate(w);
    symlinkSync("../../outside", path.join(two.record.path, "src", "escape"));
    const link = await deliverFromWorktree({ repo: w.repo, worktreePath: two.record.path, expectedBase: w.base, scope: { writeRoots: ["src"] }, assignment: two.assignment, attempt: two.attempt, message: "x", identity: IDENTITY, scratchDir: w.scratch });
    assert.equal(link.ok ? "ok" : link.blocker.code, "PATCH_OUT_OF_SCOPE");
    const three = await allocate(w);
    w.fixture.write("src/a.ts", "moved\n");
    const moved = await w.fixture.commitAll("target moved");
    const wrongBase = await deliverFromWorktree({ repo: w.repo, worktreePath: three.record.path, expectedBase: moved, scope: { writeRoots: ["src"] }, assignment: three.assignment, attempt: three.attempt, message: "x", identity: IDENTITY, scratchDir: w.scratch });
    assert.equal(wrongBase.ok ? "ok" : wrongBase.blocker.code, "PATCH_BASE_MISMATCH");
    assert.equal(inScope("src/../README.md", { writeRoots: ["src"] }), false);
    assert.equal(inScope("srcx/a.ts", { writeRoots: ["src"] }), false);
    assert.equal(safeSymlinkTarget("src/l", "../src/a.ts"), true);
    assert.equal(safeSymlinkTarget("src/l", "/etc/passwd"), false);
  } finally {
    removeDir(w.root);
  }
});

test("patch delivery: applies only to its base and only within scope", async () => {
  const w = await world();
  try {
    const { record } = await allocate(w);
    writeFileSync(path.join(record.path, "tests", "a.test.ts"), "// improved test\n");
    const patch = await gitOk({ ...w.repo.ctx, cwd: record.path }, ["diff", "--no-ext-diff", "--binary", "HEAD"]);
    const patchFile = path.join(w.scratch, "tester.patch");
    writeFileSync(patchFile, patch);
    const ok = await deliverPatch({ repo: w.repo, patchFile, expectedBase: w.base, scope: { writeRoots: ["tests"] }, assignment: newId("asg"), attempt: newId("att"), message: "tester delivery", identity: IDENTITY, scratchDir: w.scratch });
    assert.ok(ok.ok, ok.ok ? "" : ok.blocker.message);
    const outside = await deliverPatch({ repo: w.repo, patchFile, expectedBase: w.base, scope: { writeRoots: ["src"] }, assignment: newId("asg"), attempt: newId("att"), message: "x", identity: IDENTITY, scratchDir: w.scratch });
    assert.equal(outside.ok ? "ok" : outside.blocker.code, "PATCH_OUT_OF_SCOPE");
    w.fixture.write("tests/a.test.ts", "// conflicting base change\n");
    const moved = await w.fixture.commitAll("moved");
    const stale = await deliverPatch({ repo: w.repo, patchFile, expectedBase: moved, scope: { writeRoots: ["tests"] }, assignment: newId("asg"), attempt: newId("att"), message: "x", identity: IDENTITY, scratchDir: w.scratch });
    assert.equal(stale.ok ? "ok" : stale.blocker.code, "PATCH_BASE_MISMATCH");
    assert.deepEqual(markersRan(w).filter((m) => !m.startsWith("hook-post-commit") && !m.startsWith("hook-pre-commit") && !m.startsWith("hook-reference") && !m.startsWith("filter-clean")), [], "fixture commits by the test itself may run hooks; controlled operations may not");
  } finally {
    removeDir(w.root);
  }
});

async function developerAndTester(w: World, conflict = false) {
  const dev = await allocate(w, "developer");
  writeFileSync(path.join(dev.record.path, "src", "a.ts"), "export const a = 2;\n");
  if (conflict) writeFileSync(path.join(dev.record.path, "tests", "a.test.ts"), "// dev\n");
  const d = await deliverFromWorktree({ repo: w.repo, worktreePath: dev.record.path, expectedBase: w.base, scope: { writeRoots: conflict ? ["src", "tests"] : ["src"] }, assignment: dev.assignment, attempt: dev.attempt, message: "dev", identity: IDENTITY, scratchDir: w.scratch });
  const tester = await allocate(w, "tester");
  writeFileSync(path.join(tester.record.path, "tests", "a.test.ts"), "// tester\n");
  const t = await deliverFromWorktree({ repo: w.repo, worktreePath: tester.record.path, expectedBase: w.base, scope: { writeRoots: ["tests"] }, assignment: tester.assignment, attempt: tester.attempt, message: "tester", identity: IDENTITY, scratchDir: w.scratch });
  assert.ok(d.ok && t.ok);
  if (!d.ok || !t.ok) throw new Error("delivery");
  return { dev: d.value, tester: t.value, devRecord: dev };
}

test("candidate assembly combines deliveries into one exact candidate; conflicts route to repair", async () => {
  const w = await world();
  try {
    const { dev, tester } = await developerAndTester(w);
    const candidate = await assembleCandidate({ repo: w.repo, base: w.base, task: "task_fixture-1", round: 1, deliveries: [dev, tester], identity: IDENTITY, message: "candidate" });
    assert.ok(candidate.ok, candidate.ok ? "" : candidate.blocker.message);
    if (!candidate.ok) return;
    assert.equal(await gitText(w.repo.ctx, ["show", `${candidate.value.commit}:src/a.ts`]), "export const a = 2;");
    assert.equal(await gitText(w.repo.ctx, ["show", `${candidate.value.commit}:tests/a.test.ts`]), "// tester");
    assert.equal(await gitText(w.repo.ctx, ["rev-parse", `${candidate.value.commit}^`]), w.base);
    assert.deepEqual(markersRan(w).filter((m) => m.includes("merge") || m.includes("smudge") || m.includes("textconv")), []);
    const c = await developerAndTester(w, true);
    const conflict = await assembleCandidate({ repo: w.repo, base: w.base, task: "task_fixture-1", round: 2, deliveries: [c.dev, c.tester], identity: IDENTITY, message: "candidate" });
    assert.equal(conflict.ok ? "ok" : conflict.blocker.code, "CONFLICT");
    const foreign = await assembleCandidate({ repo: w.repo, base: "f".repeat(40), task: "task_fixture-1", round: 2, deliveries: [dev], identity: IDENTITY, message: "x" });
    assert.equal(foreign.ok ? "ok" : foreign.blocker.code, "PATCH_BASE_MISMATCH");
  } finally {
    removeDir(w.root);
  }
});

function evidenceFor(commit: string): IntegrationEvidence {
  return {
    requiredChecks: ["unit"],
    checks: [{ id: "unit", outcome: "passed", candidate: commit, exitCode: 0 }],
    review: { candidate: commit, blockingFindings: 0, outcome: "completed" },
  };
}

test("integration: exact approved fast-forward; drift, dirt, and evidence gaps refuse", async () => {
  const w = await world();
  try {
    const { dev, tester } = await developerAndTester(w);
    const assembled = await assembleCandidate({ repo: w.repo, base: w.base, task: "task_fixture-1", round: 1, deliveries: [dev, tester], identity: IDENTITY, message: "candidate" });
    assert.ok(assembled.ok);
    if (!assembled.ok) return;
    const candidate = { commit: assembled.value.commit, tree: assembled.value.tree, base: w.base };
    const target = { ref: "refs/heads/main" };
    const approve = () => success(true);
    const noEvidence = await integrateCandidate({ repo: w.repo, target, candidate, evidence: { ...evidenceFor(candidate.commit), checks: [] }, approval: approve });
    assert.equal(noEvidence.ok ? "ok" : noEvidence.blocker.code, "CANDIDATE_MISMATCH");
    const otherReview = await integrateCandidate({ repo: w.repo, target, candidate, evidence: { ...evidenceFor(candidate.commit), review: { candidate: w.base, blockingFindings: 0, outcome: "completed" } }, approval: approve });
    assert.equal(otherReview.ok ? "ok" : otherReview.blocker.code, "CANDIDATE_MISMATCH");
    const unapproved = await integrateCandidate({ repo: w.repo, target, candidate, evidence: evidenceFor(candidate.commit), approval: () => ({ ok: false, blocker: { code: "APPROVAL_MISSING", message: "no" } }) });
    assert.equal(unapproved.ok ? "ok" : unapproved.blocker.code, "APPROVAL_MISSING");
    writeFileSync(path.join(w.repo.root, "notes.txt"), "user's unsaved work\n");
    const dirty = await integrateCandidate({ repo: w.repo, target, candidate, evidence: evidenceFor(candidate.commit), approval: approve });
    assert.equal(dirty.ok ? "ok" : dirty.blocker.code, "TARGET_DIRTY");
    assert.equal(readFileSync(path.join(w.repo.root, "notes.txt"), "utf8"), "user's unsaved work\n", "user work preserved");
    rmSync(path.join(w.repo.root, "notes.txt"));
    const done = await integrateCandidate({ repo: w.repo, target, candidate, evidence: evidenceFor(candidate.commit), approval: approve });
    assert.ok(done.ok, done.ok ? "" : done.blocker.message);
    assert.equal(await gitText(w.repo.ctx, ["rev-parse", "refs/heads/main"]), candidate.commit);
    assert.equal(readFileSync(path.join(w.repo.root, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    assert.ok(!existsSync(path.join(w.markers, "hook-post-merge")) && !existsSync(path.join(w.markers, "hook-reference-transaction")));
    const twice = await integrateCandidate({ repo: w.repo, target, candidate, evidence: evidenceFor(candidate.commit), approval: approve });
    assert.equal(twice.ok ? "ok" : twice.blocker.code, "TARGET_DRIFT");
    assert.equal(validateTarget({ ref: "main" }).ok, false);
  } finally {
    removeDir(w.root);
  }
});

test("integration of a target that is not checked out uses compare-and-swap", async () => {
  const w = await world();
  try {
    await w.fixture.git("branch", "release", w.base);
    const { dev } = await developerAndTester(w);
    const assembled = await assembleCandidate({ repo: w.repo, base: w.base, task: "task_fixture-1", round: 1, deliveries: [dev], identity: IDENTITY, message: "candidate" });
    assert.ok(assembled.ok);
    if (!assembled.ok) return;
    const candidate = { commit: assembled.value.commit, tree: assembled.value.tree, base: w.base };
    const ok = await integrateCandidate({ repo: w.repo, target: { ref: "refs/heads/release" }, candidate, evidence: evidenceFor(candidate.commit), approval: () => success(true) });
    assert.ok(ok.ok, ok.ok ? "" : ok.blocker.message);
    assert.equal(await gitText(w.repo.ctx, ["rev-parse", "refs/heads/release"]), candidate.commit);
  } finally {
    removeDir(w.root);
  }
});

test("cleanup removes only retired, clean, integrated work with preserved evidence", async () => {
  const w = await world();
  try {
    const { dev, devRecord } = await developerAndTester(w);
    await w.manager.recordDelivery(devRecord.record.id, dev.commit);
    const record = (await w.manager.get(devRecord.record.id))!;
    const notRetired = await w.manager.classify(record, async () => true, true);
    assert.deepEqual(notRetired, { removable: false, reason: "execution-not-retired" });
    await w.manager.claim(record.id, devRecord.attempt, 1);
    await w.manager.markRetired(record.id, devRecord.attempt);
    const retired = (await w.manager.get(record.id))!;
    assert.deepEqual(await w.manager.classify(retired, async () => true, true), { removable: false, reason: "dirty" }, "worker edits remain in the worktree");
    await gitOk({ ...w.repo.ctx, cwd: retired.path }, ["checkout", "--", "."]);
    assert.deepEqual(await w.manager.classify(retired, async () => false, true), { removable: false, reason: "unintegrated" });
    assert.deepEqual(await w.manager.classify(retired, async () => true, false), { removable: false, reason: "evidence-not-preserved" });
    const removed = await w.manager.remove(record.id, async () => true, true);
    assert.ok(removed.ok && removed.value.removable);
    assert.ok(!existsSync(retired.path));
  } finally {
    removeDir(w.root);
  }
});

test("worker inspection exposes fixed read-only operations only", () => {
  const commit = "a".repeat(40);
  assert.ok(inspectArgv({ op: "status" }).ok);
  assert.ok(inspectArgv({ op: "diff", from: commit, paths: ["src/a.ts"] }).ok);
  assert.equal(inspectArgv({ op: "diff", from: "--output=/tmp/x" }).ok, false);
  assert.equal(inspectArgv({ op: "diff", from: commit, paths: ["../x"] }).ok, false);
  assert.equal(inspectArgv({ op: "log", max: 1000 }).ok, false);
  assert.equal(inspectArgv({ op: "show", rev: "HEAD" }).ok, false);
  const show = inspectArgv({ op: "show", rev: commit });
  assert.ok(show.ok && show.value.includes("--no-textconv"));
});
