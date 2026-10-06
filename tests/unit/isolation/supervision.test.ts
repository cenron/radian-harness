import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { newId, type AssignmentIdentity } from "../../../src/contracts/identity.ts";
import { CapabilityRegistry, type CapabilityContext } from "../../../src/isolation/capabilities.ts";
import { type LaunchSpec, launchContained, prepareLaunch, writeSpec } from "../../../src/isolation/launcher.ts";
import { type ProcessOps, type ProcessRow, systemProcessOps } from "../../../src/isolation/processes.ts";
import { PROFILE_TEMPLATE_VERSION } from "../../../src/isolation/profile.ts";
import { SupervisionRegistry } from "../../../src/isolation/registry.ts";
import { SupervisionClient } from "../../../src/isolation/supervision.ts";
import { terminateOwned } from "../../../src/isolation/terminate.ts";
import { Watcher, lossFile } from "../../../src/isolation/watcher.ts";
import { HumanChannel } from "../../../src/state/approvals.ts";
import { FakeClock } from "../../../src/util/clock.ts";
import { psProbe } from "../../../src/util/process-identity.ts";
import { removeDir, tempDir } from "../helpers/fixture.ts";
import { authorityFor, layout } from "../helpers/layout.ts";

const native = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

class FakeOps implements ProcessOps {
  rows: ProcessRow[];
  cwd: number[] = [];
  ignoreTerm = new Set<number>();
  signals: Array<[number, string]> = [];
  tableAvailable = true;
  constructor(rows: ProcessRow[]) {
    this.rows = rows;
  }
  table() {
    return this.tableAvailable ? this.rows.map((r) => ({ ...r })) : undefined;
  }
  cwdWithin() {
    return this.cwd;
  }
  signal(pid: number, signal: "SIGTERM" | "SIGKILL") {
    this.signals.push([pid, signal]);
    if (signal === "SIGKILL" || !this.ignoreTerm.has(pid)) this.rows = this.rows.filter((r) => r.pid !== pid);
    return true;
  }
}

const row = (pid: number, ppid: number, start = `start-${pid}`): ProcessRow => ({ pid, ppid, pgid: pid, start });
const noWait = async () => undefined;

test("termination: registered and descendant processes, TERM then KILL, verified postcondition", async () => {
  const ops = new FakeOps([row(100, 1), row(101, 100), row(102, 101), row(200, 1)]);
  ops.ignoreTerm.add(102);
  const outcome = await terminateOwned(ops, { registered: [{ pid: 100, start: "start-100" }], ownedRoots: [], unresolvedIntents: 0, protectedPids: [], graceMs: 0 }, noWait);
  assert.equal(outcome.postcondition, "verified");
  assert.equal(outcome.discovered, 2);
  assert.ok(ops.signals.some(([pid, s]) => pid === 102 && s === "SIGKILL"), "TERM-ignoring child escalated");
  assert.ok(!ops.signals.some(([pid]) => pid === 200), "unrelated process never signalled");
});

test("termination: reused PIDs, cwd-only suspects, interrupted registration, and missing ps are unknown", async () => {
  const reused = new FakeOps([row(100, 1, "a-new-process")]);
  const r1 = await terminateOwned(reused, { registered: [{ pid: 100, start: "old-start" }], ownedRoots: [], unresolvedIntents: 0, protectedPids: [], graceMs: 0 }, noWait);
  assert.equal(reused.signals.length, 0, "a reused PID is not signalled");
  assert.equal(r1.postcondition, "verified");

  const suspect = new FakeOps([row(300, 1)]);
  suspect.cwd = [300];
  const r2 = await terminateOwned(suspect, { registered: [], ownedRoots: ["/x"], unresolvedIntents: 0, protectedPids: [], graceMs: 0 }, noWait);
  assert.equal(suspect.signals.length, 0, "a process found only by working directory is not signalled");
  assert.equal(r2.postcondition, "unknown");

  const interrupted = await terminateOwned(new FakeOps([]), { registered: [], ownedRoots: [], unresolvedIntents: 1, protectedPids: [], graceMs: 0 }, noWait);
  assert.equal(interrupted.postcondition, "unknown");

  const blind = new FakeOps([row(100, 1)]);
  blind.tableAvailable = false;
  const r4 = await terminateOwned(blind, { registered: [{ pid: 100, start: "start-100" }], ownedRoots: [], unresolvedIntents: 0, protectedPids: [], graceMs: 0 }, noWait);
  assert.equal(r4.postcondition, "unknown");

  const protectedOps = new FakeOps([row(400, 1)]);
  await terminateOwned(protectedOps, { registered: [{ pid: 400, start: "start-400" }], ownedRoots: [], unresolvedIntents: 0, protectedPids: [400], graceMs: 0 }, noWait);
  assert.equal(protectedOps.signals.length, 0, "protected coordinator/watcher PIDs are never signalled");
});

test("real processes: a detached TERM-ignoring child is escalated and verified gone", { skip: process.platform === "darwin" ? false : "macOS process tools" }, async () => {
  const dir = tempDir();
  try {
    const program = 'use POSIX qw(setsid); $|=1; my $pid = fork(); if ($pid == 0) { setsid(); $SIG{TERM}="IGNORE"; print "$$\\n"; sleep 60; exit 0; } print "$$\\n"; sleep 60;';
    const parent = spawn("/usr/bin/perl", ["-e", program], { cwd: dir, stdio: ["ignore", "pipe", "ignore"], detached: true });
    const pids = await new Promise<number[]>((resolve) => {
      let data = "";
      parent.stdout!.on("data", (chunk) => {
        data += chunk;
        const lines = data.split("\n").filter(Boolean);
        if (lines.length >= 2) resolve(lines.map(Number));
      });
    });
    const parentState = psProbe(parent.pid!);
    assert.equal(parentState.state, "running");
    if (parentState.state !== "running") return;
    const outcome = await terminateOwned(systemProcessOps, { registered: [{ pid: parent.pid!, start: parentState.start }], ownedRoots: [dir], unresolvedIntents: 0, protectedPids: [], graceMs: 300 });
    for (const pid of pids) assert.equal(psProbe(pid).state, "absent", "owned process survived");
    assert.equal(outcome.postcondition, "verified");
    assert.ok(outcome.escalated >= 1);
  } finally {
    removeDir(dir);
  }
});

test("watcher: lease expiry stops watched execution, destroys projections, preserves work", async () => {
  const dir = tempDir();
  try {
    const clock = new FakeClock();
    const ops = new FakeOps([row(500, 1), row(501, 500)]);
    const assignment = newId("asg");
    const attempt = newId("att");
    const registry = new SupervisionRegistry(dir, assignment, clock);
    await registry.append({ kind: "intent", attempt, label: "runtime" });
    await registry.append({ kind: "process", attempt, label: "runtime", identity: { pid: 500, start: "start-500" }, source: "launcher" });
    const projection = path.join(dir, "projection");
    const worktree = path.join(dir, "worktree");
    mkdirSync(projection);
    mkdirSync(worktree);
    writeFileSync(path.join(projection, "auth.json"), "{}");
    writeFileSync(path.join(worktree, "unfinished.ts"), "work in progress\n");
    mkdirSync(path.join(dir, "supervision"), { recursive: true });
    writeFileSync(path.join(dir, "supervision", "watch.json"), JSON.stringify({ schema: "radian.watch/1", coordinator: { pid: 999, start: "c" }, assignments: [{ assignment, attempt, ownedRoots: [worktree], projectionDirs: [projection] }] }));
    const watcher = new Watcher({ stateDir: dir, leaseMs: 1000, graceMs: 0, ops, clock, self: { pid: process.pid, start: "w" } });
    clock.advance(500);
    watcher.beat();
    clock.advance(900);
    assert.equal(watcher.expired(), false);
    clock.advance(200);
    assert.equal(watcher.expired(), true, "a live but stalled coordinator expires the lease");
    const report = await watcher.onLoss("lease-expired");
    assert.equal(report.outcomes[0]?.outcome.postcondition, "verified");
    assert.ok(report.outcomes[0]?.projectionsDestroyed);
    assert.ok(!existsSync(projection));
    assert.equal(readFileSync(path.join(worktree, "unfinished.ts"), "utf8"), "work in progress\n");
    assert.ok(registry.entries().some((e) => e.kind === "terminated"));
    assert.ok(existsSync(lossFile(dir)));
    assert.ok(!ops.signals.some(([pid]) => pid === 999), "coordinator PID protected");
  } finally {
    removeDir(dir);
  }
});

test("independent watcher process stops owned work when the coordinator heartbeat pipe closes", { skip: process.platform === "darwin" ? false : "macOS process tools" }, async () => {
  const dir = tempDir();
  const sleeper = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
  try {
    const state = psProbe(sleeper.pid!);
    assert.equal(state.state, "running");
    if (state.state !== "running") return;
    const assignment = newId("asg");
    const attempt = newId("att");
    await new SupervisionRegistry(dir, assignment).append({ kind: "process", attempt, label: "runtime", identity: { pid: sleeper.pid!, start: state.start }, source: "launcher" });
    const client = new SupervisionClient({ stateDir: dir, leaseMs: 2000, graceMs: 200 });
    const started = await client.start();
    assert.ok(started.ok, started.ok ? "" : started.blocker.message);
    await client.watch({ assignment, attempt, ownedRoots: [], projectionDirs: [] });
    assert.ok(client.health().ok);
    client.dropHeartbeat();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && psProbe(sleeper.pid!).state === "running") await new Promise((r) => setTimeout(r, 100));
    assert.equal(psProbe(sleeper.pid!).state, "absent", "registered worker stopped after coordinator loss");
    while (Date.now() < deadline && !existsSync(lossFile(dir))) await new Promise((r) => setTimeout(r, 50));
    const report = JSON.parse(readFileSync(lossFile(dir), "utf8"));
    assert.equal(report.reason, "heartbeat-eof");
    const after = Date.now() + 5000;
    while (Date.now() < after && client.health().ok) await new Promise((r) => setTimeout(r, 50));
    assert.equal(client.health().ok, false, "watcher loss is detected as unhealthy supervision");
  } finally {
    try {
      process.kill(sleeper.pid!, "SIGKILL");
    } catch {
      // already gone
    }
    removeDir(dir);
  }
});

function identity(): AssignmentIdentity {
  return { workspace: newId("ws"), project: newId("prj"), run: newId("run"), task: newId("task"), assignment: newId("asg"), attempt: newId("att"), generation: 1, role: "developer" };
}

test("launcher: refuses tampered specs, unverified capabilities, and prohibited env; registers before binding", { skip: native ? false : "requires macOS sandbox-exec" }, async () => {
  const l = layout();
  try {
    const authority = authorityFor(l);
    const context: CapabilityContext = { osVersion: "27.0", runtime: "pi", runtimeVersion: "synthetic", policyTemplate: PROFILE_TEMPLATE_VERSION };
    const spec: LaunchSpec = {
      schema: "radian.launch/1",
      identity: identity(),
      stateDir: l.state,
      profile: { authority, dependencies: { readRoots: [], readFiles: [] }, gitPointer: path.join(l.worktree, ".git") },
      argv: ["/bin/sh", "-c", `echo contained > src/result.txt; echo escape > "${l.outside}/x" 2>/dev/null; exit 0`],
      env: { PATH: "/usr/bin:/bin", HOME: l.scratch, TMPDIR: l.scratch },
      cwd: l.worktree,
      requiredCapabilities: ["containment.sandbox-exec.filesystem"],
      capabilityContext: context,
      terminal: "none",
    };
    const specFile = path.join(l.state, "launch", "spec.json");
    const hash = writeSpec(specFile, spec);
    const unverified = prepareLaunch(specFile, hash, undefined);
    assert.equal(unverified.ok ? "ok" : unverified.blocker.code, "CAPABILITY_UNVERIFIED");
    await new CapabilityRegistry(l.state).record(HumanChannel.fromUserInput("user-command", "fixture-user", "/radian capability"), { capability: "containment.sandbox-exec.filesystem", status: "verified", context, reference: "synthetic fixture" });
    const tampered = prepareLaunch(specFile, "sha256:" + "0".repeat(64), undefined);
    assert.equal(tampered.ok ? "ok" : tampered.blocker.code, "POLICY_TAMPERED");
    const envFile = path.join(l.state, "launch", "env-spec.json");
    const envHash = writeSpec(envFile, { ...spec, env: { ...spec.env, ANTHROPIC_API_KEY: "x" } });
    const envBlocked = prepareLaunch(envFile, envHash, undefined);
    assert.equal(envBlocked.ok ? "ok" : envBlocked.blocker.code, "CUSTOM_ENDPOINT_PROHIBITED");
    const ttyFile = path.join(l.state, "launch", "tty-spec.json");
    const ttyHash = writeSpec(ttyFile, { ...spec, terminal: "assigned" });
    const noTty = prepareLaunch(ttyFile, ttyHash, undefined);
    assert.equal(noTty.ok ? "ok" : noTty.blocker.code, "CONTAINMENT_UNAVAILABLE");

    const prepared = prepareLaunch(specFile, hash, undefined);
    assert.ok(prepared.ok, prepared.ok ? "" : prepared.blocker.message);
    if (!prepared.ok) return;
    let registeredBeforeExit = false;
    const result = await launchContained(prepared.value, { stdio: "ignore", onRegistered: () => { registeredBeforeExit = prepared.value.registry.processes().length === 1; } });
    assert.ok(result.ok && result.value.exitCode === 0);
    assert.ok(registeredBeforeExit, "runtime identity registered before binding could be confirmed");
    assert.equal(readFileSync(path.join(l.worktree, "src", "result.txt"), "utf8"), "contained\n");
    assert.ok(!existsSync(path.join(l.outside, "x")), "launched runtime is contained");
    const entries = prepared.value.registry.entries();
    assert.equal(entries[0]?.kind, "intent");
    assert.equal(prepared.value.registry.unresolvedIntents().length, 0);
    assert.ok(spawnSync("/bin/test", ["-r", prepared.value.profileFile]).status === 0);
  } finally {
    removeDir(l.root);
  }
});
