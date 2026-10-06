import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkProjectBinding } from "../../../src/state/binding.ts";
import { applyPlan, planInstall, planRemove, planUpdate, recover, status } from "../../../src/workspace/installer.ts";
import { parseCommand, runCommand } from "../../../src/workspace/cli.ts";
import { projectPaths, workspacePaths } from "../../../src/workspace/layout.ts";
import { makeRepo, removeDir, tempDir } from "../helpers/fixture.ts";
import { fakeProbe } from "../helpers/probe.ts";

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function fixture() {
  const root = tempDir();
  const workspace = path.join(root, "workspace");
  const a = path.join(workspace, "project-a");
  const b = path.join(workspace, "project-b");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  for (const dir of [a, b]) {
    const repo = await makeRepo(dir);
    repo.write("README.md", "synthetic\n");
    repo.write("AGENTS.md", "user's own instructions\n");
    await repo.commitAll("base");
  }
  return { root, workspace, a, b };
}

const local = { kind: "local" as const, path: HARNESS };
const settingsOf = (project: string) => JSON.parse(readFileSync(path.join(project, ".pi", "settings.json"), "utf8"));

test("preview writes nothing; apply requires the exact reviewed plan hash", async () => {
  const f = await fixture();
  try {
    const plan = await planInstall({ workspaceRoot: f.workspace, source: local, projects: [{ path: f.a, target: "refs/heads/main" }] });
    assert.ok(plan.ok, plan.ok ? "" : plan.blocker.message);
    if (!plan.ok) return;
    assert.ok(!existsSync(path.join(f.workspace, ".radian")) && !existsSync(path.join(f.a, ".pi")), "preview made no changes");
    const wrong = applyPlan(plan.value, "sha256:" + "0".repeat(64));
    assert.equal(wrong.ok ? "ok" : wrong.blocker.code, "INSTALL_CONFLICT");
    const tampered = applyPlan({ ...plan.value, actions: plan.value.actions.slice(1) }, plan.value.hash);
    assert.equal(tampered.ok ? "ok" : tampered.blocker.code, "POLICY_TAMPERED");
    assert.ok(applyPlan(plan.value, plan.value.hash).ok);
    const binding = checkProjectBinding(f.a);
    assert.ok(binding.ok, binding.ok ? "" : binding.blocker.message);
    const entry = settingsOf(f.a).packages[0];
    assert.equal(path.resolve(f.a, ".pi", entry.source), HARNESS, "local development binding resolves to the harness checkout");
    assert.equal(readFileSync(path.join(f.a, "AGENTS.md"), "utf8"), "user's own instructions\n", "AGENTS.md untouched");
    assert.ok(!existsSync(path.join(f.b, ".pi")), "unregistered sibling repositories are not bound");
    // Re-applying the same (now stale) plan fails without writing.
    const again = applyPlan(plan.value, plan.value.hash);
    assert.equal(again.ok ? "ok" : again.blocker.code, "INSTALL_CONFLICT");
  } finally {
    removeDir(f.root);
  }
});

test("install merges into existing project settings and preserves unrelated entries", async () => {
  const f = await fixture();
  try {
    mkdirSync(path.join(f.a, ".pi"));
    writeFileSync(path.join(f.a, ".pi", "settings.json"), JSON.stringify({ theme: "dark", packages: ["npm:some-other-package@1.0.0"] }));
    const plan = await planInstall({ workspaceRoot: f.workspace, source: local, projects: [{ path: f.a, target: "refs/heads/main" }] });
    assert.ok(plan.ok);
    if (!plan.ok) return;
    assert.ok(applyPlan(plan.value, plan.value.hash).ok);
    const settings = settingsOf(f.a);
    assert.equal(settings.theme, "dark");
    assert.equal(settings.packages[0], "npm:some-other-package@1.0.0");
    assert.equal(settings.packages.length, 2);
    // Remove only Radian's entry; the user's settings file stays.
    const remove = planRemove(f.workspace, fakeProbe({}));
    assert.ok(remove.ok);
    if (!remove.ok) return;
    assert.ok(applyPlan(remove.value, remove.value.hash).ok);
    assert.deepEqual(settingsOf(f.a), { theme: "dark", packages: ["npm:some-other-package@1.0.0"] });
    assert.ok(!existsSync(workspacePaths(f.workspace).manifest));
  } finally {
    removeDir(f.root);
  }
});

test("remove preserves local edits and runtime state; refuses while runs are active", async () => {
  const f = await fixture();
  try {
    const plan = await planInstall({ workspaceRoot: f.workspace, source: local, projects: [{ path: f.a, target: "refs/heads/main" }, { path: f.b, target: "refs/heads/main" }] });
    assert.ok(plan.ok && applyPlan(plan.value, plan.value.hash).ok);
    if (!plan.ok) return;
    // The user customizes Radian's entry in project B.
    const settingsB = settingsOf(f.b);
    settingsB.packages[0] = { ...settingsB.packages[0], skills: [] };
    writeFileSync(path.join(f.b, ".pi", "settings.json"), JSON.stringify(settingsB));
    const binding = checkProjectBinding(f.a);
    assert.ok(binding.ok);
    if (!binding.ok) return;
    const state = projectPaths(f.workspace, binding.value.project).state;
    mkdirSync(path.join(state, "runs", "run_fixture-1"), { recursive: true });
    writeFileSync(path.join(state, "evidence-kept.json"), "{}");
    // An active coordinator blocks removal.
    writeFileSync(path.join(state, "coordinator-lease.json"), JSON.stringify({ owner: { pid: 777001, start: "s" } }));
    const blocked = planRemove(f.workspace, fakeProbe({ 777001: "s" }));
    assert.equal(blocked.ok ? "ok" : blocked.blocker.code, "RUN_ACTIVE");
    const remove = planRemove(f.workspace, fakeProbe({}));
    assert.ok(remove.ok);
    if (!remove.ok) return;
    assert.ok(remove.value.conflicts.some((c) => c.includes("project-b")));
    assert.ok(applyPlan(remove.value, remove.value.hash).ok);
    assert.ok(!existsSync(path.join(f.a, ".pi", "settings.json")), "a settings file Radian created and emptied is removed");
    assert.deepEqual(settingsOf(f.b), settingsB, "the user's modified entry is retained");
    assert.ok(existsSync(path.join(state, "evidence-kept.json")), "runtime state and evidence are retained");
  } finally {
    removeDir(f.root);
  }
});

test("update between runs replaces unchanged owned entries and reports local modifications", async () => {
  const f = await fixture();
  try {
    const plan = await planInstall({ workspaceRoot: f.workspace, source: local, projects: [{ path: f.a, target: "refs/heads/main" }, { path: f.b, target: "refs/heads/main" }] });
    assert.ok(plan.ok && applyPlan(plan.value, plan.value.hash).ok);
    const custom = settingsOf(f.b);
    custom.packages[0] = { ...custom.packages[0], prompts: [] };
    writeFileSync(path.join(f.b, ".pi", "settings.json"), JSON.stringify(custom));
    const unpinned = await planUpdate(f.workspace, { kind: "pinned", spec: "git:github.com/example/radian-harness@main" }, fakeProbe({}));
    assert.equal(unpinned.ok ? "ok" : unpinned.blocker.code, "CONFIG_INVALID");
    const pinned = "git:github.com/example/radian-harness@" + "a".repeat(40);
    const update = await planUpdate(f.workspace, { kind: "pinned", spec: pinned }, fakeProbe({}));
    assert.ok(update.ok);
    if (!update.ok) return;
    assert.ok(update.value.conflicts.some((c) => c.includes("project-b")));
    assert.ok(applyPlan(update.value, update.value.hash).ok);
    assert.deepEqual(settingsOf(f.a).packages, [{ source: pinned }]);
    assert.deepEqual(settingsOf(f.b), custom);
  } finally {
    removeDir(f.root);
  }
});

test("targets, symlinks, nested workspaces, subdirectories, and moved projects are refused or reported", async () => {
  const f = await fixture();
  try {
    const noTarget = await planInstall({ workspaceRoot: f.workspace, source: local, projects: [{ path: f.a, target: "main" }] });
    assert.equal(noTarget.ok ? "ok" : noTarget.blocker.code, "CONFIG_INVALID");
    const missingBranch = await planInstall({ workspaceRoot: f.workspace, source: local, projects: [{ path: f.a, target: "refs/heads/release" }] });
    assert.equal(missingBranch.ok ? "ok" : missingBranch.blocker.code, "INSTALL_TARGET_INVALID");
    mkdirSync(path.join(f.a, "sub"));
    const sub = await planInstall({ workspaceRoot: f.workspace, source: local, projects: [{ path: path.join(f.a, "sub"), target: "refs/heads/main" }] });
    assert.equal(sub.ok ? "ok" : sub.blocker.code, "INSTALL_TARGET_INVALID");
    const outside = tempDir();
    try {
      const repo = await makeRepo(outside);
      repo.write("x", "x");
      await repo.commitAll("x");
      const out = await planInstall({ workspaceRoot: f.workspace, source: local, projects: [{ path: outside, target: "refs/heads/main" }] });
      assert.equal(out.ok ? "ok" : out.blocker.code, "INSTALL_TARGET_INVALID");
    } finally {
      removeDir(outside);
    }
    mkdirSync(path.join(f.b, ".pi"));
    symlinkSync(path.join(f.root, "elsewhere.json"), path.join(f.b, ".pi", "settings.json"));
    const link = await planInstall({ workspaceRoot: f.workspace, source: local, projects: [{ path: f.b, target: "refs/heads/main" }] });
    assert.equal(link.ok ? "ok" : link.blocker.code, "INSTALL_TARGET_INVALID");
    const harnessInside = await planInstall({ workspaceRoot: HARNESS, source: local, projects: [] });
    assert.equal(harnessInside.ok ? "ok" : harnessInside.blocker.code, "INSTALL_TARGET_INVALID");
    // Install A, then nest another workspace inside it: refused.
    const plan = await planInstall({ workspaceRoot: f.workspace, source: local, projects: [{ path: f.a, target: "refs/heads/main" }] });
    assert.ok(plan.ok && applyPlan(plan.value, plan.value.hash).ok);
    const nested = await planInstall({ workspaceRoot: f.a, source: local, projects: [] });
    assert.equal(nested.ok ? "ok" : nested.blocker.code, "DUPLICATE_BINDING");
    // A moved project is reported, not silently re-bound.
    renameSync(f.a, path.join(f.workspace, "project-a-moved"));
    const s = status(f.workspace, fakeProbe({}));
    assert.ok(s.ok && s.value.projects[0]?.exists === false);
    const moved = checkProjectBinding(path.join(f.workspace, "project-a-moved"));
    assert.equal(moved.ok ? "ok" : moved.blocker.code, "INSTALL_TARGET_INVALID");
  } finally {
    removeDir(f.root);
  }
});

test("interrupted operations are reported and completed without rolling back unrelated changes", async () => {
  const f = await fixture();
  try {
    const plan = await planInstall({ workspaceRoot: f.workspace, source: local, projects: [{ path: f.a, target: "refs/heads/main" }] });
    assert.ok(plan.ok);
    if (!plan.ok) return;
    // Simulate a crash after the journal and the first action were written.
    const journal = path.join(workspacePaths(f.workspace).journal, "operation.json");
    mkdirSync(path.dirname(journal), { recursive: true });
    writeFileSync(journal, JSON.stringify({ plan: plan.value, done: [0] }));
    const first = plan.value.actions[0]!;
    mkdirSync(path.dirname(first.path), { recursive: true });
    if (first.after.state === "content") writeFileSync(first.path, first.after.content);
    const s = status(f.workspace, fakeProbe({}));
    assert.ok(s.ok && s.value.interrupted);
    const blocked = await planInstall({ workspaceRoot: f.workspace, source: local, projects: [{ path: f.a, target: "refs/heads/main" }] });
    assert.equal(blocked.ok ? "ok" : blocked.blocker.code, "INTERRUPTED_OPERATION");
    const recovered = recover(f.workspace);
    assert.ok(recovered.ok && recovered.value.conflicts.length === 0 && recovered.value.completed === plan.value.actions.length);
    assert.ok(checkProjectBinding(f.a).ok);
    assert.ok(!existsSync(journal));
  } finally {
    removeDir(f.root);
  }
});

test("CLI previews by default and requires explicit targets", async () => {
  const f = await fixture();
  try {
    assert.ok("error" in parseCommand(["install", "--project", `${f.a}=refs/heads/main`, "--local", HARNESS]));
    assert.ok("error" in parseCommand(["install", "--workspace", f.workspace, "--project", f.a, "--local", HARNESS]));
    const parsed = parseCommand(["install", "--workspace", f.workspace, "--project", `${f.a}=refs/heads/main`, "--local", HARNESS]);
    assert.ok(!("error" in parsed));
    if ("error" in parsed) return;
    const preview = await runCommand(parsed);
    assert.equal(preview.exitCode, 0);
    assert.ok(preview.lines.some((l) => l.includes("Preview only")));
    assert.ok(!existsSync(path.join(f.workspace, ".radian")));
    const hash = /Plan hash: (\S+)/.exec(preview.lines.join("\n"))?.[1];
    const applied = await runCommand({ ...parsed, apply: hash! });
    assert.equal(applied.exitCode, 0, applied.lines.join("\n"));
    assert.ok(checkProjectBinding(f.a).ok);
  } finally {
    removeDir(f.root);
  }
});
