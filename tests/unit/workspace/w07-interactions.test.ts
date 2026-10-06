// W07 — interactions between workspace-first view switching and the W06 safety
// properties: view replacement never weakens start authorization, cycle caps,
// retained ownership, or planning-write confinement. Real coordinator and
// stores, fake transport/driver, and the real launcher where noted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { mkdirSync, readdirSync, renameSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { success } from "../../../src/contracts/blockers.ts";
import { RuntimeWorkerDriver } from "../../../src/coordinator/driver.ts";
import { CapabilityRegistry } from "../../../src/isolation/capabilities.ts";
import { SupervisionRegistry } from "../../../src/isolation/registry.ts";
import type { HerdrRunner } from "../../../src/runtimes/herdr.ts";
import { confinedAccessSupported } from "../../../src/util/confined-fs.ts";
import { safeDirTestSeam } from "../../../src/util/safe-dir.ts";
import { processRuntime } from "../../../src/ui/workspace-runtime.ts";
import { removeDir } from "../helpers/fixture.ts";
import { layout } from "../helpers/layout.ts";
import { candidateRound, controllerOver, human, plan, world } from "../helpers/coordinator-world.ts";
import { deps, fakeCodex, native, source, verifyAll } from "../helpers/session-fixture.ts";
import { FakePiProcess, workspaceWorld } from "../helpers/workspace-world.ts";

const opts = { skip: confinedAccessSupported() ? false : "needs macOS O_NOFOLLOW_ANY" };

test("a plan rejected after the view was switched away still stops A's delayed launcher", { skip: native ? false : "requires macOS sandbox-exec" }, async () => {
  const w = await world();
  const l = layout();
  try {
    const ui = await controllerOver(w);
    const calls: string[][] = [];
    let n = 0;
    const runner: HerdrRunner = async (args) => {
      calls.push([...args]);
      if (args[1] === "split") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: `fx:w7-${++n}` } } }), stderr: "", timedOut: false };
      if (args[1] === "run") {
        // The user switches to another project, then (back in A) rejects the plan, before the pane's launcher starts.
        await ui.host.emit("session_shutdown", { reason: "new" }, ui.ctx);
        assert.ok(processRuntime().owners.size > 0, "A's execution owner survives the view change");
        assert.ok((await w.store.recordApproval(human(), { kind: "plan", task: w.taskId, artifact: { path: "docs/plan.md", hash: w.artifacts.plan }, decision: "rejected" })).ok);
        setTimeout(() => spawn("/bin/sh", ["-c", args[3]!], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } }).unref(), 1_000);
      }
      return { code: 0, stdout: "{}", stderr: "", timedOut: false };
    };
    await verifyAll(new CapabilityRegistry(w.stateDir), "developer");
    w.coordinator.deps.driver = new RuntimeWorkerDriver({ ...deps(l, fakeCodex(l, "bind-and-wait"), calls, true, runner), stateDir: w.stateDir, capabilities: new CapabilityRegistry(w.stateDir), projectionRoot: path.join(l.root, "projections") });
    w.coordinator.deps.credentialSourceFor = () => source({ count: 0 });
    w.coordinator.deps.startupMs = 4_000;
    const outcome = await w.coordinator.runAssignment(plan(w, "developer"));
    await new Promise((r) => setTimeout(r, 4_000));
    const a = Object.values(w.store.state.assignments)[0]!;
    const entries = new SupervisionRegistry(w.stateDir, a.id).entries();
    assert.ok(!entries.some((e) => e.kind === "intent" || e.kind === "process"), "nothing started under the stale approval");
    assert.equal(outcome.state === "blocked" ? outcome.blocker.code : outcome.state, "APPROVAL_STALE");
    assert.equal((await w.capacity.list()).length, 0);
  } finally {
    removeDir(w.root);
    removeDir(l.root);
  }
});

test("candidate-cycle caps hold across view switches (the run is reused, not reset)", async () => {
  const w = await world();
  try {
    const ui = await controllerOver(w);
    let base: { kind: "target" } | { kind: "commit"; commit: string } = { kind: "target" };
    for (let i = 0; i < 3; i += 1) {
      const candidate = await candidateRound(w, base);
      base = { kind: "commit", commit: candidate.commit };
    }
    await ui.host.emit("session_shutdown", { reason: "new" }, ui.ctx);
    await ui.host.emit("session_start", { reason: "resume" }, ui.ctx);
    assert.equal(ui.controller.session()?.run?.coordinator, w.coordinator, "the same coordinator owns the run after the switch");
    const fourth = await ui.dispatch({ role: "developer", baseCandidate: (base as { commit: string }).commit, writeRoots: ["src"] });
    assert.match(fourth.text, /ROUNDS_EXHAUSTED/);
  } finally {
    removeDir(w.root);
  }
});

test("retained unknown-termination work survives a view switch and still blocks an orderly release at quit", async () => {
  const w = await world();
  try {
    const ui = await controllerOver(w);
    const calls: string[] = [];
    ui.controller.session()!.run!.supervision = { release: () => calls.push("release"), dropHeartbeat: () => calls.push("dropHeartbeat"), health: () => success(true as const) } as never;
    w.driver.script("developer", { launchResult: "uncertain", termination: "unknown" });
    await w.coordinator.runAssignment(plan(w, "developer"));
    await ui.host.emit("session_shutdown", { reason: "new" }, ui.ctx);
    assert.deepEqual(calls, [], "a view switch neither releases nor drops ownership");
    await ui.host.emit("session_start", { reason: "resume" }, ui.ctx);
    await ui.host.emit("session_shutdown", { reason: "quit" }, ui.ctx);
    assert.deepEqual(calls, ["dropHeartbeat"]);
  } finally {
    w.coordinator.stopMonitoring();
    removeDir(w.root);
  }
});

test("a planning write in a workspace-selected project cannot create outside directories through a parent race", opts, async () => {
  const w = await workspaceWorld(["alpha"]);
  const outside = path.join(w.root, "outside");
  mkdirSync(outside);
  const planning = path.join(w.dirs.alpha!, ".radian", "planning");
  mkdirSync(planning, { recursive: true });
  let swapped = false;
  const swap = () => {
    if (swapped) return;
    swapped = true;
    renameSync(planning, `${planning}.moved`);
    symlinkSync(outside, planning);
  };
  const original = fs.mkdirSync;
  try {
    const pi = new FakePiProcess(w.ws, path.join(w.root, "sessions"));
    await pi.start();
    assert.equal(await pi.command("projects", "alpha"), "");
    fs.mkdirSync = ((target: fs.PathLike, o?: fs.MakeDirectoryOptions) => {
      if (String(target) === path.join(planning, "drafts")) swap();
      return original(target, o as never);
    }) as typeof fs.mkdirSync;
    syncBuiltinESMExports();
    safeDirTestSeam.beforeMutate = (dir, ops) => {
      if (dir === planning && ops[0]?.op === "mkdir") swap();
    };
    const result = await pi.tool("radian_write_artifact", { path: "drafts/plan.md", content: "x" });
    assert.ok(swapped && result.error, JSON.stringify(result));
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    fs.mkdirSync = original;
    syncBuiltinESMExports();
    delete safeDirTestSeam.beforeMutate;
    removeDir(w.root);
  }
});
