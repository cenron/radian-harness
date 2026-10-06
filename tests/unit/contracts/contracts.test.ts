import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveAuthority, verifyAuthorityHash, type AuthorityRequest, type ResolvedAuthority } from "../../../src/contracts/authority.ts";
import { sealBrief } from "../../../src/contracts/brief.ts";
import { newId, type AssignmentIdentity } from "../../../src/contracts/identity.ts";
import { canonicalPath, intersectRoots, isWithin, resolveWithin, safeRelative } from "../../../src/contracts/paths.ts";
import { validateResult } from "../../../src/contracts/result.ts";
import { removeDir, tempDir } from "../helpers/fixture.ts";

interface Layout {
  root: string;
  project: string;
  worktree: string;
  output: string;
  scratch: string;
  state: string;
  gitDir: string;
  outside: string;
}

function layout(): Layout {
  const root = tempDir();
  const l: Layout = {
    root,
    project: path.join(root, "project"),
    worktree: path.join(root, "worktrees", "a1"),
    output: path.join(root, "exchange", "a1"),
    scratch: path.join(root, "scratch", "a1"),
    state: path.join(root, "state"),
    gitDir: path.join(root, "project", ".git"),
    outside: path.join(root, "outside"),
  };
  for (const dir of [l.project, l.worktree, path.join(l.worktree, "src"), path.join(l.worktree, "tests"), l.output, l.scratch, l.state, l.gitDir, l.outside]) mkdirSync(dir, { recursive: true });
  return l;
}

function request(l: Layout, overrides: Partial<AuthorityRequest> = {}): AuthorityRequest {
  return {
    role: "developer",
    worktree: l.worktree,
    readRoots: [l.project],
    writeRoots: [path.join(l.worktree, "src")],
    outputDir: l.output,
    scratchDir: l.scratch,
    operations: ["read", "edit", "shell", "run-checks", "deliver-changes", "write-report"],
    ...overrides,
  };
}

function policy(l: Layout) {
  return { projectRoot: l.project, protectedPaths: [l.gitDir, l.state] };
}

test("canonical paths resolve symlinked parents and detect escapes", () => {
  const l = layout();
  try {
    symlinkSync(l.outside, path.join(l.worktree, "escape"));
    const inside = resolveWithin(l.worktree, "src/new-file.ts", [l.worktree]);
    assert.ok(inside.ok);
    const traversal = resolveWithin(l.worktree, "../../outside/x", [l.worktree]);
    assert.equal(traversal.ok ? "ok" : traversal.blocker.code, "PATH_OUTSIDE_SCOPE");
    const viaLink = resolveWithin(l.worktree, "escape/new.txt", [l.worktree]);
    assert.equal(viaLink.ok ? "ok" : viaLink.blocker.code, "PATH_OUTSIDE_SCOPE");
    assert.equal((() => { const c = canonicalPath("relative/path"); return c.ok ? "ok" : c.blocker.code; })(), "PATH_INVALID");
    assert.equal((() => { const c = canonicalPath("/tmp/a\0b"); return c.ok ? "ok" : c.blocker.code; })(), "PATH_INVALID");
    // String-prefix confusion: "/x/worktrees/a1-other" is not within "/x/worktrees/a1".
    assert.equal(isWithin(l.worktree + "-other", l.worktree), false);
  } finally {
    removeDir(l.root);
  }
});

test("scope intersection keeps the narrower root", () => {
  assert.deepEqual(intersectRoots(["/a", "/b/c"], ["/a/x", "/b"]), ["/a/x", "/b/c"]);
  assert.deepEqual(intersectRoots(["/a"], ["/b"]), []);
  assert.equal(safeRelative("src/a.ts"), true);
  for (const bad of ["../a", "/abs", "a/../b", "a//b", "", "a\\b", "./a"]) assert.equal(safeRelative(bad), false, bad);
});

test("authority intersects role limits, task scope, and protected state", () => {
  const l = layout();
  try {
    const ok = resolveAuthority(request(l), policy(l));
    assert.ok(ok.ok);
    if (ok.ok) {
      assert.ok(verifyAuthorityHash(ok.value));
      assert.ok(ok.value.prohibited.includes("push"));
      assert.equal(ok.value.network, "model-only", "network-outbound was not requested");
    }
    const reviewerShell = resolveAuthority(request(l, { role: "reviewer", writeRoots: [], operations: ["read", "shell"] }), policy(l));
    assert.equal(reviewerShell.ok ? "ok" : reviewerShell.blocker.code, "ROLE_OPERATION_DENIED");
    const reviewerWrites = resolveAuthority(request(l, { role: "reviewer", operations: ["read", "write-report"] }), policy(l));
    assert.equal(reviewerWrites.ok ? "ok" : reviewerWrites.blocker.code, "ROLE_OPERATION_DENIED");
    const reviewer = resolveAuthority(request(l, { role: "reviewer", writeRoots: [], operations: ["read", "git-inspect", "write-report"] }), policy(l));
    assert.ok(reviewer.ok);
    const outsideWrite = resolveAuthority(request(l, { writeRoots: [l.outside] }), policy(l));
    assert.equal(outsideWrite.ok ? "ok" : outsideWrite.blocker.code, "PATH_OUTSIDE_SCOPE");
    const protectedOutput = resolveAuthority(request(l, { outputDir: path.join(l.state, "inbox") }), policy(l));
    assert.equal(protectedOutput.ok ? "ok" : protectedOutput.blocker.code, "PATH_OUTSIDE_SCOPE");
    const deps = resolveAuthority(request(l, { operations: ["read", "edit", "add-dependencies"] }), policy(l));
    assert.equal(deps.ok ? "ok" : deps.blocker.code, "ROLE_OPERATION_DENIED");
    const depsApproved = resolveAuthority(request(l, { operations: ["read", "edit", "add-dependencies"], dependencyChangesApproved: true }), policy(l));
    assert.ok(depsApproved.ok);
    const ports = resolveAuthority(request(l, { ports: [8080] }), policy(l));
    assert.equal(ports.ok ? "ok" : ports.blocker.code, "AUTHORITY_INVALID");
    const outputInWorktree = resolveAuthority(request(l, { outputDir: path.join(l.worktree, "out") }), policy(l));
    assert.equal(outputInWorktree.ok ? "ok" : outputInWorktree.blocker.code, "AUTHORITY_INVALID");
  } finally {
    removeDir(l.root);
  }
});

function identity(role: AssignmentIdentity["role"] = "developer"): AssignmentIdentity {
  return { workspace: newId("ws"), project: newId("prj"), run: newId("run"), task: newId("task"), assignment: newId("asg"), attempt: newId("att"), generation: 1, role };
}

const HASH = "sha256:" + "a".repeat(64);
const COMMIT = "b".repeat(40);

function makeBrief(id: AssignmentIdentity, authority: ResolvedAuthority, round = 1) {
  return {
    schema: "radian.brief/1",
    identity: id,
    round: { current: round, max: 3 },
    objective: "Implement the approved change.",
    nonGoals: [],
    acceptanceCriteria: ["Behavior matches the approved spec."],
    approvals: [{ kind: "spec", approvalId: "apr_123456", artifact: { path: "docs/spec.md", hash: HASH } }],
    base: { commit: COMMIT, checkout: "wt_123456" },
    authority,
    profile: { name: "codex", runtime: "codex", provider: "openai", model: "gpt-test-1", effort: "medium", selection: "default" },
    deliverables: ["source change"],
    requiredChecks: [{ id: "unit", description: "unit tests", argv: ["npm", "test"] }],
    budget: { executionMsRemaining: 1_800_000, automaticRecoveriesRemaining: 1 },
    context: [],
    decisionRoute: "coordinator",
    configSnapshot: HASH,
  };
}

function makeResult(id: AssignmentIdentity, briefHash: string, extra: Record<string, unknown> = {}) {
  return {
    schema: "radian.result/1",
    identity: id,
    briefHash,
    outcome: "completed",
    summary: "Done.",
    deliverables: [{ path: "src/a.ts" }],
    checks: [{ id: "unit", outcome: "passed", candidate: COMMIT, exitCode: 0 }],
    findings: [],
    unmetCriteria: [],
    risks: [],
    decisionRequests: [],
    handoff: { dirty: true, incomplete: [], runningServices: [], ownedResources: [] },
    usage: { status: "unknown" },
    modelAttestation: "unverified",
    ...extra,
  };
}

test("briefs bind identity, authority, round cap, and hash", () => {
  const l = layout();
  try {
    const authority = resolveAuthority(request(l), policy(l));
    assert.ok(authority.ok);
    if (!authority.ok) return;
    const id = identity();
    const sealed = sealBrief(makeBrief(id, authority.value));
    assert.ok(sealed.ok);
    if (sealed.ok) assert.match(sealed.value.hash, /^sha256:/);
    const fourth = sealBrief({ ...makeBrief(id, authority.value), round: { current: 4, max: 3 } });
    assert.equal(fourth.ok ? "ok" : fourth.blocker.code, "AUTHORITY_INVALID");
    const tampered = sealBrief(makeBrief(id, { ...authority.value, writeRoots: [l.outside] }));
    assert.equal(tampered.ok ? "ok" : tampered.blocker.code, "AUTHORITY_INVALID");
    const roleMismatch = sealBrief(makeBrief(identity("tester"), authority.value));
    assert.equal(roleMismatch.ok ? "ok" : roleMismatch.blocker.code, "AUTHORITY_INVALID");
  } finally {
    removeDir(l.root);
  }
});

test("results are data: spoofed authority fields, stale identities, and traversal are rejected", () => {
  const id = identity();
  const expected = { identity: id, briefHash: HASH };
  assert.ok(validateResult(makeResult(id, HASH), expected).ok);
  const code = (raw: unknown) => {
    const r = validateResult(raw, expected);
    return r.ok ? "ok" : r.blocker.code;
  };
  assert.equal(code(makeResult(id, HASH, { approval: { kind: "integration" } })), "RESULT_INVALID");
  assert.equal(code(makeResult(id, HASH, { authority: { writeRoots: ["/"] } })), "RESULT_INVALID");
  assert.equal(code(makeResult({ ...id, generation: 2 }, HASH)), "STALE_GENERATION");
  assert.equal(code(makeResult({ ...id, attempt: newId("att") }, HASH)), "STALE_GENERATION");
  assert.equal(code(makeResult({ ...id, task: newId("task") }, HASH)), "IDENTITY_MISMATCH");
  assert.equal(code(makeResult(id, "sha256:" + "c".repeat(64))), "IDENTITY_MISMATCH");
  assert.equal(code(makeResult(id, HASH, { deliverables: [{ path: "../../etc/x" }] })), "RESULT_INVALID");
  assert.equal(code(makeResult(id, HASH, { outcome: "approved" })), "RESULT_INVALID");
  assert.equal(code(makeResult(id, HASH, { checks: [{ id: "unit", outcome: "green" }] })), "RESULT_INVALID");
  assert.equal(code(makeResult(id, HASH, { usage: { status: "reported" } })), "RESULT_INVALID");
  assert.equal(code("not an object"), "RESULT_INVALID");
});

test("fixture worktree content is synthetic", () => {
  const l = layout();
  try {
    writeFileSync(path.join(l.worktree, "src", "a.ts"), "export const a = 1;\n");
    assert.ok(resolveWithin(l.worktree, "src/a.ts", [l.worktree]).ok);
  } finally {
    removeDir(l.root);
  }
});
