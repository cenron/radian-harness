import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { git, makeRepository, makeTempDir } from "../../helpers/git-fixtures.ts";
import { writeJsonFile } from "#core/utils/json.ts";
import {
  addProject,
  createProject,
  deleteProject,
  getProject,
  isWorkspaceRoot,
  listProjects,
  projectPaths,
  readMode,
  writeMode,
} from "../../../src/io/workspace.ts";

function makeWorkspace(): string {
  const root = makeTempDir();
  writeJsonFile(path.join(root, ".radian", "workspace.json"), { version: 1 });
  return root;
}

test("isWorkspaceRoot recognises the directory holding .radian/workspace.json", () => {
  const root = makeWorkspace();
  assert.equal(isWorkspaceRoot(root), true);
  assert.equal(isWorkspaceRoot(path.join(root, ".radian")), false);
  assert.equal(isWorkspaceRoot(makeTempDir()), false);
});

test("createProject makes a git repository inside the workspace and registers it", async () => {
  const root = makeWorkspace();
  const project = await createProject(root, { name: "demo", branch: "main" });
  assert.deepEqual(project, { name: "demo", path: path.join(root, "demo"), target: "main" });
  assert.equal(git(project.path, "branch", "--show-current"), "main");
  assert.deepEqual(listProjects(root), [project]);
  assert.match(
    readFileSync(path.join(project.path, ".git", "info", "exclude"), "utf8"),
    /^\.radian\/$/m,
  );
});

test("createProject refuses a taken name or an existing directory", async () => {
  const root = makeWorkspace();
  await createProject(root, { name: "demo", branch: "main" });
  await assert.rejects(createProject(root, { name: "demo", branch: "main" }), /already/);
  mkdirSync(path.join(root, "other"));
  await assert.rejects(createProject(root, { name: "other", branch: "main" }), /already exists/);
  await assert.rejects(createProject(root, { name: "Bad Name", branch: "main" }), /Project names/);
});

test("addProject registers an existing repository with an existing target branch", async () => {
  const root = makeWorkspace();
  const repo = makeRepository();
  const project = await addProject(root, { path: repo, target: "refs/heads/main" });
  assert.equal(project.target, "main");
  assert.equal(project.path, repo);
  assert.equal(getProject(root, project.name).path, repo);
  await assert.rejects(
    addProject(root, { path: makeRepository(), target: "refs/heads/nope" }),
    /branch nope/,
  );
  await assert.rejects(
    addProject(root, { path: makeTempDir(), target: "refs/heads/main" }),
    /not a git/,
  );
});

test("getProject throws for an unknown project", () => {
  assert.throws(() => getProject(makeWorkspace(), "ghost"), /No project named "ghost"/);
});

test("deleteProject keeping files removes Radian's state and registration only", async () => {
  const root = makeWorkspace();
  const project = await createProject(root, { name: "demo", branch: "main" });
  const paths = projectPaths(root, "demo");
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(path.join(paths.stateDir, "workers.json"), "[]");
  await deleteProject(root, { name: "demo", shouldDeleteFiles: false });
  assert.equal(existsSync(paths.stateDir), false);
  assert.equal(existsSync(project.path), true);
  assert.deepEqual(listProjects(root), []);
});

test("deleteProject with files also removes the project directory", async () => {
  const root = makeWorkspace();
  const project = await createProject(root, { name: "demo", branch: "main" });
  await deleteProject(root, { name: "demo", shouldDeleteFiles: true });
  assert.equal(existsSync(project.path), false);
});

test("mode defaults to the configured start mode and persists per project", () => {
  const root = makeWorkspace();
  assert.equal(readMode(root, "demo", "plan"), "plan");
  writeMode(root, "demo", "build");
  assert.equal(readMode(root, "demo", "plan"), "build");
  assert.equal(readMode(root, "other", "plan"), "plan");
});
