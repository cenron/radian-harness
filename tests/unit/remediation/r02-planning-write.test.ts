// R02 — planning-write symlink escape. A planning draft write must never land
// outside the project's .radian/planning root: not through a linked
// destination, parent, root, or .radian directory, a broken link, a hard link,
// traversal, or a path/parent substituted between validation and write.
// Exercised through the registered radian_write_artifact tool, the coordinator
// tool guard, the approval path, and the confined write primitive the tool uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { registerRadian } from "../../../src/ui/controller.ts";
import { artifactHash, openProjectSession } from "../../../src/ui/session.ts";
import { readConfined, writeConfined } from "../../../src/util/confined-fs.ts";
import { removeDir } from "../helpers/fixture.ts";
import { type FakeCtxState, FakeHost, context, fakeRuntime, managedWorld } from "../helpers/pi-host.ts";

const PRODUCTION = "export const a = 1;\n";
const native = process.platform === "darwin";

async function setup() {
  const w = await managedWorld();
  const outside = path.join(w.root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "sentinel.md"), "outside sentinel\n");
  const host = new FakeHost();
  const controller = registerRadian(host, { loadRuntime: async () => fakeRuntime, openSession: openProjectSession, startRun: w.startRun });
  const state: FakeCtxState = { confirms: [], confirmAnswer: true, notes: [] };
  const ctx = context(w.projectDir, "tui", state);
  await host.emit("session_start", {}, ctx);
  const planning = path.join(w.projectDir, ".radian", "planning");
  const write = (relative: string, content = "draft\n") => host.callTool("radian_write_artifact", { path: relative, content }, ctx);
  const unchanged = () => {
    assert.equal(readFileSync(path.join(w.projectDir, "src", "a.ts"), "utf8"), PRODUCTION, "production file untouched");
    assert.equal(readFileSync(path.join(outside, "sentinel.md"), "utf8"), "outside sentinel\n", "outside sentinel untouched");
  };
  return { w, outside, host, controller, state, ctx, planning, write, unchanged };
}

const refused = (out: { error?: string; text?: string; blocked?: string }) => out.error !== undefined || out.blocked !== undefined || /BLOCKED/.test(out.text ?? "");

test("R02: linked destinations, parents, roots, broken links, hard links, and traversal cannot redirect a planning write", { skip: native ? false : "confined writes require macOS" }, async () => {
  const s = await setup();
  try {
    const escaped: string[] = [];
    const attempt = async (label: string, relative: string, arrange: () => void, cleanup: () => void) => {
      arrange();
      const out = await s.write(relative, `escape via ${label}\n`);
      if (!refused(out)) escaped.push(label);
      cleanup();
    };
    // Destination is a link to a production file.
    await attempt("destination link", "plan.md", () => symlinkSync(path.join(s.w.projectDir, "src", "a.ts"), path.join(s.planning, "plan.md")), () => rmSync(path.join(s.planning, "plan.md")));
    // Broken destination link into an outside directory.
    await attempt("broken link", "new.md", () => symlinkSync(path.join(s.outside, "created.md"), path.join(s.planning, "new.md")), () => rmSync(path.join(s.planning, "new.md")));
    // Parent directory is a link.
    await attempt("parent link", "sub/x.md", () => symlinkSync(s.outside, path.join(s.planning, "sub")), () => rmSync(path.join(s.planning, "sub")));
    // Planning root itself is a link.
    await attempt("planning root link", "root.md", () => {
      renameSync(s.planning, s.planning + ".real");
      symlinkSync(s.outside, s.planning);
    }, () => {
      rmSync(s.planning);
      renameSync(s.planning + ".real", s.planning);
    });
    // The .radian directory is a link.
    const dotRadian = path.join(s.w.projectDir, ".radian");
    await attempt(".radian link", "dot.md", () => {
      renameSync(dotRadian, dotRadian + ".real");
      mkdirSync(path.join(s.outside, "planning"), { recursive: true });
      symlinkSync(s.outside, dotRadian);
    }, () => {
      rmSync(dotRadian);
      renameSync(dotRadian + ".real", dotRadian);
    });
    // Hard link to a production file.
    await attempt("hard link", "hard.md", () => linkSync(path.join(s.w.projectDir, "src", "a.ts"), path.join(s.planning, "hard.md")), () => rmSync(path.join(s.planning, "hard.md")));
    // A parent that is a file, absolute paths, and traversal.
    await attempt("file parent", "spec.md/x.md", () => {}, () => {});
    for (const bad of ["../../src/a.ts", "/etc/hosts", "a/../../x.md", "./x.md", ""]) await attempt(`path ${bad}`, bad, () => {}, () => {});
    assert.deepEqual(escaped, [], "every linked or out-of-root planning write is refused");
    s.unchanged();
    assert.ok(!existsSync(path.join(s.outside, "created.md")), "broken link target was not created");
    assert.ok(!existsSync(path.join(s.outside, "x.md")) && !existsSync(path.join(s.outside, "root.md")) && !existsSync(path.join(s.outside, "planning", "dot.md")));

    // Normal create, nested create, and replace still work.
    assert.ok(!refused(await s.write("plan.md", "first\n")));
    assert.ok(!refused(await s.write("plan.md", "second\n")));
    assert.equal(readFileSync(path.join(s.planning, "plan.md"), "utf8"), "second\n");
    assert.ok(!refused(await s.write("drafts/v1/brief.md", "nested\n")));
    assert.equal(readFileSync(path.join(s.planning, "drafts", "v1", "brief.md"), "utf8"), "nested\n");
  } finally {
    removeDir(s.w.root);
  }
});

test("R02: Pi's built-in write/edit are not a second planning-write path; links are not approvable artifacts", { skip: native ? false : "confined reads require macOS" }, async () => {
  const s = await setup();
  try {
    for (const name of ["write", "edit"]) {
      for (const target of [".radian/planning/plan.md", "src/a.ts"]) {
        const [decision] = await s.host.emit("tool_call", { toolName: name, input: { path: target, content: "x" } }, s.ctx);
        assert.equal((decision as { block?: boolean } | undefined)?.block, true, `${name} ${target} is blocked`);
      }
    }
    // A planning "artifact" that is a link to a production file is not hashable or approvable.
    symlinkSync(path.join(s.w.projectDir, "src", "a.ts"), path.join(s.planning, "linked.md"));
    assert.equal(artifactHash(s.w.projectDir, ".radian/planning/linked.md"), undefined);
    const added = await s.controller.command("task add Linked artifact", s.ctx);
    const task = /Task (\S+) added/.exec(added)?.[1];
    await s.host.emit("input", { text: "/radian approve", source: "interactive" }, s.ctx);
    const approve = await s.controller.command(`approve spec ${task} .radian/planning/linked.md`, s.ctx);
    assert.match(approve, /BLOCKED/);
    assert.equal(Object.keys(s.controller.session()!.run!.store.state.approvals).length, 0, "no approval recorded for a linked artifact");
    assert.ok(artifactHash(s.w.projectDir, ".radian/planning/spec.md"), "ordinary artifacts still hash");
  } finally {
    removeDir(s.w.root);
  }
});

test("R02: parent or destination substituted between validation and write is refused by the kernel, not a pre-check", { skip: native ? false : "confined writes require macOS" }, async () => {
  const s = await setup();
  try {
    const anchor = s.w.projectDir;
    // Parent substitution: the validated parent becomes a link before the open.
    mkdirSync(path.join(s.planning, "race"));
    const parent = writeConfined(anchor, ".radian/planning/race/x.md", "raced\n", {
      beforeOpen: () => {
        renameSync(path.join(s.planning, "race"), path.join(s.w.root, "race-moved"));
        symlinkSync(s.outside, path.join(s.planning, "race"));
      },
    });
    assert.equal(parent.ok ? "ok" : parent.blocker.code, "PATH_OUTSIDE_SCOPE");
    assert.ok(!existsSync(path.join(s.outside, "x.md")));
    // Destination substitution: a link appears after validation.
    const dest = writeConfined(anchor, ".radian/planning/dest.md", "raced\n", {
      beforeOpen: () => symlinkSync(path.join(s.outside, "sentinel.md"), path.join(s.planning, "dest.md")),
    });
    assert.equal(dest.ok ? "ok" : dest.blocker.code, "PATH_OUTSIDE_SCOPE");
    // Hard-link substitution after validation.
    const hard = writeConfined(anchor, ".radian/planning/hard2.md", "raced\n", {
      beforeOpen: () => linkSync(path.join(s.w.projectDir, "src", "a.ts"), path.join(s.planning, "hard2.md")),
    });
    assert.equal(hard.ok ? "ok" : hard.blocker.code, "PATH_OUTSIDE_SCOPE");
    s.unchanged();
    // Reads use the same kernel-enforced resolution.
    const linkedRead = readConfined(anchor, ".radian/planning/dest.md");
    assert.equal(linkedRead.ok, false);
    const plain = readConfined(anchor, ".radian/planning/spec.md");
    assert.ok(plain.ok && plain.value === "# Spec\n");
    // A non-canonical anchor is refused rather than trusted.
    symlinkSync(anchor, path.join(s.w.root, "anchor-link"));
    assert.equal(writeConfined(path.join(s.w.root, "anchor-link"), ".radian/planning/y.md", "x").ok, false);
  } finally {
    removeDir(s.w.root);
  }
});
