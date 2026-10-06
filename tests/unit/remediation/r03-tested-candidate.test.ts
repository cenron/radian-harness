// R03 — exact tested candidate identity. Check evidence counts toward
// integration only when the coordinator itself binds it to the recorded
// candidate, assignment, attempt, approved check, and verified termination,
// and the checkout it ran in still holds exactly the candidate. Worker-reported
// hashes and outcomes are claims. Exercised through the registered
// radian_dispatch / radian_assemble tools over a real Coordinator.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveAuthority } from "../../../src/contracts/authority.ts";
import { newId } from "../../../src/contracts/identity.ts";
import { CapabilityRegistry, type CapabilityContext } from "../../../src/isolation/capabilities.ts";
import { type LaunchSpec, launchContained, prepareLaunch, writeSpec } from "../../../src/isolation/launcher.ts";
import { PROFILE_TEMPLATE_VERSION, diagnoseAccess, generateProfile } from "../../../src/isolation/profile.ts";
import { HumanChannel } from "../../../src/state/approvals.ts";
import { removeDir } from "../helpers/fixture.ts";
import { layout } from "../helpers/layout.ts";
import { type Behaviour, type World, controllerOver, world } from "../helpers/coordinator-world.ts";

const CHECKS = [{ id: "unit", description: "unit tests", argv: ["npm", "test"] }];
const native = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

type UI = Awaited<ReturnType<typeof controllerOver>>;

async function candidateViaTools(w: World, ui: UI, base: string, repair = false): Promise<string> {
  w.driver.script("developer", { edit: { "src/a.ts": `export const a = ${Math.random()};\n` } });
  const dev = await ui.dispatch({ role: "developer", writeRoots: ["src"], newCandidateRound: true, ...(repair ? { baseCandidate: base } : {}) });
  w.driver.script("tester", { edit: { "tests/a.test.ts": `// acceptance ${Math.random()}\n` } });
  const tester = await ui.dispatch({ role: "tester", writeRoots: ["tests"], ...(repair ? { baseCandidate: base } : {}) });
  assert.ok(dev.assignment && tester.assignment, `${dev.text} / ${tester.text}`);
  const assembled = await ui.assemble([dev.assignment!, tester.assignment!], base);
  const commit = /Candidate ([0-9a-f]{40,64})/.exec(assembled.text ?? "")?.[1];
  assert.ok(commit, JSON.stringify(assembled));
  return commit!;
}

async function check(w: World, ui: UI, candidate: string, behaviour: Behaviour, extra: Record<string, unknown> = {}) {
  w.driver.script("tester", { checks: [{ id: "unit", outcome: "passed" }], ...behaviour });
  return ui.dispatch({ role: "tester", candidateCheck: true, baseCandidate: candidate, requiredChecks: CHECKS, ...extra });
}

async function unitAccepted(w: World): Promise<boolean> {
  const summary = await w.coordinator.integrationSummary(w.taskId, ["unit"]);
  assert.ok(summary.ok);
  return summary.ok && !summary.value.gaps.some((g) => g.startsWith("check unit"));
}

test("R03: a candidate check that modified source, tests, or config is not evidence for the original candidate", async () => {
  const w = await world();
  try {
    const ui = await controllerOver(w);
    const candidate = await candidateViaTools(w, ui, w.base);
    const accepted: string[] = [];
    for (const file of ["src/a.ts", "tests/a.test.ts", "package.json"]) {
      await check(w, ui, candidate, { edit: { [file]: "tampered by the tester\n" } });
      if (await unitAccepted(w)) accepted.push(file);
    }
    assert.deepEqual(accepted, [], "checks run on a changed checkout never count for the candidate");
    // Review the candidate so every remaining gap is the check itself.
    w.driver.script("reviewer", {});
    await ui.dispatch({ role: "reviewer", baseCandidate: candidate });
    const summary = await w.coordinator.integrationSummary(w.taskId, ["unit"]);
    assert.ok(summary.ok && !summary.value.ready, "integration is not ready on tampered evidence");
  } finally {
    removeDir(w.root);
  }
});

test("R03: candidate-check authority keeps source/tests/config immutable; only declared untracked output roots are writable", async () => {
  const w = await world();
  try {
    const ui = await controllerOver(w);
    const candidate = await candidateViaTools(w, ui, w.base);
    await check(w, ui, candidate, { edit: { "dist/out.js": "generated\n" } }, { checkOutputRoots: ["dist"] });
    const launch = w.driver.launches.at(-1)!;
    assert.equal(launch.brief.brief.base.candidate, candidate);
    const worktree = launch.authority.worktree;
    const input = { authority: launch.authority, dependencies: { readRoots: [], readFiles: [] }, gitPointer: path.join(worktree, ".git") };
    const writable = (relative: string) => diagnoseAccess(input, path.join(worktree, relative), "write").allowed;
    assert.deepEqual(["src/a.ts", "tests/a.test.ts", "package.json", "docs/spec.md", ".gitattributes"].filter(writable), [], "no tracked or config path is writable during an exact-candidate check");
    assert.equal(writable("dist/out.js"), true, "a declared untracked output root is writable");
    assert.ok(await unitAccepted(w), "a valid check with permitted generated output counts");
    // Output roots that contain tracked files are refused before launch.
    const launches = w.driver.launches.length;
    const refused = await check(w, ui, candidate, {}, { checkOutputRoots: ["src"] });
    assert.match(refused.text, /blocked/i);
    assert.equal(w.driver.launches.length, launches, "nothing launched");
    for (const roots of [[""], ["../x"], ["tests"]]) {
      const bad = await check(w, ui, candidate, {}, { checkOutputRoots: roots });
      assert.match(bad.text, /blocked/i, JSON.stringify(roots));
    }

    if (native) {
      // The same authority under the native containment profile: a transient
      // mutate-then-restore of tracked source cannot happen, generated output can.
      const profile = generateProfile(input);
      assert.ok(profile.ok);
      if (!profile.ok) return;
      const file = path.join(w.root, "check.sb");
      writeFileSync(file, profile.value.text);
      const run = (script: string) => spawnSync("/usr/bin/sandbox-exec", ["-f", file, "/bin/sh", "-c", script], { cwd: worktree, env: { PATH: "/usr/bin:/bin", HOME: launch.authority.scratchDir, TMPDIR: launch.authority.scratchDir }, timeout: 15_000 }).status;
      const before = readFileSync(path.join(worktree, "src", "a.ts"), "utf8");
      assert.notEqual(run("cp src/a.ts \"$TMPDIR/saved\" && echo tampered > src/a.ts && cp \"$TMPDIR/saved\" src/a.ts"), 0);
      assert.equal(readFileSync(path.join(worktree, "src", "a.ts"), "utf8"), before);
      assert.equal(run("mkdir -p dist && echo built > dist/out2.js"), 0);
    }
  } finally {
    removeDir(w.root);
  }
});

test("R03: unknown-termination, unexecuted, failed, timed-out, stale, and wrong-checkout checks are not passing evidence through the production path", async () => {
  const w = await world();
  try {
    const ui = await controllerOver(w);
    const first = await candidateViaTools(w, ui, w.base);
    const accepted: string[] = [];
    const attempt = async (label: string, candidate: string, behaviour: Behaviour) => {
      await check(w, ui, candidate, behaviour);
      if (await unitAccepted(w)) accepted.push(label);
    };
    await attempt("unknown termination", first, { termination: "unknown" });
    await attempt("no launcher execution record (worker claims passed)", first, { executed: [] });
    await attempt("execution failed while the worker claimed passed", first, { executed: [{ id: "unit", exitCode: 1 }] });
    await attempt("execution timed out", first, { executed: [{ id: "unit", exitCode: null, timedOut: true }] });
    await attempt("duplicate execution records", first, { executed: [{ id: "unit", exitCode: 0 }, { id: "unit", exitCode: 0 }] });
    await attempt("execution of a different check only", first, { executed: [{ id: "lint", exitCode: 0 }] });
    w.driver.script("tester", { staleGeneration: true }, { staleGeneration: true });
    await ui.dispatch({ role: "tester", candidateCheck: true, baseCandidate: first, requiredChecks: CHECKS });
    if (await unitAccepted(w)) accepted.push("stale attempts");
    assert.deepEqual(accepted, [], "none of these is evidence for the candidate");

    // A repair produces a new candidate; a check on the old checkout that claims
    // the new candidate's hash is refused, and old evidence never carries over.
    await check(w, ui, first, { claimCandidate: "e".repeat(40) });
    assert.ok(await unitAccepted(w), "a launcher-executed check on the verified exact checkout counts; the worker's claimed hash is irrelevant");
    assert.deepEqual(w.driver.launches.at(-1)!.checks?.runs, [{ id: "unit", argv: ["npm", "test"] }], "the launcher runs exactly the approved argument vector");
    const second = await candidateViaTools(w, ui, first, true);
    assert.notEqual(second, first);
    assert.equal(await unitAccepted(w), false, "evidence for the previous candidate is historical");
    await check(w, ui, first, { claimCandidate: second });
    assert.equal(await unitAccepted(w), false, "a check from the previous candidate's checkout is refused");
    await check(w, ui, second, {});
    assert.ok(await unitAccepted(w), "the new candidate is reverified on its own checkout");
    const evidence = w.coordinator.evidence(w.taskId);
    const unit = evidence.checks.find((c) => c.id === "unit")!;
    assert.equal(unit.candidate, second);
    assert.ok(unit.assignment && unit.attempt && unit.tree, "evidence is bound by the coordinator to assignment, attempt, and tree");
    assert.deepEqual(unit.argv, ["npm", "test"], "evidence records the approved argument vector");
  } finally {
    removeDir(w.root);
  }
});

test("R03: the contained launcher runs approved checks itself, without credentials or source writes, and records exit status", { skip: native ? false : "requires macOS sandbox-exec" }, async () => {
  const l = layout();
  try {
    const authority = resolveAuthority(
      { role: "tester", worktree: l.worktree, readRoots: [l.project], writeRoots: [], outputDir: l.output, scratchDir: l.scratch, operations: ["read", "shell", "run-checks", "write-report"] },
      { projectRoot: l.project, protectedPaths: [l.gitDir, l.state] },
    );
    assert.ok(authority.ok);
    if (!authority.ok) return;
    const projection = path.join(l.root, "projection");
    mkdirSync(projection);
    writeFileSync(path.join(projection, "auth.json"), '{"synthetic":"projected"}\n');
    const context: CapabilityContext = { osVersion: "27.0", runtime: "codex", runtimeVersion: "synthetic", policyTemplate: PROFILE_TEMPLATE_VERSION };
    await new CapabilityRegistry(l.state).record(HumanChannel.fromUserInput("user-command", "fixture-user", "/radian capability"), { capability: "containment.sandbox-exec.filesystem", status: "verified", context, reference: "synthetic fixture" });
    const identity = { workspace: newId("ws"), project: newId("prj"), run: newId("run"), task: newId("task"), assignment: newId("asg"), attempt: newId("att"), generation: 1, role: "tester" as const };
    const spec: LaunchSpec = {
      schema: "radian.launch/1",
      identity,
      stateDir: l.state,
      profile: { authority: authority.value, dependencies: { readRoots: [], readFiles: [] }, credentialDir: projection, gitPointer: path.join(l.worktree, ".git") },
      argv: ["/bin/sh", "-c", `cat "${projection}/auth.json" > "${l.output}/runtime-read.txt"`],
      env: { PATH: "/usr/bin:/bin", HOME: l.scratch, TMPDIR: l.scratch },
      cwd: l.worktree,
      requiredCapabilities: ["containment.sandbox-exec.filesystem"],
      capabilityContext: context,
      terminal: "none",
      checks: {
        runs: [
          { id: "writes-source", argv: ["/bin/sh", "-c", "echo tampered > src/input.txt"] },
          { id: "reads-credentials", argv: ["/bin/sh", "-c", `cat "${projection}/auth.json"`] },
          { id: "passes", argv: ["/bin/sh", "-c", "echo ok; exit 0"] },
          { id: "fails", argv: ["/bin/sh", "-c", "exit 3"] },
          { id: "hangs", argv: ["/bin/sleep", "30"] },
        ],
        timeoutMs: 4_000,
        logDir: l.output,
        env: { PATH: "/usr/bin:/bin", HOME: l.scratch, TMPDIR: l.scratch, LC_ALL: "C" },
      },
    };
    const specFile = path.join(l.state, "launch", "spec.json");
    const prepared = prepareLaunch(specFile, writeSpec(specFile, spec), undefined);
    assert.ok(prepared.ok, prepared.ok ? "" : prepared.blocker.message);
    if (!prepared.ok) return;
    const result = await launchContained(prepared.value, { stdio: "ignore" });
    assert.ok(result.ok);
    const records = Object.fromEntries(prepared.value.registry.checks(identity.attempt).map((r) => [r.id, r]));
    assert.notEqual(records["writes-source"]?.exitCode, 0, "a check cannot write candidate source");
    assert.equal(readFileSync(path.join(l.worktree, "src", "input.txt"), "utf8"), "task input\n");
    assert.notEqual(records["reads-credentials"]?.exitCode, 0, "a check cannot read the credential projection");
    assert.match(readFileSync(path.join(l.output, "runtime-read.txt"), "utf8"), /projected/, "control: the runtime profile can read its projection, so the check's denial is the credential rule");
    assert.equal(records["passes"]?.exitCode, 0);
    assert.equal(records["fails"]?.exitCode, 3);
    assert.equal(records["hangs"]?.timedOut, true);
    assert.match(readFileSync(path.join(l.output, "check-passes.log"), "utf8"), /ok/);
    assert.deepEqual(prepared.value.registry.unresolvedIntents(identity.attempt), [], "every check registration resolved");
    const order = prepared.value.registry.entries().map((e) => e.kind === "intent" ? `intent:${e.label}` : e.kind);
    assert.ok(order.indexOf("intent:runtime") > order.lastIndexOf("check"), "checks run before the runtime starts");
  } finally {
    removeDir(l.root);
  }
});
