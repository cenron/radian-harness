// W06 / F01 (R02) — a refused planning write must not create an outside
// directory through a missing-parent race. Production path: the registered
// radian_write_artifact tool on a direct-entry project, over the real
// confined-write primitive. The validated parent is replaced by a link to an
// outside directory immediately before the missing child directory is created:
// for an in-process mkdir (intercepted at Node's fs) and for Radian's verified
// directory helper (its test seam), whichever the implementation uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import * as safeDir from "../../../src/util/safe-dir.ts";
import { confinedAccessSupported } from "../../../src/util/confined-fs.ts";
import { removeDir } from "../helpers/fixture.ts";
import { FakePiProcess, workspaceWorld } from "../helpers/workspace-world.ts";

const opts = { skip: confinedAccessSupported() ? false : "needs macOS O_NOFOLLOW_ANY" };

test("F01: a planning write refused after its parent became a link leaves the outside directory namespace unchanged", opts, async () => {
  const w = await workspaceWorld(["alpha"]);
  const outside = path.join(w.root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "sentinel.txt"), "outside\n");
  const planning = path.join(w.dirs.alpha!, ".radian", "planning");
  mkdirSync(planning, { recursive: true });
  let swapped = false;
  const swap = () => {
    if (swapped) return;
    swapped = true;
    renameSync(planning, `${planning}.moved`);
    symlinkSync(outside, planning);
  };
  const original = fs.mkdirSync;
  const seam = (safeDir as { safeDirTestSeam?: { beforeMutate?: (dir: string, ops: ReadonlyArray<{ op: string; name?: string }>) => void } }).safeDirTestSeam;
  try {
    const pi = new FakePiProcess(w.dirs.alpha!, path.join(w.root, "sessions"));
    await pi.start();
    // In-process creation: swap right before Node creates `planning/child`.
    fs.mkdirSync = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (String(target) === path.join(planning, "child")) swap();
      return original(target, options as never);
    }) as typeof fs.mkdirSync;
    syncBuiltinESMExports();
    // Helper-based creation: swap right before the helper acts inside `planning`.
    if (seam) seam.beforeMutate = (dir, ops) => {
      if (dir === planning && ops[0]?.op === "mkdir" && ops[0].name === "child") swap();
    };
    const result = await pi.tool("radian_write_artifact", { path: "child/spec.md", content: "# synthetic\n" });
    assert.ok(swapped, "the substitution happened immediately before the child directory was created");
    assert.ok(result.error, `the write is refused: ${JSON.stringify(result)}`);
    assert.deepEqual(readdirSync(outside).sort(), ["sentinel.txt"], "no directory or file was created outside");
  } finally {
    fs.mkdirSync = original;
    syncBuiltinESMExports();
    if (seam) delete seam.beforeMutate;
    removeDir(w.root);
  }
});
