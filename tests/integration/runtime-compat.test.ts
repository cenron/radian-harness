// Offline compatibility checks against the installed runtimes. No model
// request, authentication, refresh, provider endpoint, or Herdr operation is
// performed: Codex and Claude Code are asked only for `--help`; Pi loads the
// extension for `--help` in an isolated agent directory; the Pi SDK bridge runs
// in verify-only mode under a network-denied sandbox with synthetic
// credentials. Each check skips (not passes) when its prerequisite is absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateProfile } from "../../src/config/provider-policy.ts";
import { resolveAuthority } from "../../src/contracts/authority.ts";
import { newId, type AssignmentIdentity } from "../../src/contracts/identity.ts";
import { resolveDependencies } from "../../src/isolation/dependencies.ts";
import { generateProfile } from "../../src/isolation/profile.ts";
import { createClaudeAdapter } from "../../src/runtimes/claude.ts";
import { createCodexAdapter } from "../../src/runtimes/codex.ts";
import type { LaunchInput, RuntimeInstall } from "../../src/runtimes/contract.ts";
import { PI_BRIDGE, createPiAdapter, piLayout } from "../../src/runtimes/pi.ts";
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
  const help = spawnSync(codex!, ["exec", "--help"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: tempDir("radian-codex-") }, timeout: 20_000 }).stdout;
  for (const role of ["developer", "reviewer"] as const) {
    const l = layoutFor(role);
    try {
      const profile = evaluateProfile("codex", { runtime: "codex", provider: "openai", model: "gpt-compat-check", effort: "medium" }, {});
      assert.ok(profile.ok);
      if (!profile.ok) return;
      const install: RuntimeInstall = { runtime: "codex", executable: codex!, version: "0.160.0", installRoots: [], helpers: [] };
      const plan = createCodexAdapter().buildLaunch({ identity: l.identity, profile: profile.value, authority: l.authority, install, projection: { dir: l.dirs.projection, runtime: "codex", provider: "openai", sourceFingerprint: "x", env: { CODEX_HOME: l.dirs.projection }, readOnlyFiles: [], writableDirs: [] }, briefFile: "b", resultFile: "r", sessionId: "s" } as LaunchInput);
      assert.ok(plan.ok);
      if (!plan.ok) return;
      for (const flag of flagsOf(plan.value.argv.slice(2))) assert.ok(help.includes(flag), `codex exec --help lacks ${flag}`);
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
      const install: RuntimeInstall = { runtime: "claude-code", executable: claude!, version: "2.1.285", installRoots: [], helpers: [] };
      const plan = createClaudeAdapter().buildLaunch({ identity: l.identity, profile: profile.value, authority: l.authority, install, projection: { dir: l.dirs.projection, runtime: "claude-code", provider: "anthropic", sourceFingerprint: "x", env: { CLAUDE_CONFIG_DIR: l.dirs.projection }, readOnlyFiles: [], writableDirs: [] }, briefFile: "b", resultFile: "r", sessionId: "00000000-0000-4000-8000-000000000002" } as LaunchInput);
      assert.ok(plan.ok);
      if (!plan.ok) return;
      for (const flag of flagsOf(plan.value.argv.slice(1))) assert.ok(help.includes(flag), `claude --help lacks ${flag}`);
    } finally {
      removeDir(l.root);
    }
  }
  for (const level of RUNTIME_FACTS["claude-code"].efforts) assert.ok(help.includes(level), `--effort lacks ${level}`);
  for (const choice of ["dontAsk", "stream-json"]) assert.ok(help.includes(choice));
  assert.match(help, /--permission-prompts[\s\S]*"none"/);
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

function runBridge(l: ReturnType<typeof layoutFor>, nodePath: string, installRoot: string, entry: string, credential: Record<string, unknown>, model: string): { status: number | null; records: Array<Record<string, unknown>>; stderr: string } {
  const agentDir = path.join(l.dirs.projection, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ openai: credential }));
  writeFileSync(path.join(l.dirs.projection, "system-prompt.md"), "Synthetic compatibility check.");
  const config = {
    schema: "radian.pi-bridge/1", piEntry: pathToFileURL(entry).href, provider: "openai", model, effort: "medium",
    credentialFile: path.join(agentDir, "auth.json"), agentDir, cwd: l.dirs.worktree, tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    systemPromptFile: path.join(l.dirs.projection, "system-prompt.md"), prompt: "unused in verify-only mode", sessionId: "verify", catalogFile: path.join(l.dirs.scratch, "catalog.json"), verifyOnly: true,
  };
  const configFile = path.join(l.dirs.projection, "bridge-config.json");
  writeFileSync(configFile, JSON.stringify(config));
  const deps = resolveDependenciesSync(nodePath);
  const profile = generateProfile({ authority: l.authority, dependencies: { readRoots: [installRoot, path.dirname(path.dirname(nodePath)), path.dirname(PI_BRIDGE), ...deps.readRoots], readFiles: [...deps.readFiles, path.join(REPO, "package.json")] }, credentialDir: l.dirs.projection, denyNetwork: true });
  if (!profile.ok) throw new Error(profile.blocker.message);
  const file = path.join(l.root, "bridge.sb");
  writeFileSync(file, profile.value.text);
  const result = spawnSync("/usr/bin/sandbox-exec", ["-f", file, nodePath, PI_BRIDGE, configFile], { cwd: l.dirs.worktree, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: l.dirs.scratch, TMPDIR: l.dirs.scratch, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }, timeout: 60_000 });
  const records = result.stdout.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  return { status: result.status, records, stderr: result.stderr };
}

let cachedDeps: { readFiles: string[]; readRoots: string[] } | undefined;
function resolveDependenciesSync(nodePath: string): { readFiles: string[]; readRoots: string[] } {
  if (cachedDeps) return cachedDeps;
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", `import { resolveDependencies } from ${JSON.stringify(pathToFileURL(path.join(REPO, "src/isolation/dependencies.ts")).href)}; const r = await resolveDependencies(${JSON.stringify(nodePath)}); console.log(JSON.stringify(r));`], { encoding: "utf8", timeout: 60_000 });
  const parsed = JSON.parse(out.stdout) as { readFiles: string[]; readRoots: string[]; missing: string[] };
  assert.deepEqual(parsed.missing, [], "Pi's Node interpreter dependencies resolve narrowly");
  cachedDeps = { readFiles: parsed.readFiles, readRoots: parsed.readRoots };
  return cachedDeps;
}

test("Pi SDK bridge: public exports, exact model/effort/tools, read-only credential store, no network", { skip: pi && native ? false : "requires Pi 1.0.2 and macOS sandbox-exec" }, async () => {
  const exe = resolveExecutable("pi", process.env.PATH)!;
  const layout = piLayout(realpathSync(exe));
  assert.ok(layout.ok, layout.ok ? "" : layout.blocker.message);
  if (!layout.ok) return;
  assert.ok((await resolveDependencies(layout.value.node)).missing.length === 0);
  // Discover one catalog model for the subscription provider, offline, inside the same kind of sandbox.
  const probe = layoutFor("developer");
  try {
    const script = path.join(probe.dirs.projection, "catalog.mjs");
    writeFileSync(script, `import { ModelRuntime } from ${JSON.stringify(pathToFileURL(layout.value.entry).href)};
const store = { async read() { return undefined; }, async list() { return []; }, async modify() { throw new Error("read-only"); }, async delete() { throw new Error("read-only"); } };
const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, modelsStorePath: ${JSON.stringify(path.join(probe.dirs.scratch, "c.json"))} });
const provider = runtime.getProvider("openai");
console.log(JSON.stringify({ subscription: provider?.auth?.oauth?.isSubscription === true, models: (provider?.getModels() ?? []).map((m) => ({ id: m.id, reasoning: m.reasoning === true })) }));`);
    const deps = resolveDependenciesSync(layout.value.node);
    const profile = generateProfile({ authority: probe.authority, dependencies: { readRoots: [layout.value.installRoot, path.dirname(path.dirname(layout.value.node)), ...deps.readRoots], readFiles: deps.readFiles }, credentialDir: probe.dirs.projection, denyNetwork: true });
    assert.ok(profile.ok);
    if (!profile.ok) return;
    writeFileSync(path.join(probe.root, "catalog.sb"), profile.value.text);
    const listed = spawnSync("/usr/bin/sandbox-exec", ["-f", path.join(probe.root, "catalog.sb"), layout.value.node, script], { cwd: probe.dirs.worktree, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: probe.dirs.scratch, TMPDIR: probe.dirs.scratch, PI_OFFLINE: "1" }, timeout: 60_000 });
    assert.equal(listed.status, 0, listed.stderr.slice(0, 1500));
    const catalog = JSON.parse(listed.stdout.trim().split("\n").at(-1)!) as { subscription: boolean; models: Array<{ id: string; reasoning: boolean }> };
    assert.ok(catalog.subscription, "Pi marks the openai OAuth path as subscription-backed");
    const model = catalog.models.find((m) => m.reasoning)?.id;
    assert.ok(model, "the catalog has a reasoning-capable model");
    if (!model) return;
    const plain = catalog.models.find((m) => !m.reasoning)?.id;
    if (plain) {
      const clamped = layoutFor("developer");
      try {
        const credential = { type: "oauth", access: "synthetic-access-not-a-token", refresh: "synthetic-refresh-not-a-token", clientId: "synthetic-client", expires: Date.now() + 3_600_000 };
        const refused = runBridge(clamped, layout.value.node, layout.value.installRoot, layout.value.entry, credential, plain);
        assert.equal(refused.records.find((r) => r.type === "radian_blocker")?.code, "EFFORT_UNSUPPORTED", "a silently clamped thinking level is refused");
      } finally {
        removeDir(clamped.root);
      }
    }

    const fresh = layoutFor("developer");
    try {
      const credential = { type: "oauth", access: "synthetic-access-not-a-token", refresh: "synthetic-refresh-not-a-token", clientId: "synthetic-client", expires: Date.now() + 3_600_000 };
      const ok = runBridge(fresh, layout.value.node, layout.value.installRoot, layout.value.entry, credential, model);
      const kinds = ok.records.map((r) => r.type);
      assert.equal(ok.status, 0, `${JSON.stringify(ok.records).slice(0, 800)} ${ok.stderr.slice(0, 800)}`);
      const session = ok.records.find((r) => r.type === "radian_session")!;
      assert.equal(session.thinkingLevel, "medium");
      assert.equal(session.model, model);
      assert.deepEqual(session.tools, ["bash", "edit", "find", "grep", "ls", "read", "write"]);
      assert.ok(kinds.includes("radian_verified"));
      assert.ok(!kinds.includes("radian_prompt_accepted"), "verify-only never sends a prompt");
    } finally {
      removeDir(fresh.root);
    }
    const expired = layoutFor("developer");
    try {
      const credential = { type: "oauth", access: "synthetic-access-not-a-token", refresh: "synthetic-refresh-not-a-token", clientId: "synthetic-client", expires: 0 };
      const refused = runBridge(expired, layout.value.node, layout.value.installRoot, layout.value.entry, credential, model);
      assert.equal(refused.status, 3);
      assert.equal(refused.records.find((r) => r.type === "radian_blocker")?.code, "CREDENTIAL_EXPIRED", "refresh is refused by the read-only store, never performed");
    } finally {
      removeDir(expired.root);
    }
    const apiKey = layoutFor("developer");
    try {
      const refused = runBridge(apiKey, layout.value.node, layout.value.installRoot, layout.value.entry, { type: "api_key", key: "synthetic-not-a-key" }, model);
      assert.equal(refused.records.find((r) => r.type === "radian_blocker")?.code, "BILLING_PATH_UNVERIFIED");
    } finally {
      removeDir(apiKey.root);
    }
  } finally {
    removeDir(probe.root);
  }
});

test("Pi adapter detection accepts only the reviewed version and layout", { skip: pi ? false : "Pi 1.0.2 not installed" }, async () => {
  const detected = await createPiAdapter().detect();
  assert.ok(detected.ok, detected.ok ? "" : detected.blocker.message);
  if (detected.ok) assert.equal(detected.value.version, "1.0.2");
});
