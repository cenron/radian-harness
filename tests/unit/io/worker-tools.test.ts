import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../helpers/git-fixtures.ts";
import { addWorkerTool, readWorkerTools, removeWorkerTool } from "../../../src/io/worker-tools.ts";

test("a project starts with no extra worker tools", () => {
  assert.deepEqual(readWorkerTools(makeTempDir()), []);
});

test("approved tools are saved in the project's .radian folder, once each", () => {
  const project = makeTempDir();
  addWorkerTool(project, "mcp__godot__run_project");
  addWorkerTool(project, "mcp__godot__run_project");
  addWorkerTool(project, "mcp__figma");
  assert.deepEqual(readWorkerTools(project), ["mcp__godot__run_project", "mcp__figma"]);
  const file = JSON.parse(readFileSync(path.join(project, ".radian", "worker-tools.json"), "utf8"));
  assert.deepEqual(file, { version: 1, tools: ["mcp__godot__run_project", "mcp__figma"] });
});

test("a tool can be removed again", () => {
  const project = makeTempDir();
  addWorkerTool(project, "mcp__godot");
  removeWorkerTool(project, "mcp__godot");
  assert.deepEqual(readWorkerTools(project), []);
});
