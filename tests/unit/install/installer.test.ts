import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RadianError } from "../../../src/core/errors.ts";
import {
  applyPlan,
  planInstall,
  planRemove,
  planUpdate,
  readInstallStatus,
} from "../../../src/install/installer.ts";

const harness = fs.realpathSync(path.resolve(fileURLToPath(import.meta.url), "../../../.."));

function makeTempDirectory(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "radian-")));
}

function settingsPath(workspace: string): string {
  return path.join(workspace, ".pi", "settings.json");
}

function manifestPath(workspace: string): string {
  return path.join(workspace, ".radian", "install-manifest.json");
}

function workspaceRecordPath(workspace: string): string {
  return path.join(workspace, ".radian", "workspace.json");
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function expectedEntry(workspace: string, harnessPath = harness): string {
  const relative = path.relative(path.join(workspace, ".pi"), harnessPath);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function install(workspace: string): void {
  applyPlan(planInstall({ workspace, harness }));
}

function makeHarnessCopy(): string {
  const copy = makeTempDirectory();
  fs.copyFileSync(path.join(harness, "package.json"), path.join(copy, "package.json"));
  return copy;
}

function assertRadianError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RadianError && error.code === code;
}

test("fresh install creates settings, workspace record, and manifest", () => {
  const workspace = makeTempDirectory();
  install(workspace);

  const entry = expectedEntry(workspace);
  assert.deepEqual(readJson(settingsPath(workspace)), { packages: [entry] });
  assert.deepEqual(readJson(workspaceRecordPath(workspace)), { version: 1 });
  assert.deepEqual(readJson(manifestPath(workspace)), {
    version: 1,
    harness,
    packageEntry: entry,
    createdSettingsFile: true,
  });
  assert.ok(fs.readFileSync(settingsPath(workspace), "utf8").endsWith("}\n"));
});

test("install preserves other settings keys and package entries", () => {
  const workspace = makeTempDirectory();
  writeJson(settingsPath(workspace), { theme: "dark", packages: ["npm:other@1.0.0"] });
  install(workspace);

  assert.deepEqual(readJson(settingsPath(workspace)), {
    theme: "dark",
    packages: ["npm:other@1.0.0", expectedEntry(workspace)],
  });
  assert.equal(readJson(manifestPath(workspace)).createdSettingsFile, false);
});

test("install does not duplicate an entry that is already present", () => {
  const workspace = makeTempDirectory();
  writeJson(settingsPath(workspace), { packages: [expectedEntry(workspace)] });
  const before = fs.readFileSync(settingsPath(workspace), "utf8");

  const plan = planInstall({ workspace, harness });
  applyPlan(plan);

  assert.ok(!plan.changes.some((change) => change.path === settingsPath(workspace)));
  assert.equal(fs.readFileSync(settingsPath(workspace), "utf8"), before);
});

test("install keeps an existing workspace record", () => {
  const workspace = makeTempDirectory();
  writeJson(workspaceRecordPath(workspace), { version: 1, note: "mine" });
  install(workspace);
  assert.deepEqual(readJson(workspaceRecordPath(workspace)), { version: 1, note: "mine" });
});

test("install is refused when a manifest already exists", () => {
  const workspace = makeTempDirectory();
  install(workspace);
  assert.throws(() => planInstall({ workspace, harness }), assertRadianError("already_installed"));
});

test("install is refused for a harness that is not a Radian checkout", () => {
  const workspace = makeTempDirectory();
  const other = makeTempDirectory();
  writeJson(path.join(other, "package.json"), { name: "something-else", pi: {} });
  assert.throws(
    () => planInstall({ workspace, harness: other }),
    assertRadianError("invalid_harness"),
  );
});

test("install is refused for a missing workspace directory", () => {
  const missing = path.join(makeTempDirectory(), "missing");
  assert.throws(
    () => planInstall({ workspace: missing, harness }),
    assertRadianError("invalid_workspace"),
  );
});

test("install is refused when settings is not a JSON object, and leaves it untouched", () => {
  const workspace = makeTempDirectory();
  writeJson(settingsPath(workspace), ["not", "an", "object"]);
  const before = fs.readFileSync(settingsPath(workspace), "utf8");

  assert.throws(() => planInstall({ workspace, harness }), assertRadianError("invalid_settings"));
  assert.equal(fs.readFileSync(settingsPath(workspace), "utf8"), before);
  assert.ok(!fs.existsSync(path.join(workspace, ".radian")));
});

test("applyPlan refuses when a file changed after the preview and writes nothing", () => {
  const workspace = makeTempDirectory();
  const plan = planInstall({ workspace, harness });
  writeJson(settingsPath(workspace), { theme: "light" });

  assert.throws(() => applyPlan(plan), assertRadianError("stale_preview"));
  assert.deepEqual(readJson(settingsPath(workspace)), { theme: "light" });
  assert.ok(!fs.existsSync(workspaceRecordPath(workspace)));
  assert.ok(!fs.existsSync(manifestPath(workspace)));
});

test("update re-points the owned entry and rewrites the manifest", () => {
  const workspace = makeTempDirectory();
  writeJson(settingsPath(workspace), { packages: ["npm:other@1.0.0"] });
  install(workspace);
  const newHarness = makeHarnessCopy();

  applyPlan(planUpdate({ workspace, harness: newHarness }));

  const newEntry = expectedEntry(workspace, newHarness);
  assert.deepEqual(readJson(settingsPath(workspace)).packages, ["npm:other@1.0.0", newEntry]);
  assert.equal(readJson(manifestPath(workspace)).harness, newHarness);
  assert.equal(readJson(manifestPath(workspace)).packageEntry, newEntry);
});

test("update with no changes plans nothing", () => {
  const workspace = makeTempDirectory();
  install(workspace);
  assert.deepEqual(planUpdate({ workspace }).changes, []);
});

test("update re-adds an entry the user removed", () => {
  const workspace = makeTempDirectory();
  install(workspace);
  writeJson(settingsPath(workspace), { theme: "dark" });

  const plan = planUpdate({ workspace });
  applyPlan(plan);

  assert.ok(plan.changes.some((change) => change.description.includes("re-add")));
  assert.deepEqual(readJson(settingsPath(workspace)), {
    theme: "dark",
    packages: [expectedEntry(workspace)],
  });
});

test("update is refused without a manifest", () => {
  const workspace = makeTempDirectory();
  assert.throws(() => planUpdate({ workspace }), assertRadianError("not_installed"));
});

test("remove keeps the user's settings edits and other entries", () => {
  const workspace = makeTempDirectory();
  install(workspace);
  const settings = readJson(settingsPath(workspace));
  writeJson(settingsPath(workspace), {
    ...settings,
    theme: "dark",
    packages: ["npm:other@1.0.0", ...(settings.packages as string[])],
  });

  applyPlan(planRemove({ workspace }));

  assert.deepEqual(readJson(settingsPath(workspace)), {
    theme: "dark",
    packages: ["npm:other@1.0.0"],
  });
  assert.ok(!fs.existsSync(manifestPath(workspace)));
});

test("remove drops an empty packages key from a settings file Radian did not create", () => {
  const workspace = makeTempDirectory();
  writeJson(settingsPath(workspace), { theme: "dark" });
  install(workspace);

  applyPlan(planRemove({ workspace }));

  assert.deepEqual(readJson(settingsPath(workspace)), { theme: "dark" });
});

test("remove deletes an empty settings file Radian created and keeps workspace state", () => {
  const workspace = makeTempDirectory();
  install(workspace);
  const projectsPath = path.join(workspace, ".radian", "projects.json");
  writeJson(projectsPath, { projects: [] });

  applyPlan(planRemove({ workspace }));

  assert.ok(!fs.existsSync(settingsPath(workspace)));
  assert.ok(!fs.existsSync(manifestPath(workspace)));
  assert.deepEqual(readJson(workspaceRecordPath(workspace)), { version: 1 });
  assert.deepEqual(readJson(projectsPath), { projects: [] });
});

test("remove is refused without a manifest", () => {
  const workspace = makeTempDirectory();
  assert.throws(() => planRemove({ workspace }), assertRadianError("not_installed"));
});

test("status reports before and after install", () => {
  const workspace = makeTempDirectory();
  const before = readInstallStatus(workspace);
  assert.equal(before.isInstalled, false);
  assert.equal(before.hasWorkspaceFile, false);

  install(workspace);
  const after = readInstallStatus(workspace);
  assert.deepEqual(after, {
    workspace,
    isInstalled: true,
    harness,
    packageEntry: expectedEntry(workspace),
    hasPackageEntry: true,
    hasHarness: true,
    hasWorkspaceFile: true,
  });

  writeJson(settingsPath(workspace), {});
  assert.equal(readInstallStatus(workspace).hasPackageEntry, false);
});
