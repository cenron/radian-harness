// R01 — coordinator command-helper escape. The coordinator's shell runs outside
// worker containment, so no model-callable path may run a program whose options,
// configuration, or environment can start helpers or write files. Exercised
// through Pi's tool_call handler (the actual model-callable gate) in both Plan
// and Build, and through the dedicated read-only Git inspection tool against a
// repository with planted inert marker helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { registerRadian } from "../../../src/ui/controller.ts";
import { openProjectSession } from "../../../src/ui/session.ts";
import { removeDir } from "../helpers/fixture.ts";
import { type FakeCtxState, FakeHost, context, fakeRuntime, managedWorld } from "../helpers/pi-host.ts";

const ESCAPES = [
  // The four reviewed examples.
  "rg --pre=sh pattern script.sh",
  "git diff --ext-diff",
  "git show --textconv",
  "file --compile magic",
  // Long/short/equals/helper/output variants.
  "rg --pre sh pattern script.sh",
  "rg --pre=/bin/sh -e x src",
  "rg -z pattern archive.gz",
  "rg --search-zip pattern src",
  "git log -p --ext-diff",
  "git show --textconv HEAD",
  "git diff --output=out.txt",
  "git log --output out.txt",
  "git -c diff.external=sh diff",
  "git --exec-path=/tmp diff",
  "file -C -m magic",
  "file -m magic src/a.ts",
  "tree -o out.txt",
  "grep -r pattern --include=x src",
  // Environment- and config-influenced helper paths.
  "GIT_EXTERNAL_DIFF=sh git diff",
  "env GIT_PAGER=sh git log",
  "git status",
  "git log --oneline -5",
  // Formerly permitted simple reads are no longer a shell path at all.
  "cat src/a.ts",
  "ls src",
  "rm -rf src",
];

test("R01: every coordinator bash invocation is blocked in Plan and Build, including helper/output escapes", async () => {
  const w = await managedWorld();
  try {
    const host = new FakeHost();
    const controller = registerRadian(host, { loadRuntime: async () => fakeRuntime, openSession: openProjectSession, startRun: w.startRun });
    const state: FakeCtxState = { confirms: [], confirmAnswer: true, notes: [] };
    const ctx = context(w.projectDir, "tui", state);
    await host.emit("session_start", {}, ctx);
    const accepted: string[] = [];
    const unavailable: string[] = [];
    for (const mode of ["plan", "build"] as const) {
      await controller.command(`mode ${mode}`, ctx);
      assert.equal(controller.session()?.mode.mode, mode);
      for (const command of ESCAPES) {
        const [decision] = await host.emit("tool_call", { toolName: "bash", input: { command } }, ctx);
        const blocked = typeof decision === "object" && decision !== null && (decision as { block?: boolean }).block === true;
        if (!blocked) accepted.push(`${mode}: ${command}`);
        else assert.match((decision as { reason: string }).reason, /RH-COORD-SHELL/);
      }
      for (const name of ["powershell", "codemode", "mcp_tool"]) {
        const [decision] = await host.emit("tool_call", { toolName: name, input: { command: "x" } }, ctx);
        assert.match((decision as { reason?: string } | undefined)?.reason ?? "", /RH-COORD-UNKNOWN-TOOL/, `${name} stays blocked`);
      }
      for (const [name, input] of [["read", { path: "src/a.ts" }], ["grep", { pattern: "--pre=sh", path: "src" }], ["find", { pattern: "*.ts" }], ["ls", { path: "src" }], ["radian_status", {}], ["radian_git_inspect", { op: "status" }]] as const) {
        const [decision] = await host.emit("tool_call", { toolName: name, input }, ctx);
        if (decision !== undefined) unavailable.push(`${mode}: ${name}`);
      }
    }
    assert.deepEqual(accepted, [], "no shell command may reach the uncontained coordinator shell");
    assert.deepEqual(unavailable, [], "read, search, status, and Git inspection tools remain available");
  } finally {
    removeDir(w.root);
  }
});

test("R01: the dedicated Git inspection tool runs fixed argument vectors without hooks, pagers, textconv, external diff, or fsmonitor", async () => {
  const w = await managedWorld();
  try {
    const markers = path.join(w.root, "markers");
    mkdirSync(markers);
    const helper = (name: string): string => {
      const file = path.join(w.root, `helper-${name}.sh`);
      writeFileSync(file, `#!/bin/sh\ntouch "${markers}/${name}"\ncat\n`, { mode: 0o755 });
      return file;
    };
    for (const [key, name] of [["core.fsmonitor", "fsmonitor"], ["diff.external", "external-diff"], ["core.pager", "pager"], ["pager.log", "pager-log"], ["pager.diff", "pager-diff"], ["pager.show", "pager-show"], ["pager.status", "pager-status"], ["diff.planted.textconv", "textconv"], ["filter.planted.clean", "filter-clean"], ["filter.planted.smudge", "filter-smudge"], ["core.hooksPath", "hooks"]] as const) {
      await w.fixture.git("config", key, helper(name));
    }
    w.fixture.write(".gitattributes", "*.ts diff=planted filter=planted\n");
    const first = (await w.fixture.git("rev-parse", "HEAD")).trim();
    w.fixture.write("src/a.ts", "export const a = 2;\n");
    const second = await w.fixture.commitAll("second");
    w.fixture.write("src/a.ts", "export const a = 3;\n");
    for (const entry of readdirSync(markers)) removeDir(path.join(markers, entry));

    const host = new FakeHost();
    registerRadian(host, { loadRuntime: async () => fakeRuntime, openSession: openProjectSession, startRun: w.startRun });
    const ctx = context(w.projectDir, "tui", { confirms: [], confirmAnswer: true, notes: [] });
    await host.emit("session_start", {}, ctx);

    const status = await host.callTool("radian_git_inspect", { op: "status" }, ctx);
    assert.match(status.text ?? JSON.stringify(status), /src\/a\.ts/);
    const log = await host.callTool("radian_git_inspect", { op: "log", max: 5 }, ctx);
    assert.match(log.text ?? JSON.stringify(log), new RegExp(second));
    const diff = await host.callTool("radian_git_inspect", { op: "diff", from: first, to: second }, ctx);
    assert.match(diff.text ?? JSON.stringify(diff), /export const a = 2/);
    const show = await host.callTool("radian_git_inspect", { op: "show", rev: second, path: "src/a.ts" }, ctx);
    assert.match(show.text ?? JSON.stringify(show), /export const a = 2/);
    const stat = await host.callTool("radian_git_inspect", { op: "show", rev: second }, ctx);
    assert.match(stat.text ?? JSON.stringify(stat), /src\/a\.ts/);

    for (const params of [{ op: "diff", from: "--output=/tmp/x" }, { op: "diff", from: "--ext-diff" }, { op: "show", rev: "HEAD" }, { op: "show", rev: second, path: "../outside" }, { op: "log", max: 5, rev: "--output=x" }, { op: "log", max: 100000 }, { op: "push" }]) {
      const refused = await host.callTool("radian_git_inspect", params, ctx);
      assert.ok(refused.error !== undefined || /BLOCKED/.test(refused.text ?? ""), `refused: ${JSON.stringify(params)} → ${JSON.stringify(refused)}`);
    }
    assert.deepEqual(readdirSync(markers), [], "no planted helper, pager, filter, fsmonitor, or hook ran");
    // Positive control: the same planted configuration does run under an ordinary
    // (uncontrolled) Git invocation, as a coordinator shell command would.
    spawnSync(w.fixture.ctx.gitPath, ["diff", "--ext-diff", first, second], { cwd: w.projectDir, env: { PATH: "/usr/bin:/bin", HOME: w.root }, stdio: "ignore" });
    assert.ok(readdirSync(markers).includes("external-diff"), "fixture helpers are live, so their absence above is meaningful");
  } finally {
    removeDir(w.root);
  }
});
