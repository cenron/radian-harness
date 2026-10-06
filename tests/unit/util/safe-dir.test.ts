import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { confinedAccessSupported } from "../../../src/util/confined-fs.ts";
import { ensureDirConfined, readFileConfinedBytes, removeFileConfined, writeFileAtomicConfined } from "../../../src/util/safe-dir.ts";
import { removeDir, tempDir } from "../helpers/fixture.ts";

const native = confinedAccessSupported();

function world() {
  const root = tempDir();
  const anchor = path.join(root, "anchor");
  const outside = path.join(root, "outside");
  mkdirSync(path.join(anchor, "planning"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, "sentinel.txt"), "outside\n");
  return { root, anchor, outside };
}

/** Swap `dir` for a link to `target`, keeping the original out of the way. */
function substitute(dir: string, target: string): void {
  renameSync(dir, `${dir}.moved`);
  symlinkSync(target, dir);
}

test("creates nested directories and replaces files atomically below the anchor", { skip: native ? false : "needs macOS O_NOFOLLOW_ANY" }, () => {
  const w = world();
  try {
    const written = writeFileAtomicConfined(w.anchor, "a/b/c/file.json", "{}\n", { mode: 0o644, dirMode: 0o755 });
    assert.ok(written.ok, written.ok ? "" : written.blocker.message);
    assert.equal(readFileSync(path.join(w.anchor, "a/b/c/file.json"), "utf8"), "{}\n");
    assert.equal(statSync(path.join(w.anchor, "a/b")).mode & 0o777, 0o755);
    assert.ok(writeFileAtomicConfined(w.anchor, "a/b/c/file.json", "[]\n").ok);
    assert.equal(readFileSync(path.join(w.anchor, "a/b/c/file.json"), "utf8"), "[]\n");
    assert.deepEqual(readdirSync(path.join(w.anchor, "a/b/c")), ["file.json"], "no temporary file is left behind");
    assert.ok(removeFileConfined(w.anchor, "a/b/c/file.json").ok);
    assert.ok(!existsSync(path.join(w.anchor, "a/b/c/file.json")));
    assert.ok(removeFileConfined(w.anchor, "a/b/c/file.json").ok, "absent is success");
  } finally {
    removeDir(w.root);
  }
});

test("a parent replaced by a link immediately before mkdir changes nothing outside", { skip: native ? false : "needs macOS O_NOFOLLOW_ANY" }, () => {
  const w = world();
  try {
    let swapped = false;
    const made = ensureDirConfined(w.anchor, "planning/child/grandchild", 0o700, {
      beforeMutate: (dir, ops) => {
        if (!swapped && dir === path.join(w.anchor, "planning") && ops[0]?.op === "mkdir") {
          swapped = true;
          substitute(dir, w.outside);
        }
      },
    });
    assert.ok(swapped);
    assert.equal(made.ok ? "ok" : made.blocker.code, "PATH_OUTSIDE_SCOPE");
    assert.deepEqual(readdirSync(w.outside).sort(), ["sentinel.txt"], "the outside directory namespace is unchanged");
    const write = writeFileAtomicConfined(w.anchor, "planning/x.md", "x");
    assert.equal(write.ok ? "ok" : write.blocker.code, "PATH_OUTSIDE_SCOPE", "a linked parent is refused by the no-follow open");
    assert.deepEqual(readdirSync(w.outside).sort(), ["sentinel.txt"]);
  } finally {
    removeDir(w.root);
  }
});

test("a parent replaced before the rename or unlink cannot redirect them", { skip: native ? false : "needs macOS O_NOFOLLOW_ANY" }, () => {
  const w = world();
  try {
    writeFileSync(path.join(w.outside, "settings.json"), "outside-settings\n");
    writeFileSync(path.join(w.anchor, "planning", "settings.json"), "inside\n");
    let swapped = false;
    const replaced = writeFileAtomicConfined(w.anchor, "planning/settings.json", "new\n", {
      hooks: {
        beforeMutate: (dir, ops) => {
          if (!swapped && ops[0]?.op === "rename") {
            swapped = true;
            substitute(dir, w.outside);
          }
        },
      },
    });
    assert.equal(replaced.ok ? "ok" : replaced.blocker.code, "PATH_OUTSIDE_SCOPE");
    assert.equal(readFileSync(path.join(w.outside, "settings.json"), "utf8"), "outside-settings\n");
    assert.deepEqual(readdirSync(w.outside).sort(), ["sentinel.txt", "settings.json"]);
    // Restore, then try removal with the same substitution.
    removeDir(path.join(w.anchor, "planning"));
    renameSync(path.join(w.anchor, "planning.moved"), path.join(w.anchor, "planning"));
    swapped = false;
    const removed = removeFileConfined(w.anchor, "planning/settings.json", {
      beforeMutate: (dir) => {
        if (!swapped) {
          swapped = true;
          substitute(dir, w.outside);
        }
      },
    });
    assert.equal(removed.ok ? "ok" : removed.blocker.code, "PATH_OUTSIDE_SCOPE");
    assert.equal(readFileSync(path.join(w.outside, "settings.json"), "utf8"), "outside-settings\n", "the outside file of the same name survives");
  } finally {
    removeDir(w.root);
  }
});

test("linked destinations, linked anchors, and traversal are refused", { skip: native ? false : "needs macOS O_NOFOLLOW_ANY" }, () => {
  const w = world();
  try {
    symlinkSync(path.join(w.outside, "sentinel.txt"), path.join(w.anchor, "planning", "link.md"));
    const viaLink = writeFileAtomicConfined(w.anchor, "planning/link.md", "x");
    assert.equal(viaLink.ok ? "ok" : viaLink.blocker.code, "PATH_OUTSIDE_SCOPE");
    assert.equal(readFileConfinedBytes(w.anchor, "planning/link.md").ok, false);
    symlinkSync(w.anchor, path.join(w.root, "anchor-link"));
    const linkedAnchor = ensureDirConfined(path.join(w.root, "anchor-link"), "z");
    assert.equal(linkedAnchor.ok ? "ok" : linkedAnchor.blocker.code, "PATH_OUTSIDE_SCOPE");
    assert.equal((writeFileAtomicConfined(w.anchor, "../outside/x", "x") as { ok: boolean }).ok, false);
    assert.equal(readFileSync(path.join(w.outside, "sentinel.txt"), "utf8"), "outside\n");
    assert.deepEqual(readdirSync(w.outside).sort(), ["sentinel.txt"]);
  } finally {
    removeDir(w.root);
  }
});
