// W04 — project creation and registration over disposable workspaces. Git runs
// under Radian's controlled environment; no remote, model, dependency, or
// worker is involved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { success, refuse } from "../../../src/contracts/blockers.ts";
import { checkProjectBinding } from "../../../src/state/binding.ts";
import { confinedAccessSupported } from "../../../src/util/confined-fs.ts";
import { readManifest, status } from "../../../src/workspace/installer.ts";
import { applyProjectPlan, interruptedProjectOperation, planAddProject, planNewProject, readGitIdentity, recoverProjectOperation } from "../../../src/workspace/projects.ts";
import { FIXTURE_IDENTITY, makeRepo, removeDir, requireGit } from "../helpers/fixture.ts";
import { fakeProbe } from "../helpers/probe.ts";
import { FakePiProcess, workspaceWorld } from "../helpers/workspace-world.ts";

const opts = { skip: confinedAccessSupported() ? false : "needs macOS O_NOFOLLOW_ANY" };
const identity = () => success({ name: FIXTURE_IDENTITY.GIT_AUTHOR_NAME, email: FIXTURE_IDENTITY.GIT_AUTHOR_EMAIL });

function git(cwd: string, ...args: string[]): string {
  const out = spawnSync(requireGit(), args, { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}

test("/new-project bootstrap: one reviewed commit on the confirmed branch, ignored binding, registration, nothing else", opts, async () => {
  const w = await workspaceWorld();
  try {
    const plan = planNewProject(w.ws, "my-app", { identity });
    assert.ok(plan.ok, plan.ok ? "" : plan.blocker.message);
    if (!plan.ok) return;
    assert.equal(plan.value.branch, "main");
    assert.ok(!existsSync(path.join(w.ws, "my-app")), "planning writes nothing");
    const applied = await applyProjectPlan(plan.value, plan.value.hash);
    assert.ok(applied.ok, applied.ok ? "" : applied.blocker.message);
    if (!applied.ok) return;
    const dir = path.join(w.ws, "my-app");
    assert.equal(git(dir, "symbolic-ref", "HEAD"), "refs/heads/main");
    assert.equal(git(dir, "rev-list", "--count", "HEAD"), "1");
    assert.deepEqual(git(dir, "ls-tree", "-r", "--name-only", "HEAD").split("\n").sort(), [".gitignore", ".radian/planning/README.md", "README.md"]);
    assert.equal(git(dir, "show", "HEAD:README.md"), "# my-app");
    assert.equal(git(dir, "log", "-1", "--format=%an <%ae>|%cn"), `${FIXTURE_IDENTITY.GIT_AUTHOR_NAME} <${FIXTURE_IDENTITY.GIT_AUTHOR_EMAIL}>|${FIXTURE_IDENTITY.GIT_AUTHOR_NAME}`);
    assert.equal(git(dir, "status", "--porcelain", "--ignored=no"), "", "the working tree is clean; the binding is ignored");
    assert.equal(git(dir, "remote"), "", "no remote");
    assert.deepEqual(existsSync(path.join(dir, ".git", "hooks")) ? readdirSync(path.join(dir, ".git", "hooks")) : [], [], "no hook templates");
    assert.ok(!existsSync(path.join(dir, "package.json")) && !existsSync(path.join(dir, "node_modules")));
    const binding = JSON.parse(readFileSync(path.join(dir, ".pi", "settings.json"), "utf8"));
    assert.equal(binding.packages.length, 1);
    const bound = checkProjectBinding(dir);
    assert.ok(bound.ok && bound.value.project === applied.value.projectId);
    const manifest = readManifest(w.ws)!;
    assert.ok(manifest.projects.some((p) => p.project === applied.value.projectId && p.target === "refs/heads/main"));
    assert.ok(manifest.settingsEntries.some((e) => e.settingsFile === path.join(dir, ".pi", "settings.json")));
    const s = status(w.ws, fakeProbe({}));
    assert.ok(s.ok && s.value.projects[0]?.entry === "owned-unchanged" && s.value.ownedFiles.every((f) => f.state === "unchanged"), JSON.stringify(s));
    assert.equal(interruptedProjectOperation(w.ws), undefined);
    // A second request for the same name is a collision, never an overwrite.
    const again = planNewProject(w.ws, "my-app", { identity });
    assert.equal(again.ok ? "ok" : again.blocker.code, "INSTALL_CONFLICT");
    const custom = planNewProject(w.ws, "other", { identity, branch: "trunk" });
    assert.ok(custom.ok && (await applyProjectPlan(custom.value, custom.value.hash)).ok);
    assert.equal(git(path.join(w.ws, "other"), "symbolic-ref", "HEAD"), "refs/heads/trunk");
  } finally {
    removeDir(w.root);
  }
});

test("names, identity, collisions, stale plans, and the project lock are checked before anything is written", opts, async () => {
  const w = await workspaceWorld();
  try {
    for (const bad of ["", ".radian", "../x", "a/b", "-x", "radian", "con", "x".repeat(70), "with space"]) {
      const p = planNewProject(w.ws, bad, { identity });
      assert.equal(p.ok ? "ok" : p.blocker.code, "PATH_INVALID", bad);
    }
    assert.equal((planNewProject(w.ws, "x", { identity, branch: "bad..branch" }) as { ok: boolean }).ok, false);
    const noIdentity = planNewProject(w.ws, "x", { identity: () => refuse("GIT_IDENTITY_MISSING", "not configured") });
    assert.equal(noIdentity.ok ? "ok" : noIdentity.blocker.code, "GIT_IDENTITY_MISSING");
    mkdirSync(path.join(w.ws, "Taken"));
    const caseClash = planNewProject(w.ws, "taken", { identity });
    assert.equal(caseClash.ok ? "ok" : caseClash.blocker.code, "INSTALL_CONFLICT", "case-insensitive collision");
    symlinkSync(path.join(w.root), path.join(w.ws, "linked"));
    assert.equal((planNewProject(w.ws, "linked", { identity }) as { ok: boolean }).ok, false, "an existing link is never a destination");
    // Two previews; applying the first makes the second stale.
    const first = planNewProject(w.ws, "one", { identity });
    const second = planNewProject(w.ws, "two", { identity });
    assert.ok(first.ok && second.ok);
    if (!first.ok || !second.ok) return;
    assert.ok((await applyProjectPlan(first.value, first.value.hash)).ok);
    const stale = await applyProjectPlan(second.value, second.value.hash);
    assert.equal(stale.ok ? "ok" : stale.blocker.code, "INSTALL_CONFLICT");
    assert.ok(!existsSync(path.join(w.ws, "two")));
    const wrongHash = await applyProjectPlan(first.value, "sha256:" + "0".repeat(64));
    assert.equal(wrongHash.ok ? "ok" : wrongHash.blocker.code, "INSTALL_CONFLICT");
    // A live process holding the project-operation lock serializes concurrent requests.
    const three = planNewProject(w.ws, "three", { identity });
    assert.ok(three.ok);
    if (!three.ok) return;
    mkdirSync(path.join(w.ws, ".radian", "state", "locks"), { recursive: true });
    writeFileSync(path.join(w.ws, ".radian", "state", "locks", "projects.lock"), JSON.stringify({ owner: { pid: 991234, start: "s" }, operation: "new-project" }));
    const locked = await applyProjectPlan(three.value, three.value.hash, { probe: fakeProbe({ 991234: "s", [process.pid]: "self" }) });
    assert.equal(locked.ok ? "ok" : locked.blocker.code, "CONTEXT_LOCKED");
    assert.ok(!existsSync(path.join(w.ws, "three")));
    // A dead holder is provably abandoned and the request proceeds.
    const proceeds = await applyProjectPlan(three.value, three.value.hash, { probe: fakeProbe({ [process.pid]: "self" }) });
    assert.ok(proceeds.ok, proceeds.ok ? "" : proceeds.blocker.message);
  } finally {
    removeDir(w.root);
  }
});

test("the workspace root swapped for a link just before the destination mkdir changes nothing outside", opts, async () => {
  const w = await workspaceWorld();
  const outside = path.join(w.root, "outside");
  mkdirSync(outside);
  try {
    const plan = planNewProject(w.ws, "app", { identity });
    assert.ok(plan.ok);
    if (!plan.ok) return;
    let swapped = false;
    const raced = await applyProjectPlan(plan.value, plan.value.hash, {
      hooks: {
        beforeMutate: (dir, ops) => {
          if (!swapped && dir === w.ws && ops[0]?.op === "mkdir" && (ops[0] as { name: string }).name === "app") {
            swapped = true;
            renameSync(w.ws, `${w.ws}.real`);
            symlinkSync(outside, w.ws);
          }
        },
      },
    });
    assert.ok(swapped);
    assert.equal(raced.ok ? "ok" : raced.blocker.code, "PATH_OUTSIDE_SCOPE");
    assert.deepEqual(readdirSync(outside), [], "no directory was created outside");
    removeDir(w.ws);
    renameSync(`${w.ws}.real`, w.ws);
    assert.match(interruptedProjectOperation(w.ws) ?? "", /new-project app/);
    const recovered = await recoverProjectOperation(w.ws);
    assert.ok(recovered.ok && recovered.value?.name === "app", recovered.ok ? "" : recovered.blocker.message);
    assert.equal(git(path.join(w.ws, "app"), "rev-list", "--count", "HEAD"), "1");
  } finally {
    removeDir(w.root);
  }
});

test("hooks, signing, templates, and filters from the user's Git configuration never run during bootstrap", opts, async () => {
  const w = await workspaceWorld();
  try {
    const home = path.join(w.root, "home");
    const marker = path.join(w.root, "helper-ran");
    mkdirSync(path.join(home, "hooks"), { recursive: true });
    mkdirSync(path.join(home, "template", "hooks"), { recursive: true });
    for (const hook of [path.join(home, "hooks", "pre-commit"), path.join(home, "hooks", "post-commit"), path.join(home, "template", "hooks", "post-checkout")]) {
      writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
      chmodSync(hook, 0o755);
    }
    writeFileSync(path.join(home, ".gitconfig"), `[user]\n\tname = Configured User\n\temail = configured@example.com\n[core]\n\thooksPath = ${path.join(home, "hooks")}\n[commit]\n\tgpgSign = true\n[init]\n\ttemplateDir = ${path.join(home, "template")}\n[filter "x"]\n\tclean = touch ${marker}\n`);
    const configured = readGitIdentity({ HOME: home });
    assert.ok(configured.ok && configured.value.email === "configured@example.com", "the configured identity is read, not invented");
    const plan = planNewProject(w.ws, "app", { identity: () => configured });
    assert.ok(plan.ok);
    if (!plan.ok) return;
    assert.ok((await applyProjectPlan(plan.value, plan.value.hash)).ok);
    assert.ok(!existsSync(marker), "no hook, template, or filter executed");
    assert.equal(git(path.join(w.ws, "app"), "log", "-1", "--format=%G?"), "N", "the commit is unsigned");
    const missing = readGitIdentity({ HOME: path.join(w.root, "empty-home") });
    assert.equal(missing.ok ? "ok" : missing.blocker.code, "GIT_IDENTITY_MISSING");
  } finally {
    removeDir(w.root);
  }
});

test("interruption at each durable step is recoverable; user edits are preserved and never committed or deleted", opts, async () => {
  for (const step of ["destination", "files", "repository", "commit", "binding", "registry"] as const) {
    const w = await workspaceWorld();
    try {
      const plan = planNewProject(w.ws, "app", { identity });
      assert.ok(plan.ok);
      if (!plan.ok) return;
      const stopped = await applyProjectPlan(plan.value, plan.value.hash, { afterStep: (s) => s !== step });
      assert.equal(stopped.ok ? "ok" : stopped.blocker.code, "INTERRUPTED_OPERATION", step);
      assert.match(interruptedProjectOperation(w.ws) ?? "", /new-project app/);
      // While interrupted, new project operations are refused.
      const blocked = planNewProject(w.ws, "else", { identity });
      assert.equal(blocked.ok ? "ok" : blocked.blocker.code, "INTERRUPTED_OPERATION");
      const recovered = await recoverProjectOperation(w.ws, { probe: fakeProbe({}) });
      assert.ok(recovered.ok && recovered.value?.name === "app", `${step}: ${recovered.ok ? "" : recovered.blocker.message}`);
      const dir = path.join(w.ws, "app");
      assert.equal(git(dir, "rev-list", "--count", "HEAD"), "1", step);
      assert.ok(checkProjectBinding(dir).ok, step);
    } finally {
      removeDir(w.root);
    }
  }
  // An edit made before the commit is preserved: recovery refuses to commit or remove it.
  const w = await workspaceWorld();
  try {
    const plan = planNewProject(w.ws, "app", { identity });
    assert.ok(plan.ok);
    if (!plan.ok) return;
    await applyProjectPlan(plan.value, plan.value.hash, { afterStep: (s) => s !== "repository" });
    writeFileSync(path.join(w.ws, "app", "README.md"), "# my own words\n");
    const refused = await recoverProjectOperation(w.ws, { probe: fakeProbe({}) });
    assert.equal(refused.ok ? "ok" : refused.blocker.code, "WORK_UNPRESERVED");
    assert.equal(readFileSync(path.join(w.ws, "app", "README.md"), "utf8"), "# my own words\n");
    assert.throws(() => git(path.join(w.ws, "app"), "rev-parse", "--verify", "HEAD"), "nothing was committed");
    assert.ok(existsSync(path.join(w.ws, "app")) && interruptedProjectOperation(w.ws), "the destination and journal remain");
  } finally {
    removeDir(w.root);
  }
});

test("/add-project registers an existing repository explicitly, preserving dirty work and history; unborn or absent targets are refused", opts, async () => {
  const w = await workspaceWorld();
  try {
    const dir = path.join(w.ws, "existing");
    mkdirSync(dir);
    const repo = await makeRepo(dir);
    repo.write("src/a.ts", "export const a = 1;\n");
    const head = await repo.commitAll("base");
    repo.write("src/a.ts", "export const a = 2; // uncommitted\n");
    repo.write("notes.txt", "untracked\n");
    const before = git(dir, "status", "--porcelain");
    const noTarget = await planAddProject(w.ws, "existing", undefined);
    assert.equal(noTarget.ok ? "ok" : noTarget.blocker.code, "CONFIG_INVALID");
    const absent = await planAddProject(w.ws, "existing", "refs/heads/release");
    assert.equal(absent.ok ? "ok" : absent.blocker.code, "INSTALL_TARGET_INVALID");
    assert.equal(((await planAddProject(w.ws, "existing/src", "refs/heads/main")) as { ok: boolean }).ok, false, "subdirectories are refused");
    assert.equal(((await planAddProject(w.ws, "../", "refs/heads/main")) as { ok: boolean }).ok, false);
    const plan = await planAddProject(w.ws, "existing", "refs/heads/main");
    assert.ok(plan.ok, plan.ok ? "" : plan.blocker.message);
    if (!plan.ok) return;
    assert.ok((await applyProjectPlan(plan.value, plan.value.hash)).ok);
    assert.equal(git(dir, "rev-parse", "HEAD"), head, "no commit was made");
    assert.equal(git(dir, "status", "--porcelain").replace(/\n?\?\? \.pi\/\n?/, "\n").trim(), before.trim(), "dirty work is preserved; only the untracked binding was added");
    assert.equal(readFileSync(path.join(dir, "src", "a.ts"), "utf8"), "export const a = 2; // uncommitted\n");
    assert.ok(checkProjectBinding(dir).ok);
    const dup = await planAddProject(w.ws, "existing", "refs/heads/main");
    assert.equal(dup.ok ? "ok" : dup.blocker.code, "DUPLICATE_BINDING");
    // An unborn repository has no commit-backed target.
    const unborn = path.join(w.ws, "unborn");
    mkdirSync(unborn);
    git(unborn, "init", "-q", "-b", "main");
    const refused = await planAddProject(w.ws, "unborn", "refs/heads/main");
    assert.equal(refused.ok ? "ok" : refused.blocker.code, "INSTALL_TARGET_INVALID");
    // A tracked .pi/settings.json is never rewritten.
    const tracked = path.join(w.ws, "tracked");
    mkdirSync(tracked);
    const trackedRepo = await makeRepo(tracked);
    trackedRepo.write(".pi/settings.json", '{"theme":"dark"}\n');
    await trackedRepo.commitAll("settings");
    const trackedPlan = await planAddProject(w.ws, "tracked", "refs/heads/main");
    assert.ok(trackedPlan.ok && trackedPlan.value.operation === "add-project" && trackedPlan.value.settingsBefore.state === "skipped");
    if (!trackedPlan.ok) return;
    assert.ok((await applyProjectPlan(trackedPlan.value, trackedPlan.value.hash)).ok);
    assert.equal(readFileSync(path.join(tracked, ".pi", "settings.json"), "utf8"), '{"theme":"dark"}\n');
    assert.equal(git(tracked, "status", "--porcelain"), "");
  } finally {
    removeDir(w.root);
  }
});

test("the /new-project command previews, needs explicit confirmation, works from the dashboard, and activates only after registration", opts, async () => {
  const w = await workspaceWorld();
  const env = process.env;
  const home = path.join(w.root, "home");
  mkdirSync(home);
  writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Fixture Author\n\temail = fixture@example.com\n");
  process.env = { ...env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") };
  try {
    const pi = new FakePiProcess(w.ws, path.join(w.root, "sessions"));
    await pi.start();
    pi.state.confirmAnswer = false;
    assert.match(await pi.controller.newProjectCommand("demo", pi.ctx()), /APPROVAL_MISSING/);
    assert.ok(!existsSync(path.join(w.ws, "demo")), "declined: nothing written");
    assert.match(pi.state.confirms.at(-1) ?? "", /Create project demo[\s\S]*Initial branch: main[\s\S]*README\.md/);
    const print = { ...pi.ctx(), hasUI: false };
    assert.match(await pi.controller.newProjectCommand("demo", print), /NONINTERACTIVE_APPROVAL_REQUIRED/);
    pi.state.confirmAnswer = true;
    const out = await pi.controller.newProjectCommand("demo", pi.ctx());
    assert.equal(out, "", "the new runtime reports after the switch");
    const v = pi.controller.view();
    assert.ok(v.kind === "project" && v.project.repo.root === path.join(w.ws, "demo") && !v.direct, "the same Pi process now shows the new project");
    assert.match(pi.state.notes.at(-1) ?? "", /Project demo selected/);
    assert.equal(v.kind === "project" ? v.project.mode.mode : "", "plan", "creation grants no BUILD mode or approval");
    assert.equal(v.kind === "project" ? v.project.run : "x", undefined, "no run or worker was started");
  } finally {
    process.env = env;
    removeDir(w.root);
  }
});
