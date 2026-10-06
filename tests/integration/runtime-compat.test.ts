// Offline compatibility checks against the installed runtimes. No model
// request, authentication, refresh, provider endpoint, or Herdr operation is
// performed: Codex and Claude Code are asked only for `--help`; Pi loads the
// extension for `--help` in an isolated agent directory. Each check skips (not
// passes) when its prerequisite is absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateProfile } from "../../src/config/provider-policy.ts";
import { resolveAuthority } from "../../src/contracts/authority.ts";
import { newId, type AssignmentIdentity } from "../../src/contracts/identity.ts";
import { createClaudeAdapter } from "../../src/runtimes/claude.ts";
import { createCodexAdapter } from "../../src/runtimes/codex.ts";
import type { LaunchInput, RuntimeInstall } from "../../src/runtimes/contract.ts";
import { createPiAdapter } from "../../src/runtimes/pi.ts";
import { RUNTIME_FACTS } from "../../src/config/runtimes.ts";
import { resolveExecutable } from "../../src/util/proc.ts";
import { removeDir, tempDir } from "../unit/helpers/fixture.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const native = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

function installed(name: string, version: string): string | undefined {
  const exe = resolveExecutable(name, process.env.PATH);
  if (!exe) return undefined;
  const out = spawnSync(exe, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: tempDir("radian-ver-") }, timeout: 20_000 });
  return out.stdout.includes(version) ? realpathSync(exe) : undefined;
}

const codex = installed("codex", "0.160.0");
const claude = installed("claude", "2.1.285");
const pi = installed("pi", "1.0.2");

function layoutFor(role: "developer" | "reviewer") {
  const root = tempDir();
  const dirs = { worktree: path.join(root, "wt"), output: path.join(root, "out"), scratch: path.join(root, "scratch"), projection: path.join(root, "projection") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const authority = resolveAuthority({ role, worktree: dirs.worktree, readRoots: [], writeRoots: role === "developer" ? [dirs.worktree] : [], outputDir: dirs.output, scratchDir: dirs.scratch, operations: role === "developer" ? ["read", "edit", "shell", "network-outbound", "write-report"] : ["read", "git-inspect", "write-report"] }, { projectRoot: dirs.worktree, protectedPaths: [] });
  if (!authority.ok) throw new Error(authority.blocker.message);
  const identity: AssignmentIdentity = { workspace: newId("ws"), project: newId("prj"), run: newId("run"), task: newId("task"), assignment: newId("asg"), attempt: newId("att"), generation: 1, role };
  return { root, dirs, authority: authority.value, identity };
}

function flagsOf(argv: readonly string[]): string[] {
  return argv.filter((a) => /^--?[A-Za-z]/.test(a) && !a.includes("=") && !a.includes(" "));
}

test("Codex CLI exposes every flag the adapter emits", { skip: codex ? false : "Codex CLI 0.160.0 not installed" }, () => {
  const help = spawnSync(codex!, ["--help"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: tempDir("radian-codex-") }, timeout: 20_000 }).stdout;
  for (const role of ["developer", "reviewer"] as const) {
    const l = layoutFor(role);
    try {
      const profile = evaluateProfile("codex", { runtime: "codex", provider: "openai", model: "gpt-compat-check", effort: "medium" }, {});
      assert.ok(profile.ok);
      if (!profile.ok) return;
      const install: RuntimeInstall = { runtime: "codex", executable: codex!, version: "0.160.0" };
      const plan = createCodexAdapter().buildLaunch({ identity: l.identity, profile: profile.value, authority: l.authority, install, systemPrompt: "role guide", briefFile: "b", resultFile: "r", sessionId: "s" } satisfies LaunchInput);
      assert.ok(plan.ok);
      if (!plan.ok) return;
      for (const flag of flagsOf(plan.value.argv.slice(1))) assert.ok(help.includes(flag), `codex --help lacks ${flag}`);
      assert.ok(help.includes("read-only") && help.includes("workspace-write"));
    } finally {
      removeDir(l.root);
    }
  }
});

test("Claude Code exposes every flag the adapter emits, with the documented choices", { skip: claude ? false : "Claude Code 2.1.285 not installed" }, () => {
  const help = spawnSync(claude!, ["--help"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: tempDir("radian-claude-"), DISABLE_AUTOUPDATER: "1" }, timeout: 20_000 }).stdout;
  for (const role of ["developer", "reviewer"] as const) {
    const l = layoutFor(role);
    try {
      const profile = evaluateProfile("claude", { runtime: "claude-code", provider: "anthropic", model: "claude-compat-check-1", effort: "high" }, {});
      assert.ok(profile.ok);
      if (!profile.ok) return;
      const install: RuntimeInstall = { runtime: "claude-code", executable: claude!, version: "2.1.285" };
      const plan = createClaudeAdapter().buildLaunch({ identity: l.identity, profile: profile.value, authority: l.authority, install, systemPrompt: "role guide", briefFile: "b", resultFile: "r", sessionId: "00000000-0000-4000-8000-000000000002" } satisfies LaunchInput);
      assert.ok(plan.ok);
      if (!plan.ok) return;
      for (const flag of flagsOf(plan.value.argv.slice(1))) assert.ok(help.includes(flag), `claude --help lacks ${flag}`);
    } finally {
      removeDir(l.root);
    }
  }
  for (const level of RUNTIME_FACTS["claude-code"].efforts) assert.ok(help.includes(level), `--effort lacks ${level}`);
  assert.ok(help.includes("dontAsk"));
});

test("Pi loads Radian's extension (isolated agent directory, offline, help only)", { skip: pi ? false : "Pi 1.0.2 not installed" }, () => {
  const fixture = tempDir();
  try {
    const agent = path.join(fixture, "agent");
    const home = path.join(fixture, "home");
    mkdirSync(agent);
    mkdirSync(home);
    const result = spawnSync(pi!, ["--no-extensions", "-e", path.join(REPO, "extensions", "radian.ts"), "--help"], {
      cwd: fixture,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", TERM: "dumb" },
      timeout: 60_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output.slice(0, 2000));
    assert.ok(!/radian[\s\S]{0,200}(error|failed|cannot)/i.test(result.stderr), result.stderr.slice(0, 2000));
  } finally {
    removeDir(fixture);
  }
});

test("Pi CLI exposes every flag the adapter emits", { skip: pi ? false : "Pi 1.0.2 not installed" }, () => {
  const help = spawnSync(pi!, ["--help"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: tempDir("radian-pi-"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }, timeout: 20_000 }).stdout;
  for (const role of ["developer", "reviewer"] as const) {
    const l = layoutFor(role);
    try {
      const profile = evaluateProfile("pi", { runtime: "pi", provider: "openai", model: "gpt-compat-check", effort: "medium" }, {});
      assert.ok(profile.ok);
      if (!profile.ok) return;
      const plan = createPiAdapter().buildLaunch({ identity: l.identity, profile: profile.value, authority: l.authority, install: { runtime: "pi", executable: pi!, version: "1.0.2" }, systemPrompt: "role guide", briefFile: "b", resultFile: "r", sessionId: "s" } satisfies LaunchInput);
      assert.ok(plan.ok);
      if (!plan.ok) return;
      for (const flag of flagsOf(plan.value.argv.slice(1))) assert.ok(help.includes(flag), `pi --help lacks ${flag}`);
    } finally {
      removeDir(l.root);
    }
  }
});

test("Pi adapter detection accepts only the reviewed version", { skip: pi ? false : "Pi 1.0.2 not installed" }, async () => {
  const detected = await createPiAdapter().detect();
  assert.ok(detected.ok, detected.ok ? "" : detected.blocker.message);
  if (detected.ok) assert.equal(detected.value.version, "1.0.2");
});
