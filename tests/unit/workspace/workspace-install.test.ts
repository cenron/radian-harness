// W02 — empty-workspace installation. Disposable directories only; the real
// prerequisite check is replaced by a fake, and no Pi process is started here
// (the native load check is in tests/integration/w02-workspace-load.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refuse, success } from "../../../src/contracts/blockers.ts";
import { checkProjectBinding } from "../../../src/state/binding.ts";
import { confinedAccessSupported } from "../../../src/util/confined-fs.ts";
import { resolveExecutable } from "../../../src/util/proc.ts";
import { parseCommand, runCommand } from "../../../src/workspace/cli.ts";
import { applyPlan, planInstall, planRemove, planUpdate, readManifest, recover, status } from "../../../src/workspace/installer.ts";
import { workspacePaths } from "../../../src/workspace/layout.ts";
import { makeRepo, removeDir, tempDir } from "../helpers/fixture.ts";
import { fakeProbe } from "../helpers/probe.ts";

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const local = { kind: "local" as const, path: HARNESS };
const prerequisites = () => success({ node: process.versions.node, git: "2.56.0", pi: "1.0.2" });
const native = confinedAccessSupported();
const opts = { skip: native ? false : "needs macOS O_NOFOLLOW_ANY" };

function emptyWorkspace(name = "workspace") {
  const root = tempDir();
  const workspace = path.join(root, name);
  mkdirSync(workspace);
  return { root, workspace };
}

const settings = (dir: string) => JSON.parse(readFileSync(path.join(dir, ".pi", "settings.json"), "utf8"));
const hashOf = (lines: string[]) => /Plan hash: (\S+)/.exec(lines.join("\n"))?.[1];

test("an empty non-Git directory with zero projects installs through the CLI: preview writes nothing, apply binds the workspace", opts, async () => {
  const f = emptyWorkspace();
  try {
    const parsed = parseCommand(["install", "--workspace", f.workspace, "--local", HARNESS]);
    assert.ok(!("error" in parsed), "projects are optional");
    if ("error" in parsed) return;
    const preview = await runCommand(parsed, { prerequisites });
    assert.equal(preview.exitCode, 0, preview.lines.join("\n"));
    assert.deepEqual(readdirSync(f.workspace), [], "preview wrote nothing");
    assert.ok(preview.lines.some((l) => l.includes("/new-project")), "the empty workspace is explained");
    const applied = await runCommand({ ...parsed, apply: hashOf(preview.lines)! }, { prerequisites });
    assert.equal(applied.exitCode, 0, applied.lines.join("\n"));
    const entry = settings(f.workspace).packages[0];
    assert.equal(path.resolve(f.workspace, ".pi", entry.source), HARNESS, "the workspace's own Pi settings load the harness");
    assert.equal(settings(f.workspace).packages.length, 1);
    assert.ok(!existsSync(path.join(f.workspace, ".git")), "the workspace is not made a Git repository");
    const manifest = readManifest(f.workspace)!;
    assert.equal(manifest.schema, "radian.manifest/2");
    assert.ok(manifest.workspaceEntry);
    assert.deepEqual(manifest.projects, []);
    const registry = JSON.parse(readFileSync(workspacePaths(f.workspace).registry, "utf8"));
    assert.deepEqual(registry.projects, []);
    const s = status(f.workspace, fakeProbe({}));
    assert.ok(s.ok && s.value.installed && s.value.workspaceEntry === "owned-unchanged" && s.value.projects.length === 0 && !s.value.legacy);
    // Repeating the install is a no-op plan.
    const again = await runCommand(parsed, { prerequisites });
    assert.ok(again.lines.some((l) => l.includes("(no changes)")) && again.lines.some((l) => l.includes("Already installed")), again.lines.join("\n"));
    assert.equal((await runCommand({ ...parsed, apply: hashOf(again.lines)! }, { prerequisites })).exitCode, 0);
    assert.equal(settings(f.workspace).packages.length, 1, "no duplicate entry");
  } finally {
    removeDir(f.root);
  }
});

test("install.sh targets the displayed caller directory or --workspace, from any directory and with spaces", opts, () => {
  const f = emptyWorkspace("work space");
  try {
    const pi = resolveExecutable("pi", process.env.PATH);
    const env = { PATH: [path.dirname(process.execPath), ...(pi ? [path.dirname(pi)] : []), "/usr/bin", "/bin"].join(":"), HOME: f.root };
    const fromInside = spawnSync(path.join(HARNESS, "install.sh"), [], { cwd: f.workspace, encoding: "utf8", env, timeout: 120_000 });
    const out = fromInside.stdout + fromInside.stderr;
    // Prerequisites are real here: Pi may be absent on CI, which blocks without writing.
    if (fromInside.status === 2) {
      assert.ok(!pi, `prerequisites failed although Pi is installed: ${out}`);
      assert.match(out, /PREREQUISITE_MISSING[\s\S]*Nothing was written/);
    }
    else {
      assert.equal(fromInside.status, 0, out);
      assert.match(out, new RegExp(`Target workspace: .*work space`));
      assert.match(out, /Preview only; nothing was written/, "non-interactive runs only preview");
    }
    assert.deepEqual(readdirSync(f.workspace), []);
    const other = path.join(f.root, "elsewhere");
    mkdirSync(other);
    const fromOther = spawnSync(path.join(HARNESS, "install.sh"), ["--workspace", f.workspace], { cwd: other, encoding: "utf8", env, timeout: 120_000 });
    if (fromOther.status !== 2) {
      assert.match(fromOther.stdout, /Plan install for .*work space/);
      assert.doesNotMatch(fromOther.stdout, /Target workspace:/, "an explicit target is used as given");
      const hash = /Plan hash: (\S+)/.exec(fromOther.stdout)![1]!;
      const applied = spawnSync(path.join(HARNESS, "install.sh"), ["--workspace", f.workspace, "--apply", hash], { cwd: other, encoding: "utf8", env, timeout: 120_000 });
      assert.equal(applied.status, 0, applied.stdout + applied.stderr);
      assert.ok(existsSync(path.join(f.workspace, ".pi", "settings.json")));
      assert.deepEqual(readdirSync(other), [], "the invoking directory is untouched");
    }
  } finally {
    removeDir(f.root);
  }
});

test("missing prerequisites or source block without writing; malformed or foreign settings are left untouched", opts, async () => {
  const f = emptyWorkspace();
  try {
    const parsed = parseCommand(["install", "--workspace", f.workspace, "--local", HARNESS]);
    if ("error" in parsed) return assert.fail(parsed.error);
    const missing = await runCommand(parsed, { prerequisites: () => refuse("PREREQUISITE_MISSING", "Pi was not found on PATH") });
    assert.equal(missing.exitCode, 2);
    assert.ok(missing.lines[0]!.includes("PREREQUISITE_MISSING"));
    assert.deepEqual(readdirSync(f.workspace), []);
    const noSource = await planInstall({ workspaceRoot: f.workspace, source: { kind: "local", path: path.join(f.root, "absent") } });
    assert.equal(noSource.ok ? "ok" : noSource.blocker.code, "INSTALL_TARGET_INVALID");
    const unpinned = await planInstall({ workspaceRoot: f.workspace, source: { kind: "pinned", spec: "npm:radian-harness@latest" } });
    assert.equal(unpinned.ok ? "ok" : unpinned.blocker.code, "CONFIG_INVALID");
    mkdirSync(path.join(f.workspace, ".pi"));
    writeFileSync(path.join(f.workspace, ".pi", "settings.json"), "{ not json");
    const malformed = await planInstall({ workspaceRoot: f.workspace, source: local });
    assert.equal(malformed.ok ? "ok" : malformed.blocker.code, "INSTALL_CONFLICT");
    assert.equal(readFileSync(path.join(f.workspace, ".pi", "settings.json"), "utf8"), "{ not json");
    writeFileSync(path.join(f.workspace, ".pi", "settings.json"), JSON.stringify({ theme: "dark", packages: [{ source: "../vendor/radian-fork" }] }));
    const foreign = await planInstall({ workspaceRoot: f.workspace, source: local });
    assert.ok(foreign.ok && foreign.value.conflicts.some((c) => c.includes("Radian-like")));
    writeFileSync(path.join(f.workspace, ".pi", "settings.json"), JSON.stringify({ theme: "dark", packages: ["npm:other@1.0.0"] }));
    const merged = await planInstall({ workspaceRoot: f.workspace, source: local });
    assert.ok(merged.ok && applyPlan(merged.value, merged.value.hash).ok);
    assert.equal(settings(f.workspace).theme, "dark");
    assert.equal(settings(f.workspace).packages[0], "npm:other@1.0.0");
    assert.equal(settings(f.workspace).packages.length, 2);
  } finally {
    removeDir(f.root);
  }
});

test("stale plans, linked or nested targets, and substitution before parent creation are refused without outside changes", opts, async () => {
  const f = emptyWorkspace();
  const outside = path.join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "sentinel"), "x");
  try {
    const stale = await planInstall({ workspaceRoot: f.workspace, source: local });
    assert.ok(stale.ok);
    if (!stale.ok) return;
    mkdirSync(path.join(f.workspace, ".pi"));
    writeFileSync(path.join(f.workspace, ".pi", "settings.json"), "{}\n");
    const applied = applyPlan(stale.value, stale.value.hash);
    assert.equal(applied.ok ? "ok" : applied.blocker.code, "INSTALL_CONFLICT", "a plan made before an edit is stale");
    assert.equal(readFileSync(path.join(f.workspace, ".pi", "settings.json"), "utf8"), "{}\n");
    assert.ok(!existsSync(path.join(f.workspace, ".radian")));
    // A linked .pi directory is refused at preview.
    removeDir(path.join(f.workspace, ".pi"));
    symlinkSync(outside, path.join(f.workspace, ".pi"));
    const linked = await planInstall({ workspaceRoot: f.workspace, source: local });
    assert.equal(linked.ok ? "ok" : linked.blocker.code, "INSTALL_TARGET_INVALID");
    removeDir(path.join(f.workspace, ".pi"));
    // .pi swapped for a link between preview and apply: the confined state read refuses.
    const fresh = await planInstall({ workspaceRoot: f.workspace, source: local });
    assert.ok(fresh.ok);
    if (!fresh.ok) return;
    symlinkSync(outside, path.join(f.workspace, ".pi"));
    const swapped = applyPlan(fresh.value, fresh.value.hash);
    assert.equal(swapped.ok ? "ok" : swapped.blocker.code, "INSTALL_CONFLICT");
    removeDir(path.join(f.workspace, ".pi"));
    // The workspace root replaced by a link immediately before a directory is created.
    let moved = false;
    const raced = applyPlan(fresh.value, fresh.value.hash, {
      hooks: {
        beforeMutate: (dir, ops) => {
          if (!moved && dir === f.workspace && ops[0]?.op === "mkdir") {
            moved = true;
            renameSync(f.workspace, `${f.workspace}.real`);
            symlinkSync(outside, f.workspace);
          }
        },
      },
    });
    assert.ok(moved);
    assert.equal(raced.ok ? "ok" : raced.blocker.code, "PATH_OUTSIDE_SCOPE");
    assert.deepEqual(readdirSync(outside), ["sentinel"], "nothing was created outside");
    removeDir(f.workspace);
    renameSync(`${f.workspace}.real`, f.workspace);
    // The interrupted apply is journaled; recover completes it in place.
    const s = status(f.workspace, fakeProbe({}));
    assert.ok(s.ok);
    const r = recover(f.workspace);
    assert.ok(r.ok && r.value.conflicts.length === 0, r.ok ? r.value.conflicts.join("; ") : r.blocker.message);
    assert.ok(readManifest(f.workspace)?.workspaceEntry);
    // A workspace below another target is ambiguous.
    const parent = await planInstall({ workspaceRoot: f.root, source: local });
    assert.equal(parent.ok ? "ok" : parent.blocker.code, "DUPLICATE_BINDING");
    const child = path.join(f.workspace, "inner");
    mkdirSync(child);
    const nested = await planInstall({ workspaceRoot: child, source: local });
    assert.equal(nested.ok ? "ok" : nested.blocker.code, "DUPLICATE_BINDING");
    // A moved (copied) workspace keeps its record but is refused until re-installed explicitly.
    renameSync(f.workspace, path.join(f.root, "moved"));
    const movedPlan = await planInstall({ workspaceRoot: path.join(f.root, "moved"), source: local });
    assert.equal(movedPlan.ok ? "ok" : movedPlan.blocker.code, "DUPLICATE_BINDING");
  } finally {
    removeDir(f.root);
  }
});

test("a linked target path installs at its canonical location", opts, async () => {
  const f = emptyWorkspace();
  try {
    symlinkSync(f.workspace, path.join(f.root, "alias"));
    const plan = await planInstall({ workspaceRoot: path.join(f.root, "alias"), source: local });
    assert.ok(plan.ok && plan.value.workspace === f.workspace);
    if (!plan.ok) return;
    assert.ok(applyPlan(plan.value, plan.value.hash).ok);
    assert.ok(existsSync(path.join(f.workspace, ".radian", "workspace.json")));
    assert.ok(!existsSync(path.join(f.root, ".radian")));
  } finally {
    removeDir(f.root);
  }
});

test("update and remove work with no projects; private artifacts, overrides, and edited settings are retained", opts, async () => {
  const f = emptyWorkspace();
  try {
    const plan = await planInstall({ workspaceRoot: f.workspace, source: local });
    assert.ok(plan.ok && applyPlan(plan.value, plan.value.hash).ok);
    const pinned = "git:github.com/example/radian-harness@" + "b".repeat(40);
    const update = await planUpdate(f.workspace, { kind: "pinned", spec: pinned }, fakeProbe({}));
    assert.ok(update.ok);
    if (!update.ok) return;
    assert.ok(applyPlan(update.value, update.value.hash).ok);
    assert.deepEqual(settings(f.workspace).packages, [{ source: pinned }]);
    // Private state and user overrides that remove must keep.
    mkdirSync(path.join(f.workspace, ".radian", "config"), { recursive: true });
    writeFileSync(path.join(f.workspace, ".radian", "config", "harness.json"), "{}\n");
    mkdirSync(path.join(f.workspace, ".radian", "projects", "prj_x", "state"), { recursive: true });
    writeFileSync(path.join(f.workspace, ".radian", "projects", "prj_x", "state", "evidence.json"), "{}\n");
    const remove = planRemove(f.workspace, fakeProbe({}));
    assert.ok(remove.ok);
    if (!remove.ok) return;
    assert.ok(applyPlan(remove.value, remove.value.hash).ok);
    assert.ok(!existsSync(path.join(f.workspace, ".pi", "settings.json")), "a settings file Radian created and emptied is removed");
    assert.ok(!existsSync(workspacePaths(f.workspace).manifest) && !existsSync(workspacePaths(f.workspace).workspaceFile));
    assert.ok(existsSync(path.join(f.workspace, ".radian", "config", "harness.json")));
    assert.ok(existsSync(path.join(f.workspace, ".radian", "projects", "prj_x", "state", "evidence.json")));
    // Re-install, edit the owned entry, and remove: the edit is retained and reported.
    const again = await planInstall({ workspaceRoot: f.workspace, source: local });
    assert.ok(again.ok && applyPlan(again.value, again.value.hash).ok);
    const edited = settings(f.workspace);
    edited.packages[0] = { ...edited.packages[0], prompts: [] };
    edited.theme = "light";
    writeFileSync(path.join(f.workspace, ".pi", "settings.json"), JSON.stringify(edited));
    const keep = planRemove(f.workspace, fakeProbe({}));
    assert.ok(keep.ok && keep.value.conflicts.some((c) => c.includes(".pi/settings.json")));
    if (!keep.ok) return;
    assert.ok(applyPlan(keep.value, keep.value.hash).ok);
    assert.deepEqual(settings(f.workspace), edited);
    assert.ok(readManifest(f.workspace)?.workspaceEntry, "the retained entry stays recorded");
  } finally {
    removeDir(f.root);
  }
});

test("project-first (legacy) manifests are reported and migrated only by an explicit previewed install; active runs block it", opts, async () => {
  const root = tempDir();
  const workspace = path.join(root, "ws");
  const project = path.join(workspace, "proj");
  mkdirSync(project, { recursive: true });
  try {
    const repo = await makeRepo(project);
    repo.write("README.md", "x\n");
    await repo.commitAll("base");
    // Install the project-first way, then rewrite the manifest as a v1 manifest without a workspace entry.
    const plan = await planInstall({ workspaceRoot: workspace, source: local, projects: [{ path: project, target: "refs/heads/main" }] });
    assert.ok(plan.ok && applyPlan(plan.value, plan.value.hash).ok);
    const ws = workspacePaths(workspace);
    const v2 = JSON.parse(readFileSync(ws.manifest, "utf8"));
    const { workspaceEntry: _drop, ...rest } = v2;
    writeFileSync(ws.manifest, JSON.stringify({ ...rest, schema: "radian.manifest/1" }, null, 2) + "\n");
    removeDir(path.join(workspace, ".pi"));
    const legacy = status(workspace, fakeProbe({}));
    assert.ok(legacy.ok && legacy.value.legacy && legacy.value.workspaceEntry === "not-installed" && legacy.value.projects[0]?.entry === "owned-unchanged");
    const binding = checkProjectBinding(project);
    assert.ok(binding.ok, "the legacy project binding still resolves");
    if (!binding.ok) return;
    // An active run blocks a source update (and therefore any migration through update).
    const state = path.join(ws.radian, "projects", binding.value.project, "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(path.join(state, "coordinator-lease.json"), JSON.stringify({ owner: { pid: 4242, start: "s" } }));
    const blocked = await planUpdate(workspace, local, fakeProbe({ 4242: "s" }));
    assert.equal(blocked.ok ? "ok" : blocked.blocker.code, "RUN_ACTIVE");
    const migrateBlocked = await planInstall({ workspaceRoot: workspace, source: local, probe: fakeProbe({ 4242: "s" }) });
    assert.equal(migrateBlocked.ok ? "ok" : migrateBlocked.blocker.code, "RUN_ACTIVE", "migration is blocked beneath a live coordinator");
    const migrate = await planInstall({ workspaceRoot: workspace, source: local, probe: fakeProbe({}) });
    assert.ok(migrate.ok);
    if (!migrate.ok) return;
    assert.ok(migrate.value.notes.some((n) => n.includes("Migrates the project-first")));
    assert.equal(readManifest(workspace)?.legacy, true, "preview did not migrate");
    assert.ok(applyPlan(migrate.value, migrate.value.hash).ok);
    const migrated = readManifest(workspace)!;
    assert.equal(migrated.legacy, undefined);
    assert.ok(migrated.workspaceEntry && migrated.settingsEntries.length === 1 && migrated.projects[0]?.project === binding.value.project, "project identity and binding are retained");
    assert.ok(checkProjectBinding(project).ok);
  } finally {
    removeDir(root);
  }
});
