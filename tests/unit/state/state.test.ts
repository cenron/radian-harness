import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { newId, type AssignmentIdentity } from "../../../src/contracts/identity.ts";
import { hashJson } from "../../../src/util/canonical.ts";
import { FakeClock } from "../../../src/util/clock.ts";
import { HumanChannel, approvalValidity } from "../../../src/state/approvals.ts";
import { checkProjectBinding } from "../../../src/state/binding.ts";
import { CapacityLedger } from "../../../src/state/capacity.ts";
import { withLock } from "../../../src/state/fsutil.ts";
import { collectResult } from "../../../src/state/inbox.ts";
import { CoordinatorLease } from "../../../src/state/lease.ts";
import { reconcileRun } from "../../../src/state/reconcile.ts";
import { RunStore, loadRunDir, snapshotMatchesLog } from "../../../src/state/run-store.ts";
import { removeDir, tempDir } from "../helpers/fixture.ts";
import { fakeProbe } from "../helpers/probe.ts";

const run = promisify(execFile);
const HASH_A = "sha256:" + "a".repeat(64);
const HASH_B = "sha256:" + "b".repeat(64);
const PROFILE = { name: "codex", runtime: "codex", provider: "openai", model: "gpt-test-1", effort: "medium" };
const human = () => HumanChannel.fromUserInput("user-command", "fixture-user", "/radian approve");

async function setup(clock = new FakeClock()) {
  const dir = tempDir();
  const probe = fakeProbe({});
  const lease = await CoordinatorLease.acquire(dir, "prj_fixture1", { clock, probe, ttlMs: 24 * 3_600_000 });
  assert.ok(lease.ok);
  if (!lease.ok) throw new Error("lease");
  const store = await RunStore.create(dir, lease.value, { workspace: "ws_fixture1", project: "prj_fixture1", configHash: HASH_A, harness: { version: "0.0.0", revision: "c".repeat(40), locallyModified: false } }, { clock, probe });
  assert.ok(store.ok);
  if (!store.ok) throw new Error("store");
  return { dir, clock, probe, lease: lease.value, store: store.value };
}

async function approvedTask(store: RunStore): Promise<string> {
  const taskId = newId("task");
  assert.ok((await store.addTask("Fixture task", 3, taskId)).ok);
  assert.ok((await store.recordApproval(human(), { kind: "spec", task: taskId, artifact: { path: "docs/spec.md", hash: HASH_A }, decision: "approved" })).ok);
  assert.ok((await store.recordApproval(human(), { kind: "plan", task: taskId, artifact: { path: "docs/plan.md", hash: HASH_A }, decision: "approved" })).ok);
  return taskId;
}

function assignmentInput(task: string, newCandidateRound = true) {
  return { task, role: "developer" as const, profile: PROFILE, briefHash: HASH_B, limitMs: 30 * 60_000, maxAutomaticRecoveries: 1, artifacts: { spec: HASH_A, plan: HASH_A }, newCandidateRound };
}

test("coordinator lease: live or unknown owners are respected, dead owners reclaimed with a new generation", async () => {
  const dir = tempDir();
  try {
    const clock = new FakeClock();
    const record = { schema: "radian.coordinator-lease/1", project: "prj_fixture1", token: "t", generation: 4, owner: { pid: 424242, start: "then" }, acquiredAt: "x", expiresAtMs: 0 };
    writeFileSync(CoordinatorLease.file(dir), JSON.stringify(record));
    const alive = await CoordinatorLease.acquire(dir, "prj_fixture1", { clock, probe: fakeProbe({ 424242: "then" }) });
    assert.equal(alive.ok ? "ok" : alive.blocker.code, "LEASE_HELD");
    const unknown = await CoordinatorLease.acquire(dir, "prj_fixture1", { clock, probe: fakeProbe({ 424242: "unknown" }) });
    assert.equal(unknown.ok ? "ok" : unknown.blocker.code, "LEASE_HELD");
    const reused = await CoordinatorLease.acquire(dir, "prj_fixture1", { clock, probe: fakeProbe({ 424242: "a-different-start" }) });
    assert.ok(reused.ok, "PID reuse with a different start time is a dead owner");
    if (!reused.ok) return;
    assert.equal(reused.value.generation, 5);
    // A superseded holder can no longer write.
    const old = new CoordinatorLease(dir, { ...record, generation: 4 } as never, { clock });
    assert.equal((() => { const c = old.checkHeld(); return c.ok ? "ok" : c.blocker.code; })(), "LEASE_LOST");
    clock.advance(31_000);
    assert.equal((() => { const c = reused.value.checkHeld(); return c.ok ? "ok" : c.blocker.code; })(), "LEASE_LOST");
    // An expired lease is a loss to respond to (R06), not something a late renewal silently revives.
    const late = await reused.value.renew();
    assert.equal(late.ok ? "ok" : late.blocker.code, "LEASE_LOST");
    assert.equal(reused.value.checkHeld().ok, false);
    const other = await CoordinatorLease.acquire(dir, "prj_other1", { clock, probe: fakeProbe({}) });
    assert.equal(other.ok ? "ok" : other.blocker.code, "DUPLICATE_BINDING");
  } finally {
    removeDir(dir);
  }
});

test("writes require a held lease; a superseding coordinator blocks the old one", async () => {
  const { dir, clock, store } = await setup();
  try {
    const leaseFile = CoordinatorLease.file(dir);
    const record = JSON.parse(readFileSync(leaseFile, "utf8"));
    writeFileSync(leaseFile, JSON.stringify({ ...record, token: "someone-else", generation: record.generation + 1 }));
    const blocked = await store.addTask("x", 3);
    assert.equal(blocked.ok ? "ok" : blocked.blocker.code, "LEASE_LOST");
    clock.advance(1);
  } finally {
    removeDir(dir);
  }
});

test("approvals: only genuine human channels, bound to artifact hashes and exact candidates", async () => {
  const { dir, store } = await setup();
  try {
    const task = await approvedTask(store);
    const forged = Object.create(HumanChannel.prototype) as HumanChannel;
    const forgedResult = await store.recordApproval(forged, { kind: "plan", task, artifact: { path: "docs/plan.md", hash: HASH_A }, decision: "approved" });
    assert.equal(forgedResult.ok ? "ok" : forgedResult.blocker.code, "APPROVAL_NOT_HUMAN");
    assert.equal(approvalValidity(store.state, { task, kind: "spec" }, { artifactHash: HASH_A }).state, "valid");
    assert.equal(approvalValidity(store.state, { task, kind: "spec" }, { artifactHash: HASH_B }).state, "stale");
    assert.ok((await store.invalidateChangedApprovals({ "docs/spec.md": HASH_B })).ok);
    assert.equal(approvalValidity(store.state, { task, kind: "spec" }, { artifactHash: HASH_A }).state, "stale");
    const blocked = await store.createAssignment(assignmentInput(task));
    assert.equal(blocked.ok ? "ok" : blocked.blocker.code, "APPROVAL_STALE");
    const noTarget = await store.recordApproval(human(), { kind: "integration", task, artifact: { path: "docs/plan.md", hash: HASH_A }, decision: "approved" });
    assert.equal(noTarget.ok ? "ok" : noTarget.blocker.code, "AUTHORITY_INVALID");
    const candidate = { commit: "1".repeat(40), tree: "2".repeat(40), base: "3".repeat(40) };
    const target = { ref: "refs/heads/main", commit: "3".repeat(40) };
    assert.ok((await store.recordApproval(human(), { kind: "integration", task, artifact: { path: "docs/plan.md", hash: HASH_A }, candidate, target, decision: "approved" })).ok);
    assert.equal(approvalValidity(store.state, { task, kind: "integration" }, { artifactHash: HASH_A, candidate, target }).state, "valid");
    assert.equal(approvalValidity(store.state, { task, kind: "integration" }, { artifactHash: HASH_A, candidate: { ...candidate, commit: "4".repeat(40) }, target }).state, "stale");
    assert.equal(approvalValidity(store.state, { task, kind: "integration" }, { artifactHash: HASH_A, candidate, target: { ...target, commit: "5".repeat(40) } }).state, "stale");
  } finally {
    removeDir(dir);
  }
});

test("three total candidate rounds; more only by recorded human grant", async () => {
  const { dir, store } = await setup();
  try {
    const task = await approvedTask(store);
    // Each cycle ends with an assembled candidate; the next candidate work starts the next cycle (R07).
    const candidate = (i: number) => ({ commit: String(i).repeat(40), tree: "e".repeat(40), base: "f".repeat(40) });
    for (let i = 0; i < 3; i += 1) {
      assert.ok((await store.createAssignment(assignmentInput(task))).ok);
      assert.ok((await store.recordCandidate(task, candidate(i + 1))).ok);
    }
    assert.equal(store.state.tasks[task]?.roundsUsed, 3);
    const fourth = await store.createAssignment(assignmentInput(task));
    assert.equal(fourth.ok ? "ok" : fourth.blocker.code, "ROUNDS_EXHAUSTED");
    // Review work on the current candidate does not consume a cycle.
    assert.ok((await store.createAssignment({ ...assignmentInput(task, false), role: "reviewer" })).ok);
    assert.equal(store.state.tasks[task]?.roundsUsed, 3);
    assert.ok((await store.grantRounds(human(), task, 1, "dec_fixture01")).ok);
    assert.ok((await store.createAssignment(assignmentInput(task))).ok);
    assert.equal(store.state.tasks[task]?.roundsUsed, 4);
    const ambiguous = await store.classifyFailure(task, "ambiguous", "check infrastructure unclear");
    assert.ok(ambiguous.ok);
    assert.ok(Object.values(store.state.decisions).some((d) => d.kind === "accounting" && d.status === "open"));
  } finally {
    removeDir(dir);
  }
});

test("execution budget starts at binding, excludes blocked time, and is inherited by recovery", async () => {
  const { dir, clock, store } = await setup();
  try {
    const task = await approvedTask(store);
    const asgId = newId("asg");
    assert.ok((await store.createAssignment(assignmentInput(task), asgId)).ok);
    clock.advance(5 * 60_000); // queue time is not execution time
    const started = await store.startAttempt(asgId);
    assert.ok(started.ok, started.ok ? "" : started.blocker.message);
    const attempt1 = store.state.assignments[asgId]!.attempts[0]!;
    clock.advance(2 * 60_000); // preflight time is not execution time
    const identity = (attempt: { id: string; generation: number }): AssignmentIdentity => ({ workspace: "ws_fixture1", project: "prj_fixture1", run: store.state.run.id, task, assignment: asgId, attempt: attempt.id, generation: attempt.generation, role: "developer" });
    assert.ok((await store.bindAttempt(identity(attempt1))).ok);
    clock.advance(10 * 60_000);
    assert.ok((await store.block(asgId, "question", "Which API version?")).ok);
    clock.advance(60 * 60_000); // question wait excluded
    const decision = Object.values(store.state.decisions).find((d) => d.status === "open")!;
    assert.ok((await store.resolveDecision(human(), decision.id, "Use v2")).ok);
    assert.equal(store.state.assignments[asgId]!.status, "running");
    clock.advance(5 * 60_000);
    assert.equal(store.remainingMs(asgId), 15 * 60_000);
    // Crash: unknown termination blocks replacement until verified.
    assert.ok((await store.endAttempt(asgId, attempt1.id, "infrastructure", "unknown")).ok);
    const blocked = await store.startAttempt(asgId);
    assert.equal(blocked.ok ? "ok" : blocked.blocker.code, "TERMINATION_UNVERIFIED");
    assert.ok((await store.endAttempt(asgId, attempt1.id, "infrastructure", "verified")).ok);
    assert.ok((await store.startAttempt(asgId)).ok, "one automatic recovery");
    const attempt2 = store.state.assignments[asgId]!.attempts[1]!;
    assert.equal(attempt2.generation, 2);
    // A stale binding from generation 1 is rejected.
    const stale = await store.bindAttempt(identity(attempt1));
    assert.equal(stale.ok ? "ok" : stale.blocker.code, "STALE_GENERATION");
    assert.ok((await store.bindAttempt(identity(attempt2))).ok);
    clock.advance(15 * 60_000);
    assert.equal(store.remainingMs(asgId), 0);
    assert.ok((await store.endAttempt(asgId, attempt2.id, "timeout", "verified")).ok);
    const exhausted = await store.startAttempt(asgId, {});
    assert.equal(exhausted.ok ? "ok" : exhausted.blocker.code, "RECOVERY_EXHAUSTED");
    assert.ok((await store.authorizeRecovery(human(), asgId, "dec_fixture02")).ok);
    const noTime = await store.startAttempt(asgId, { humanDecisionId: "dec_fixture02" });
    assert.equal(noTime.ok ? "ok" : noTime.blocker.code, "EXECUTION_BUDGET_EXHAUSTED");
    const budget = store.state.assignments[asgId]!.budget;
    assert.equal(budget.blockedMs.question, 60 * 60_000);
  } finally {
    removeDir(dir);
  }
});

test("results: validated, deduplicated, persisted before notification; stale ones rejected", async () => {
  const { dir, store } = await setup();
  const exchange = tempDir();
  try {
    const task = await approvedTask(store);
    const asgId = newId("asg");
    assert.ok((await store.createAssignment(assignmentInput(task), asgId)).ok);
    assert.ok((await store.startAttempt(asgId)).ok);
    const attempt = store.state.assignments[asgId]!.attempts[0]!;
    const identity: AssignmentIdentity = { workspace: "ws_fixture1", project: "prj_fixture1", run: store.state.run.id, task, assignment: asgId, attempt: attempt.id, generation: 1, role: "developer" };
    assert.ok((await store.bindAttempt(identity)).ok);
    const result = {
      schema: "radian.result/1", identity, briefHash: HASH_B, outcome: "completed", summary: "done", deliverables: [], checks: [], findings: [], unmetCriteria: [], risks: [], decisionRequests: [],
      handoff: { dirty: true, incomplete: [], runningServices: [], ownedResources: [] }, usage: { status: "unknown" }, modelAttestation: "unverified",
    };
    writeFileSync(path.join(exchange, "result.json"), JSON.stringify(result));
    const first = await collectResult(store, exchange, { identity, briefHash: HASH_B });
    assert.ok(first.ok);
    if (first.ok) assert.equal(first.value.duplicate, false);
    const second = await collectResult(store, exchange, { identity, briefHash: HASH_B });
    assert.ok(second.ok && second.value.duplicate);
    assert.equal(Object.keys(store.state.results).length, 1);
    assert.ok(readFileSync(path.join(store.runDir, "results", `${hashJson(result).slice(7)}.json`), "utf8").includes("radian.result/1"));
    writeFileSync(path.join(exchange, "result.json"), JSON.stringify({ ...result, identity: { ...identity, generation: 7 }, summary: "x" }));
    const stale = await collectResult(store, exchange, { identity, briefHash: HASH_B });
    assert.equal(stale.ok ? "ok" : stale.blocker.code, "STALE_GENERATION");
    writeFileSync(path.join(exchange, "result.json"), JSON.stringify({ ...result, summary: "y", approval: "granted" }));
    const spoof = await collectResult(store, exchange, { identity, briefHash: HASH_B });
    assert.equal(spoof.ok ? "ok" : spoof.blocker.code, "RESULT_INVALID");
  } finally {
    removeDir(dir);
    removeDir(exchange);
  }
});

test("event log: replay matches snapshot, torn tail is quarantined, tampering is detected", async () => {
  const { dir, lease, probe, clock, store } = await setup();
  try {
    await approvedTask(store);
    assert.ok(snapshotMatchesLog(store.runDir));
    const events = path.join(store.runDir, "events.jsonl");
    appendFileSync(events, '{"seq": 99, "partial');
    const reopened = await RunStore.open(dir, store.state.run.id, lease, { clock, probe });
    assert.ok(reopened.ok);
    if (!reopened.ok) return;
    assert.ok(loadRunDir(store.runDir).ok);
    assert.ok((await reopened.value.addTask("after crash", 3)).ok);
    const lines = readFileSync(events, "utf8").split("\n");
    lines[1] = lines[1]!.replace("Fixture task", "Edited task");
    writeFileSync(events, lines.join("\n"));
    const tampered = loadRunDir(store.runDir);
    assert.equal(tampered.ok ? "ok" : tampered.blocker.code, "STATE_CORRUPT");
  } finally {
    removeDir(dir);
  }
});

test("paused runs keep their configuration unless a human approves migration", async () => {
  const { dir, store } = await setup();
  try {
    assert.ok((await store.pause("user pause")).ok);
    const changed = await store.resume(HASH_B);
    assert.equal(changed.ok ? "ok" : changed.blocker.code, "CONFIG_CHANGED_FOR_PAUSED_RUN");
    assert.ok((await store.resume(HASH_B, { channel: human(), decisionId: "dec_migrate1" })).ok);
    assert.equal(store.state.run.configHash, HASH_B);
  } finally {
    removeDir(dir);
  }
});

test("reconciliation closes verified attempts and leaves unknown ones blocking replacement", async () => {
  const { dir, store } = await setup();
  try {
    const task = await approvedTask(store);
    const a = newId("asg");
    const b = newId("asg");
    assert.ok((await store.createAssignment(assignmentInput(task), a)).ok);
    assert.ok((await store.createAssignment({ ...assignmentInput(task, false), role: "tester" }, b)).ok);
    assert.ok((await store.startAttempt(a)).ok);
    assert.ok((await store.startAttempt(b)).ok);
    const report = await reconcileRun(store, (assignment) => (assignment === a ? "terminated" : "unknown"));
    assert.equal(report.closedVerified.length, 1);
    assert.equal(report.unknown.length, 1);
    const replace = await store.startAttempt(b);
    assert.equal(replace.ok ? "ok" : replace.blocker.code, "TERMINATION_UNVERIFIED");
    assert.ok((await store.startAttempt(a)).ok);
  } finally {
    removeDir(dir);
  }
});

test("capacity: cross-process contention never exceeds the ceiling", async () => {
  const dir = tempDir();
  try {
    const child = path.join(import.meta.dirname, "reserve-child.ts");
    const outputs = await Promise.all(Array.from({ length: 6 }, (_, i) => run(process.execPath, [child, dir, "3", `asg_fixture-${i}00000`]).then((r) => r.stdout)));
    assert.equal(outputs.filter((o) => o === "ok").length, 3);
    assert.equal(outputs.filter((o) => o === "CAPACITY_FULL").length, 3);
    const ledger = new CapacityLedger(dir);
    assert.equal((await ledger.list()).length, 3);
  } finally {
    removeDir(dir);
  }
});

test("capacity: blocked workers keep slots; reclaim only verified terminations", async () => {
  const dir = tempDir();
  try {
    const ledger = new CapacityLedger(dir, { probe: fakeProbe({}) });
    const r1 = await ledger.reserve(2, { project: "p", run: "r", assignment: "a1", role: "developer" });
    const r2 = await ledger.reserve(2, { project: "p", run: "r", assignment: "a2", role: "developer" });
    assert.ok(r1.ok && r2.ok);
    if (!r1.ok || !r2.ok) return;
    assert.ok((await ledger.setState(r1.value.id, "blocked")).ok);
    const full = await ledger.reserve(2, { project: "p", run: "r", assignment: "a3", role: "tester" });
    assert.equal(full.ok ? "ok" : full.blocker.code, "CAPACITY_FULL");
    const unverified = await ledger.release(r2.value.id, "unknown");
    assert.equal(unverified.ok ? "ok" : unverified.blocker.code, "TERMINATION_UNVERIFIED");
    const reclaim = await ledger.reclaim((r) => (r.id === r1.value.id ? "unknown" : "terminated"));
    assert.deepEqual(reclaim.reclaimed, [r2.value.id]);
    assert.equal(reclaim.retained[0]?.evidence, "unknown");
    assert.ok((await ledger.reserve(2, { project: "p", run: "r", assignment: "a3", role: "tester" })).ok);
  } finally {
    removeDir(dir);
  }
});

test("locks held by live or unverifiable owners are not broken", async () => {
  const dir = tempDir();
  try {
    const lockDir = path.join(dir, "lock");
    mkdirSync(lockDir);
    writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ token: "x", identity: { pid: 515151, start: "s" }, purpose: "test" }));
    await assert.rejects(withLock(lockDir, "t", () => 1, { probe: fakeProbe({ 515151: "s" }), timeoutMs: 100 }));
    await assert.rejects(withLock(lockDir, "t", () => 1, { probe: fakeProbe({ 515151: "unknown" }), timeoutMs: 100 }));
    assert.equal(await withLock(lockDir, "t", () => 2, { probe: fakeProbe({}), timeoutMs: 100 }), 2);
  } finally {
    removeDir(dir);
  }
});

test("project binding: unregistered, nested, moved, and duplicate bindings are refused", () => {
  const root = tempDir();
  try {
    const workspace = path.join(root, "ws");
    const project = path.join(workspace, "proj");
    mkdirSync(path.join(workspace, ".radian", "state"), { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(workspace, ".radian", "workspace.json"), JSON.stringify({ schema: "radian.workspace/1", workspace: "ws_fixture1", canonicalRoot: workspace }));
    const registry = { schema: "radian.workspace-registry/1", workspace: "ws_fixture1", projects: [{ project: "prj_fixture1", canonicalPath: project }] };
    const writeRegistry = (value: unknown) => writeFileSync(path.join(workspace, ".radian", "state", "projects.json"), JSON.stringify(value));
    const code = () => { const r = checkProjectBinding(project); return r.ok ? "ok" : r.blocker.code; };
    writeRegistry(registry);
    const ok = checkProjectBinding(project);
    assert.ok(ok.ok && ok.value.project === "prj_fixture1" && ok.value.workspaceRoot === workspace);
    writeRegistry({ ...registry, projects: [] });
    assert.equal(code(), "INSTALL_TARGET_INVALID");
    writeRegistry({ ...registry, projects: [...registry.projects, { project: "prj_fixture1", canonicalPath: "/copy" }] });
    assert.equal(code(), "DUPLICATE_BINDING");
    writeRegistry(registry);
    writeFileSync(path.join(workspace, ".radian", "workspace.json"), JSON.stringify({ schema: "radian.workspace/1", workspace: "ws_fixture1", canonicalRoot: "/elsewhere" }));
    assert.equal(code(), "DUPLICATE_BINDING");
    writeFileSync(path.join(workspace, ".radian", "workspace.json"), JSON.stringify({ schema: "radian.workspace/1", workspace: "ws_fixture1", canonicalRoot: workspace }));
    mkdirSync(path.join(root, ".radian"), { recursive: true });
    writeFileSync(path.join(root, ".radian", "workspace.json"), JSON.stringify({ schema: "radian.workspace/1", workspace: "ws_outer01", canonicalRoot: root }));
    assert.equal(code(), "DUPLICATE_BINDING", "nested workspaces are ambiguous");
    const outside = tempDir();
    try {
      const r = checkProjectBinding(outside);
      assert.equal(r.ok ? "ok" : r.blocker.code, "INSTALL_TARGET_INVALID");
    } finally {
      removeDir(outside);
    }
  } finally {
    removeDir(root);
  }
});
