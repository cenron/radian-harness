// W05 — activation and background ownership in one emulated Pi process at
// the workspace root (each switch replaces the extension runtime, per W01).
// Fake runs only; no worker, model, or real Pi process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { success } from "../../../src/contracts/blockers.ts";
import { psProbe } from "../../../src/util/process-identity.ts";

/** A live process other than this one (the test runner's parent), as a foreign lock holder. */
function liveForeignOwner(): { pid: number; start: string } {
  const probe = psProbe(process.ppid);
  if (probe.state !== "running") throw new Error("parent process identity unavailable");
  return { pid: process.ppid, start: probe.start };
}
import { confinedAccessSupported } from "../../../src/util/confined-fs.ts";
import { ownerKey, processRuntime } from "../../../src/ui/workspace-runtime.ts";
import { projectPaths } from "../../../src/workspace/layout.ts";
import { removeDir } from "../helpers/fixture.ts";
import { FakePiProcess, stubStartRun, workspaceWorld } from "../helpers/workspace-world.ts";

const opts = { skip: confinedAccessSupported() ? false : "needs macOS O_NOFOLLOW_ANY" };

function projectView(pi: FakePiProcess) {
  const v = pi.controller.view();
  if (v.kind !== "project") throw new Error(`expected a project view, got ${v.kind}`);
  return v;
}

test("A/B switching replaces only the conversation: same process, fixed cwd, restored A, carried model and thinking", opts, async () => {
  const w = await workspaceWorld(["alpha", "beta"]);
  try {
    const pi = new FakePiProcess(w.ws, path.join(w.root, "sessions"));
    await pi.start();
    const dashboardFile = pi.session.file;
    pi.thinking = "high";
    pi.host.thinking = "high";
    assert.equal(await pi.command("projects", "alpha"), "");
    const a = projectView(pi);
    assert.equal(a.project.repo.root, w.dirs.alpha);
    assert.equal(pi.cwd, w.ws, "Pi's cwd stays the workspace root");
    assert.notEqual(pi.session.file, dashboardFile);
    assert.equal(pi.thinking, "high", "a new session would reset thinking; Radian re-applies the interface level");
    assert.deepEqual(pi.model, { provider: "fake", id: "model-1" }, "and the model");
    const aFile = pi.session.file;
    assert.match(pi.state.status ?? "", /^PLAN · alpha · \d+\/3 workers|^PLAN · alpha/);
    assert.equal(await pi.command("projects", "alpha"), "Project alpha is already selected.");
    await pi.command("radian", "mode build");
    assert.equal(await pi.command("projects", "beta"), "");
    const b = projectView(pi);
    assert.equal(b.project.repo.root, w.dirs.beta);
    assert.equal(b.project.mode.mode, "plan", "modes are per project");
    assert.ok(b.generation > a.generation);
    assert.equal(await pi.command("projects", "alpha"), "");
    const a2 = projectView(pi);
    assert.equal(pi.session.file, aFile, "A's own conversation is restored");
    assert.equal(a2.project.mode.mode, "build");
    assert.equal(a2.project.binding.project, a.project.binding.project, "the same project identity (an owner without a run is reopened to revalidate configuration)");
    assert.deepEqual(pi.shutdownReasons, ["new", "new", "resume"]);
    assert.equal(pi.thinking, "high", "resume would restore A's saved level; the interface level is kept");
    assert.equal(await pi.command("workspace"), "");
    assert.equal(pi.controller.view().kind, "dashboard");
    // Project instructions follow the view.
    const event = { systemPromptOptions: { cwd: w.ws, contextFiles: [] as Array<{ path: string; content: string }> } };
    await pi.host.emit("before_agent_start", event, pi.ctx());
    assert.equal(event.systemPromptOptions.cwd, w.ws);
  } finally {
    removeDir(w.root);
  }
});

test("activation needs an idle boundary and a valid, present, unlocked target; failures leave the previous view", opts, async () => {
  const w = await workspaceWorld(["alpha", "beta", "gamma"]);
  try {
    const pi = new FakePiProcess(w.ws, path.join(w.root, "sessions"));
    await pi.start();
    pi.busy = true;
    assert.match(await pi.command("projects", "alpha"), /SESSION_BUSY/);
    pi.busy = false;
    pi.pending = true;
    assert.match(await pi.command("projects", "alpha"), /SESSION_BUSY[\s\S]*queued input never moves/);
    pi.pending = false;
    assert.equal(pi.controller.view().kind, "dashboard");
    assert.match(await pi.command("projects", "nope"), /PROJECT_UNAVAILABLE/);
    // A missing project is listed as such and cannot be selected.
    renameSync(w.dirs.gamma!, `${w.dirs.gamma}.away`);
    assert.match(await pi.command("projects"), /gamma \[missing\]/);
    assert.match(await pi.command("projects", "gamma"), /PROJECT_UNAVAILABLE/);
    // Another live Pi process holding beta's context refuses selection.
    const lock = path.join(projectPaths(w.ws, w.id("beta")).state, "view-lock.json");
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, JSON.stringify({ schema: "radian.view-lock/1", owner: liveForeignOwner(), project: w.id("beta") }));
    assert.match(await pi.command("projects", "beta"), /CONTEXT_LOCKED/);
    assert.equal(pi.controller.view().kind, "dashboard", "the previous view is unchanged");
    // Project-local Pi resources are reported, never loaded.
    mkdirSync(path.join(w.dirs.alpha!, ".pi", "extensions"), { recursive: true });
    writeFileSync(path.join(w.dirs.alpha!, ".pi", "extensions", "x.ts"), "export default () => {}\n");
    assert.equal(await pi.command("projects", "alpha"), "");
    assert.match(pi.state.notes.at(-1) ?? "", /not loaded here: \.pi\/extensions/);
  } finally {
    removeDir(w.root);
  }
});

test("a stale or foreign project conversation is blocked on restore, and navigation still works from it", opts, async () => {
  const w = await workspaceWorld(["alpha", "beta"]);
  try {
    const pi = new FakePiProcess(w.ws, path.join(w.root, "sessions"));
    await pi.start();
    await pi.command("projects", "alpha");
    const aFile = pi.session.file;
    await pi.command("workspace");
    // The private reference now names a newer context: the old conversation is stale.
    const ref = path.join(projectPaths(w.ws, w.id("alpha")).state, "context.json");
    writeFileSync(ref, JSON.stringify({ ...JSON.parse(readFileSync(ref, "utf8")), contextId: "ctx_newer" }));
    await pi.ctx().switchSession!(aFile);
    const v = pi.controller.view();
    assert.equal(v.kind, "blocked");
    assert.match(v.kind === "blocked" ? v.blocker.message : "", /stale/);
    assert.match((await pi.tool("read", { path: "alpha/src/alpha.txt" })).blocked ?? "", /RH-WORKSPACE-BLOCKED/, "no tool runs in a stale project conversation");
    assert.match(await pi.command("projects"), /alpha/);
    assert.equal(await pi.command("workspace"), "");
    assert.equal(pi.controller.view().kind, "dashboard");
  } finally {
    removeDir(w.root);
  }
});

test("background ownership survives view changes and reloads; only a real quit stops it, under live/unknown rules", opts, async () => {
  const w = await workspaceWorld(["alpha", "beta"]);
  try {
    const live: Array<{ assignment: string; role: "developer" }> = [];
    const calls: string[] = [];
    const base = stubStartRun(live);
    const startRun: ReturnType<typeof stubStartRun> = async (session) => {
      const run = await base(session);
      if (run.ok) {
        run.value.supervision = { release: () => calls.push(`release ${session.binding.project}`), dropHeartbeat: () => calls.push(`drop ${session.binding.project}`), health: () => success(true as const) } as never;
        run.value.safety = { stop: () => calls.push(`stop ${session.binding.project}`) };
      }
      return run;
    };
    const pi = new FakePiProcess(w.ws, path.join(w.root, "sessions"), { startRun });
    await pi.start();
    await pi.command("projects", "alpha");
    assert.match(await pi.command("radian", "start"), /Run \S+ is active/);
    const run = projectView(pi).project.run!;
    live.push({ assignment: "asg_live", role: "developer" });
    await pi.command("projects", "beta");
    await pi.host.emit("session_shutdown", { reason: "reload" }, pi.ctx());
    await pi.start();
    assert.deepEqual(calls, [], "view changes and reloads never stop owned work");
    assert.equal(processRuntime().owners.get(ownerKey(w.ws, w.id("alpha")))?.run, run, "alpha's run is retained while beta is shown");
    await pi.command("projects", "alpha");
    assert.equal(projectView(pi).project.run, run, "revisiting reuses the run; no second coordinator or lease");
    assert.match(await pi.command("radian", "start"), new RegExp(`Run ${run.store.state.run.id} is active`));
    await pi.quit();
    assert.deepEqual(calls.sort(), [`drop ${w.id("alpha")}`, `stop ${w.id("alpha")}`], "with live work the watcher is left unfed (loss stops it), never orderly released");
    assert.equal(processRuntime().owners.size, 0);
  } finally {
    removeDir(w.root);
  }
});

test("direct entry and the workspace interface never hold the same project context at once", opts, async () => {
  const w = await workspaceWorld(["alpha"]);
  try {
    const direct = new FakePiProcess(w.dirs.alpha!, path.join(w.root, "direct"));
    await direct.start();
    assert.equal(projectView(direct).direct, true);
    // Emulate a second process: the lock names a different, live-looking owner.
    const lock = path.join(projectPaths(w.ws, w.id("alpha")).state, "view-lock.json");
    const held = JSON.parse(readFileSync(lock, "utf8"));
    writeFileSync(lock, JSON.stringify({ ...held, owner: liveForeignOwner() }));
    const ws = new FakePiProcess(w.ws, path.join(w.root, "ws-sessions"));
    await ws.start();
    assert.match(await ws.command("projects", "alpha"), /CONTEXT_LOCKED/);
    assert.match(await direct.command("projects", "alpha"), /direct entry|already selected/);
  } finally {
    removeDir(w.root);
  }
});

test("cancelled, failing, and overlapping switches leave the previous view and release what they took", opts, async () => {
  const w = await workspaceWorld(["alpha", "beta"]);
  try {
    const pi = new FakePiProcess(w.ws, path.join(w.root, "sessions"));
    await pi.start();
    await pi.command("projects", "alpha");
    const before = pi.session.file;
    const lockOf = (name: string) => path.join(projectPaths(w.ws, w.id(name)).state, "view-lock.json");
    pi.nextSwitch = "cancel";
    assert.match(await pi.command("projects", "beta"), /cancelled; the previous view is unchanged/);
    assert.equal(pi.session.file, before);
    assert.equal(projectView(pi).project.repo.root, w.dirs.alpha);
    assert.throws(() => readFileSync(lockOf("beta")), "the target's context lock was released");
    assert.equal(processRuntime().pending, undefined, "no carry-over is left for a later runtime");
    pi.nextSwitch = "throw";
    assert.match(await pi.command("projects", "beta"), /SESSION_BUSY[\s\S]*synthetic session creation failure/);
    assert.equal(projectView(pi).project.repo.root, w.dirs.alpha);
    assert.throws(() => readFileSync(lockOf("beta")));
    // Overlap: while one switch is held open, another is refused.
    let open!: () => void;
    pi.gate = new Promise((r) => (open = r));
    const first = pi.command("projects", "beta");
    await new Promise((r) => setTimeout(r, 30));
    assert.match(await pi.command("workspace"), /SESSION_BUSY[\s\S]*another project switch/);
    pi.gate = undefined;
    open();
    assert.equal(await first, "");
    assert.equal(projectView(pi).project.repo.root, w.dirs.beta);
  } finally {
    removeDir(w.root);
  }
});
