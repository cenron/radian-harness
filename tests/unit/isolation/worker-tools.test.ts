// User-approved worker tools (`execution.workerTools`): each listed executable
// is exposed to the contained worker and its checks under its own name only,
// with read access limited to its resolved binary (or its .app bundle) and
// dependencies. Other executables next to it stay unreachable; invalid entries
// refuse the launch instead of widening access.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveConfig, shippedConfigDir, loadAndResolve } from "../../../src/config/resolve.ts";
import { generateProfile } from "../../../src/isolation/profile.ts";
import { resolveWorkerTools } from "../../../src/isolation/tools.ts";
import { removeDir } from "../helpers/fixture.ts";
import { authorityFor, layout } from "../helpers/layout.ts";

const native = process.platform === "darwin";

function fakeApp(root: string) {
  const exe = path.join(root, "apps", "Tool.app", "Contents", "MacOS", "Tool");
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(path.join(root, "apps", "Tool.app", "Contents", "Info.plist"), "<plist/>\n");
  writeFileSync(exe, "#!/bin/sh\necho tool-ok\n");
  chmodSync(exe, 0o755);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(exe, path.join(bin, "tool"));
  const other = path.join(root, "apps", "other");
  writeFileSync(other, "#!/bin/sh\necho other-ok\n");
  chmodSync(other, 0o755);
  symlinkSync(other, path.join(bin, "other"));
  return { configured: path.join(bin, "tool"), other: path.join(bin, "other"), bundle: path.join(root, "apps", "Tool.app") };
}

test("worker tools: config defaults to none, accepts absolute paths, refuses relative entries", () => {
  const shipped = loadAndResolve({});
  assert.ok(shipped.ok);
  if (!shipped.ok) return;
  assert.deepEqual(shipped.value.harness.execution.workerTools ?? [], []);
  const base = { layer: "shipped" as const, label: "shipped", harness: shipped.value.harness, dispatch: shipped.value.dispatch };
  const ok = resolveConfig([base, { layer: "workspace", label: "w", harness: { execution: { workerTools: ["/opt/homebrew/bin/godot"] } } }]);
  assert.ok(ok.ok && ok.value.harness.execution.workerTools?.[0] === "/opt/homebrew/bin/godot", ok.ok ? "" : ok.blocker.message);
  const relative = resolveConfig([base, { layer: "workspace", label: "w", harness: { execution: { workerTools: ["godot"] } } }]);
  assert.equal(relative.ok ? "ok" : relative.blocker.code, "CONFIG_INVALID");
  void shippedConfigDir;
});

test("worker tools: only the approved tool runs inside the sandbox, by its configured name", { skip: native ? false : "requires macOS sandbox-exec" }, async () => {
  const l = layout();
  try {
    const app = fakeApp(l.root);
    const binDir = path.join(l.output, ".radian-tools");
    const tools = await resolveWorkerTools([app.configured], binDir);
    assert.ok(tools.ok, tools.ok ? "" : tools.blocker.message);
    if (!tools.ok) return;
    assert.deepEqual(tools.value.names, ["tool"]);
    assert.ok(tools.value.readRoots.includes(app.bundle), "the whole .app bundle is readable");
    const profile = generateProfile({ authority: authorityFor(l), dependencies: { readRoots: tools.value.readRoots, readFiles: tools.value.readFiles }, denyRead: [l.secret, l.state], gitPointer: path.join(l.worktree, ".git") });
    assert.ok(profile.ok);
    if (!profile.ok) return;
    const file = path.join(l.root, "p.sb");
    writeFileSync(file, profile.value.text);
    const run = (script: string) => spawnSync("/usr/bin/sandbox-exec", ["-f", file, "/bin/sh", "-c", script], { cwd: l.worktree, env: { PATH: `${tools.value.binDir}:/usr/bin:/bin`, HOME: l.scratch }, encoding: "utf8" });
    const ok = run("tool");
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), "tool-ok");
    assert.notEqual(run(app.other).status, 0, "an unapproved neighbour of the tool is not runnable");
    assert.notEqual(run("other").status, 0, "and is not on PATH");
  } finally {
    removeDir(l.root);
  }
});

test("worker tools: missing, non-executable, relative, or duplicate entries refuse instead of widening", async () => {
  const l = layout();
  try {
    const app = fakeApp(l.root);
    const binDir = path.join(l.output, ".radian-tools");
    for (const bad of [[path.join(l.root, "missing")], ["tool"], [app.configured, app.configured], [path.join(l.root, "apps", "Tool.app", "Contents", "Info.plist")]]) {
      const out = await resolveWorkerTools(bad, binDir);
      assert.equal(out.ok ? "ok" : out.blocker.code, "CAPABILITY_MISSING", JSON.stringify(bad));
    }
    const none = await resolveWorkerTools([], binDir);
    assert.ok(none.ok && none.value.names.length === 0 && none.value.readRoots.length === 0);
  } finally {
    removeDir(l.root);
  }
});

test("worker tools reach the production launch: the contained check runs the approved tool by name, and the brief names it", { skip: native ? false : "requires macOS sandbox-exec" }, async () => {
  const { CapabilityRegistry } = await import("../../../src/isolation/capabilities.ts");
  const { SupervisionRegistry } = await import("../../../src/isolation/registry.ts");
  const { awaitBinding, launchAttempt, stopAttempt } = await import("../../../src/runtimes/session.ts");
  const { readFileSync, readdirSync } = await import("node:fs");
  const { deps, fakeCodex, request, source, verifyAll } = await import("../helpers/session-fixture.ts");
  const l = layout();
  try {
    const app = fakeApp(l.root);
    await verifyAll(new CapabilityRegistry(l.state), "developer");
    const d = { ...deps(l, fakeCodex(l, "bind-and-wait"), []), workerTools: [app.configured] };
    const r = request(l);
    const launched = await launchAttempt(d, { ...r, credentialSource: source({ count: 0 }), checks: { runs: [{ id: "tool-check", argv: ["tool"] }], timeoutMs: 20_000 } });
    assert.ok(launched.ok, launched.ok ? "" : launched.blocker.message);
    if (!launched.ok) return;
    const bound = await awaitBinding(d, launched.value, Date.now() + 30_000);
    assert.ok(bound.ok, bound.ok ? "" : bound.blocker.message);
    const check = new SupervisionRegistry(l.state, r.identity.assignment).entries().find((e) => e.kind === "check");
    assert.ok(check && check.kind === "check" && check.exitCode === 0, `the contained check ran the approved tool: ${JSON.stringify(check)}`);
    const brief = readdirSync(l.output).find((f) => f.startsWith("brief-"))!;
    assert.match(readFileSync(path.join(l.output, brief), "utf8"), /Approved tools[\s\S]*tool/);
    const stopped = await stopAttempt(d, launched.value, authorityFor(l));
    assert.equal(stopped.termination.postcondition, "verified");
  } finally {
    removeDir(l.root);
  }
});
