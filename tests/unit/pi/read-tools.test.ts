import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../helpers/git-fixtures.ts";
import { confinePath } from "../../../src/pi/read-tools.ts";

function makeScope() {
  const root = makeTempDir();
  const skills = makeTempDir();
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "a.ts"), "x");
  return { root, extraRoots: [skills] };
}

test("confinePath resolves relative and absolute paths inside the project", () => {
  const scope = makeScope();
  assert.equal(confinePath(scope, "src/a.ts"), path.join(scope.root, "src", "a.ts"));
  assert.equal(confinePath(scope, path.join(scope.root, "src")), path.join(scope.root, "src"));
  assert.equal(confinePath(scope, undefined), scope.root);
  assert.equal(confinePath(scope, "@src/a.ts"), path.join(scope.root, "src", "a.ts"));
});

test("confinePath allows the extra roots (loaded skills)", () => {
  const scope = makeScope();
  const skillFile = path.join(scope.extraRoots[0] ?? "", "SKILL.md");
  assert.equal(confinePath(scope, skillFile), skillFile);
});

test("confinePath refuses paths outside the project, including through links", () => {
  const scope = makeScope();
  assert.throws(() => confinePath(scope, "../elsewhere"), /outside the selected project/);
  assert.throws(() => confinePath(scope, "/etc/hosts"), /outside the selected project/);
  symlinkSync("/etc", path.join(scope.root, "escape"));
  assert.throws(() => confinePath(scope, "escape/hosts"), /outside the selected project/);
});
