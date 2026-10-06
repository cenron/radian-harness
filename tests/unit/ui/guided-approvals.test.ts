// Proposal 0016 — guided approvals. The coordinator requests a decision; Radian
// renders a dialog from disk; only the user's choice records anything. The
// approval points (PRD/spec or brief, plan, integration) are unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { success } from "../../../src/contracts/blockers.ts";
import { registerRadian } from "../../../src/ui/controller.ts";
import { openProjectSession } from "../../../src/ui/session.ts";
import { processRuntime } from "../../../src/ui/workspace-runtime.ts";
import { removeDir } from "../helpers/fixture.ts";
import { type FakeCtxState, FakeHost, context, fakeRuntime, managedWorld } from "../helpers/pi-host.ts";

const SPEC = ".radian/planning/spec.md";
const PLAN = ".radian/planning/plan.md";
const PLAN_TEXT = '# Plan\nBuild it.\n\n```radian-checks\nunit: ["npm", "test"]\n```\n';
const REQUESTS = ["radian_request_approval", "radian_request_start", "radian_request_integration"];

async function guidedWorld() {
  const w = await managedWorld();
  w.fixture.write(SPEC, "# ASCII RPG prototype\nOne map, one character.\n");
  const host = new FakeHost();
  const controller = registerRadian(host, { loadRuntime: async () => fakeRuntime, openSession: openProjectSession, startRun: w.startRun });
  const state: FakeCtxState = { confirms: [], confirmAnswer: true, notes: [] };
  const tui = context(w.projectDir, "tui", state);
  await host.emit("session_start", {}, tui);
  await host.emit("input", { text: "looks good, ask me to approve", source: "interactive" }, tui);
  const store = () => controller.session()!.run?.store.state;
  const approvals = () => Object.values(store()?.approvals ?? {});
  const tasks = () => Object.values(store()?.tasks ?? {});
  /** Answer the next dialog(s) with the option matching `pattern`. */
  const choose = (pattern: RegExp) => {
    state.selectAnswer = (_title, options) => options.find((o) => pattern.test(o));
  };
  return { w, host, controller, state, tui, approvals, tasks, choose, cleanup: () => removeDir(w.root) };
}

test("0016: request tools are registered model-only and the PRD approval creates the task only when the user approves", async () => {
  const g = await guidedWorld();
  try {
    for (const name of REQUESTS) assert.equal(g.host.definitions.get(name)?.exposure, "model-only", `${name} cannot be called from other tools`);
    // Dismissed (Escape): nothing recorded, no task.
    let out = await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, g.tui);
    assert.match(out.text ?? "", /not approved|nothing was recorded/i, JSON.stringify(out));
    assert.equal(g.approvals().length, 0);
    assert.equal(g.tasks().length, 0);
    const shown = g.state.selects!.at(-1)!;
    assert.doesNotMatch(shown.options[0]!, /approve/i, "Enter on the initial selection does not approve");
    assert.match(shown.title, /ASCII RPG prototype/, "the title is read from the artifact on disk");
    assert.match(shown.title, /\.radian\/planning\/spec\.md/);
    assert.match(shown.title, /content [0-9a-f]{12}/, "the user sees the exact content hash");
    assert.match(shown.title, /creates task/i, "the dialog says a task will be created");
    // Cancel: nothing.
    g.choose(/^cancel/i);
    await g.host.emit("input", { text: "again", source: "interactive" }, g.tui);
    out = await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, g.tui);
    assert.equal(g.approvals().length, 0);
    assert.equal(g.tasks().length, 0);
    // Approve: one task titled from the draft, one human approval bound to it.
    g.choose(/^approve/i);
    await g.host.emit("input", { text: "again", source: "interactive" }, g.tui);
    out = await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, g.tui);
    assert.match(out.text ?? "", /spec approved/i, JSON.stringify(out));
    const [task] = g.tasks();
    assert.equal(g.tasks().length, 1);
    assert.equal(task!.title, "ASCII RPG prototype");
    const [approval] = g.approvals();
    assert.equal(approval!.task, task!.id);
    assert.equal(approval!.kind, "spec");
    assert.equal(approval!.decision, "approved");
    assert.equal(approval!.actor.kind, "human");
    assert.equal(approval!.channel, "user-ui");
    assert.match(out.text ?? "", new RegExp(task!.id), "the coordinator learns the task id");
  } finally {
    g.cleanup();
  }
});

test("0016: an existing task is reused; with open tasks the request must name one or ask for a new one", async () => {
  const g = await guidedWorld();
  try {
    g.choose(/^approve/i);
    await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, g.tui);
    const task = g.tasks()[0]!.id;
    g.w.fixture.write(SPEC, "# ASCII RPG prototype\nRevised.\n");
    await g.host.emit("input", { text: "revised", source: "interactive" }, g.tui);
    const ambiguous = await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, g.tui);
    assert.match(ambiguous.text ?? "", /TASK_REQUIRED|name the task/i, JSON.stringify(ambiguous));
    assert.match(ambiguous.text ?? "", new RegExp(task), "the open task is listed");
    const unknown = await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC, task: "task_invented" }, g.tui);
    assert.match(unknown.text ?? "", /unknown task/i);
    const reused = await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC, task }, g.tui);
    assert.match(reused.text ?? "", /spec approved/i, JSON.stringify(reused));
    assert.equal(g.tasks().length, 1, "no duplicate task");
    assert.equal(g.approvals().filter((a) => a.task === task && a.kind === "spec").length, 2);
    const fresh = await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC, newTask: true, title: "Second prototype" }, g.tui);
    assert.match(fresh.text ?? "", /spec approved/i);
    assert.deepEqual(g.tasks().map((t) => t.title).sort(), ["ASCII RPG prototype", "Second prototype"]);
  } finally {
    g.cleanup();
  }
});

test("0016: guided requests are refused without an interactive terminal or after non-interactive input, and record nothing", async () => {
  const g = await guidedWorld();
  try {
    g.choose(/^approve/i);
    for (const mode of ["print", "json", "rpc"] as const) {
      const out = await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, context(g.w.projectDir, mode, g.state));
      assert.match(out.text ?? "", /NONINTERACTIVE_APPROVAL_REQUIRED/, `${mode}: ${JSON.stringify(out)}`);
    }
    for (const source of ["rpc", "extension"] as const) {
      await g.host.emit("input", { text: "approve it", source }, g.tui);
      const out = await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, g.tui);
      assert.match(out.text ?? "", /APPROVAL_NOT_HUMAN/, `${source}: ${JSON.stringify(out)}`);
    }
    assert.equal(g.state.selects?.length ?? 0, 0, "no dialog was shown");
    assert.equal(g.approvals().length, 0);
    assert.equal(g.tasks().length, 0);
  } finally {
    g.cleanup();
  }
});

test("0016: an artifact edited or a project switched while the dialog is open records nothing", async () => {
  const g = await guidedWorld();
  try {
    g.state.selectAnswer = (_t, options) => {
      g.w.fixture.write(SPEC, "# ASCII RPG prototype\nChanged while the dialog was open.\n");
      return options.find((o) => /^approve/i.test(o));
    };
    const edited = await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, g.tui);
    assert.match(edited.text ?? "", /APPROVAL_STALE/, JSON.stringify(edited));
    assert.equal(g.approvals().length, 0);
    assert.equal(g.tasks().length, 0);
    const before = processRuntime().generation;
    g.state.selectAnswer = (_t, options) => {
      processRuntime().generation += 1;
      return options.find((o) => /^approve/i.test(o));
    };
    await g.host.emit("input", { text: "again", source: "interactive" }, g.tui);
    const switched = await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, g.tui);
    processRuntime().generation = before;
    assert.match(switched.text ?? "", /STALE_GENERATION/, JSON.stringify(switched));
    assert.equal(g.approvals().length, 0);
    assert.equal(g.tasks().length, 0);
  } finally {
    g.cleanup();
  }
});

test("0016: a declined request is not reopened until the user speaks again; request changes returns the user's note", async () => {
  const g = await guidedWorld();
  try {
    g.choose(/^cancel/i);
    await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, g.tui);
    const shown = g.state.selects!.length;
    g.choose(/^approve/i);
    const again = await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, g.tui);
    assert.match(again.text ?? "", /declined/i, JSON.stringify(again));
    assert.equal(g.state.selects!.length, shown, "no dialog reopened in the same turn");
    await g.host.emit("input", { text: "ok, ask again", source: "interactive" }, g.tui);
    g.choose(/request changes/i);
    g.state.inputAnswer = "Add a minimum window size.";
    const changes = await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, g.tui);
    assert.match(changes.text ?? "", /Add a minimum window size\./);
    assert.equal(g.approvals().length, 0);
    // A second concurrent dialog is refused while one is open.
    await g.host.emit("input", { text: "ok", source: "interactive" }, g.tui);
    let release: (v: string | undefined) => void = () => {};
    g.state.selectAnswer = () => new Promise((r) => (release = r));
    const first = g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, g.tui);
    await new Promise((r) => setTimeout(r, 10));
    const second = await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, g.tui);
    assert.match(second.text ?? "", /DECISION_OPEN|already open/i, JSON.stringify(second));
    release(undefined);
    await first;
  } finally {
    g.cleanup();
  }
});

test("0016: start approves the plan and switches only this project to Build; checks and profiles come from disk/config", async () => {
  const g = await guidedWorld();
  try {
    g.w.fixture.write(PLAN, PLAN_TEXT);
    g.choose(/^approve/i);
    // Before the PRD is approved there is nothing to start.
    const early = await g.host.callTool("radian_request_start", { task: "task_none", planPath: PLAN }, g.tui);
    assert.match(early.text ?? "", /unknown task|APPROVAL_MISSING/i);
    await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, g.tui);
    const task = g.tasks()[0]!.id;
    // A plan without radian-checks cannot start.
    g.w.fixture.write(".radian/planning/bare.md", "# Plan\nNo checks.\n");
    const bare = await g.host.callTool("radian_request_start", { task, planPath: ".radian/planning/bare.md" }, g.tui);
    assert.match(bare.text ?? "", /radian-checks/, JSON.stringify(bare));
    assert.equal(g.controller.session()!.mode.mode, "plan");
    const out = await g.host.callTool("radian_request_start", { task, planPath: PLAN }, g.tui);
    assert.match(out.text ?? "", /plan approved/i, JSON.stringify(out));
    assert.match(out.text ?? "", /radian_dispatch/, "the coordinator is told to dispatch next");
    const shown = g.state.selects!.at(-1)!;
    assert.doesNotMatch(shown.options[0]!, /approve/i);
    assert.match(shown.title, /unit: npm test/, "exact check argument vectors parsed by Radian");
    assert.match(shown.title, /developer-standard/, "the default profile is shown");
    assert.match(shown.title, /gpt-6\.1-sol/);
    assert.match(shown.title, /spec .*approved/i, "the approved PRD is named");
    const plan = g.approvals().find((a) => a.kind === "plan")!;
    assert.equal(plan.task, task);
    assert.equal(plan.decision, "approved");
    assert.equal(plan.channel, "user-ui");
    assert.equal(g.controller.session()!.mode.mode, "build");
  } finally {
    g.cleanup();
  }
});

test("0016: start is refused without a current PRD approval and records nothing", async () => {
  const g = await guidedWorld();
  try {
    g.w.fixture.write(PLAN, PLAN_TEXT);
    g.choose(/^approve/i);
    await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, g.tui);
    const task = g.tasks()[0]!.id;
    g.w.fixture.write(SPEC, "# ASCII RPG prototype\nEdited after approval.\n");
    const shown = g.state.selects!.length;
    const out = await g.host.callTool("radian_request_start", { task, planPath: PLAN }, g.tui);
    assert.match(out.text ?? "", /APPROVAL_STALE|APPROVAL_MISSING/, JSON.stringify(out));
    assert.equal(g.state.selects!.length, shown, "no dialog");
    assert.equal(g.approvals().filter((a) => a.kind === "plan").length, 0);
    assert.equal(g.controller.session()!.mode.mode, "plan");
  } finally {
    g.cleanup();
  }
});

test("0016: integration via dialog binds the exact candidate and target and runs the existing integrate path", async () => {
  const g = await guidedWorld();
  try {
    g.w.fixture.write(PLAN, PLAN_TEXT);
    g.choose(/^approve/i);
    await g.host.callTool("radian_request_approval", { kind: "spec", path: SPEC }, g.tui);
    const task = g.tasks()[0]!.id;
    await g.host.callTool("radian_request_start", { task, planPath: PLAN }, g.tui);
    const run = g.controller.session()!.run!;
    const candidate = { commit: "c".repeat(40), tree: "d".repeat(40), base: "e".repeat(40) };
    const target = { ref: "refs/heads/main", commit: "e".repeat(40) };
    let ready = false;
    const integrated: unknown[] = [];
    Object.assign(run.coordinator as object, {
      evidence: () => ({ checks: [], risks: [], requiredChecks: ["unit"] }),
      integrationSummary: async () => success({ candidate, target, checks: [{ id: "unit", outcome: "passed" }], review: { candidate: candidate.commit, blockingFindings: 0, outcome: "completed", findings: 1 }, risks: [], ready, gaps: ready ? [] : ["review missing"] }),
      integrate: async (channel: unknown, t: string, required: readonly string[], artifact: { path: string }) => {
        integrated.push({ channel, t, required, artifact });
        return success({ from: target.commit, to: candidate.commit });
      },
    });
    const shown = g.state.selects!.length;
    const notReady = await g.host.callTool("radian_request_integration", { task }, g.tui);
    assert.match(notReady.text ?? "", /not ready.*review missing/i, JSON.stringify(notReady));
    assert.equal(g.state.selects!.length, shown, "a not-ready summary is not approvable");
    ready = true;
    const out = await g.host.callTool("radian_request_integration", { task }, g.tui);
    assert.match(out.text ?? "", /Integrated/, JSON.stringify(out));
    const dialog = g.state.selects!.at(-1)!;
    assert.doesNotMatch(dialog.options[0]!, /approve/i);
    assert.match(dialog.title, /cccccccccccc/);
    assert.match(dialog.title, /refs\/heads\/main/);
    assert.match(dialog.title, /unit=passed/);
    const plan = g.approvals().find((a) => a.kind === "plan")!;
    const approval = g.approvals().find((a) => a.kind === "integration")!;
    assert.deepEqual(approval.candidate, candidate);
    assert.deepEqual(approval.target, target);
    assert.equal(approval.artifact.path, PLAN, "bound to the task's approved plan");
    assert.equal(integrated.length, 1);
    assert.deepEqual((integrated[0] as { required: string[] }).required, ["unit"]);
    // A later rejection of the plan makes a merge request unusable, without a dialog.
    await g.controller.session()!.run!.store.recordApproval((await import("../helpers/coordinator-world.ts")).human(), { kind: "plan", task, artifact: { path: PLAN, hash: plan.artifact.hash }, decision: "rejected" });
    const afterReject = g.state.selects!.length;
    const rejected = await g.host.callTool("radian_request_integration", { task }, g.tui);
    assert.match(rejected.text ?? "", /APPROVAL_MISSING.*rejected/, JSON.stringify(rejected));
    assert.equal(g.state.selects!.length, afterReject);
  } finally {
    g.cleanup();
  }
});
