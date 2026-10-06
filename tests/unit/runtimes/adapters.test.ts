// Runtime adapters: each worker is its runtime's normal interactive session
// (no print/exec mode), started with the exact model and effort, the role
// guide as its system prompt, an explicit tool set, and the first task message.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evaluateProfile, type ResolvedProfile } from "../../../src/config/provider-policy.ts";
import { resolveAuthority } from "../../../src/contracts/authority.ts";
import { newId, type AssignmentIdentity, type Role } from "../../../src/contracts/identity.ts";
import { CLAUDE_FORBIDDEN_FLAGS, createClaudeAdapter } from "../../../src/runtimes/claude.ts";
import { CODEX_FORBIDDEN_FLAGS, createCodexAdapter } from "../../../src/runtimes/codex.ts";
import type { LaunchInput, RuntimeInstall } from "../../../src/runtimes/contract.ts";
import { PROHIBITED_RUNTIME_ENV, workerEnv } from "../../../src/runtimes/env.ts";
import { HerdrTransport, parseCreatedPane, shellCommand, type HerdrRunner } from "../../../src/runtimes/herdr.ts";
import { createPiAdapter } from "../../../src/runtimes/pi.ts";
import { removeDir, tempDir } from "../helpers/fixture.ts";

function profile(runtime: "pi" | "codex" | "claude-code", provider: string, model: string, effort: string): ResolvedProfile {
  const p = evaluateProfile("fixture", { runtime, provider, model, effort }, {});
  if (!p.ok) throw new Error(p.blocker.code);
  return p.value;
}

function setup(role: Role) {
  const root = tempDir();
  const worktree = path.join(root, "wt");
  const output = path.join(root, "out");
  const scratch = path.join(root, "scratch");
  for (const d of [worktree, output, scratch]) mkdirSync(d, { recursive: true });
  const ops = role === "reviewer" ? ["read", "git-inspect", "write-report"] : role === "scout" ? ["read", "shell", "network-outbound", "write-report"] : ["read", "edit", "shell", "run-checks", "network-outbound", "write-report"];
  const authority = resolveAuthority({ role, worktree, readRoots: [], writeRoots: role === "reviewer" || role === "scout" ? [] : [worktree], outputDir: output, scratchDir: scratch, operations: ops as never }, { projectRoot: worktree, protectedPaths: [] });
  if (!authority.ok) throw new Error(authority.blocker.message);
  const identity: AssignmentIdentity = { workspace: newId("ws"), project: newId("prj"), run: newId("run"), task: newId("task"), assignment: newId("asg"), attempt: newId("att"), generation: 1, role };
  return { root, authority: authority.value, identity };
}

const SYSTEM = "You are the Radian developer.\nFollow the brief.";

function input(s: ReturnType<typeof setup>, p: ResolvedProfile, install: RuntimeInstall): LaunchInput {
  return { identity: s.identity, profile: p, authority: s.authority, install, systemPrompt: SYSTEM, briefFile: path.join(s.authority.outputDir, "brief.md"), resultFile: path.join(s.authority.outputDir, "result.json"), sessionId: "00000000-0000-4000-8000-000000000001" };
}

const install = (runtime: "pi" | "codex" | "claude-code"): RuntimeInstall => ({ runtime, executable: `/opt/fixture/${runtime}`, version: "fixture" });
const lastArg = (argv: string[]) => argv[argv.length - 1]!;

test("Claude Code adapter: interactive session with exact model/effort, session id, system prompt, tools, first task message", () => {
  for (const role of ["developer", "reviewer"] as const) {
    const s = setup(role);
    try {
      const plan = createClaudeAdapter().buildLaunch(input(s, profile("claude-code", "anthropic", "claude-test-model-1", "high"), install("claude-code")));
      assert.ok(plan.ok, plan.ok ? "" : plan.blocker.message);
      if (!plan.ok) continue;
      const argv = plan.value.argv;
      const at = (flag: string) => argv[argv.indexOf(flag) + 1];
      assert.equal(argv[0], "/opt/fixture/claude-code");
      assert.ok(!argv.includes("-p") && !argv.includes("--print") && !argv.includes("--output-format"), "interactive, not print mode");
      assert.equal(at("--model"), "claude-test-model-1");
      assert.equal(at("--effort"), "high");
      assert.equal(at("--session-id"), "00000000-0000-4000-8000-000000000001");
      assert.equal(at("--append-system-prompt"), SYSTEM);
      assert.equal(at("--permission-mode"), "dontAsk");
      assert.equal(at("--add-dir"), s.authority.outputDir, "the session can write its result outside the worktree");
      assert.ok(argv.includes("--strict-mcp-config"));
      for (const forbidden of CLAUDE_FORBIDDEN_FLAGS) assert.ok(!argv.includes(forbidden), forbidden);
      assert.match(lastArg(argv), /brief\.md[\s\S]*result\.json/, "the first message points at the brief and result files");
      // A live run lost the first message: `--add-dir <directories...>` took it as another directory.
      const optionBeforePrompt = argv[argv.length - 3];
      assert.ok(!["--add-dir", "--tools", "--allowedTools", "--allowed-tools", "--disallowedTools", "--mcp-config", "--betas", "--plugin-dir"].includes(optionBeforePrompt!), `a list-valued option (${optionBeforePrompt}) must not precede the first message`);
      assert.deepEqual(plan.value.tools, role === "reviewer" ? ["Read", "Glob", "Grep", "Write"] : ["Read", "Glob", "Grep", "Bash", "Edit", "Write"]);
      assert.equal(plan.value.cwd, s.authority.worktree);
    } finally {
      removeDir(s.root);
    }
  }
});

test("Anthropic profiles are refused by Pi and Codex adapters; Claude Code refuses non-Anthropic profiles", () => {
  const s = setup("developer");
  try {
    const anthropic = profile("claude-code", "anthropic", "claude-test-model-1", "high");
    const asPi = createPiAdapter().buildLaunch(input(s, { ...anthropic, runtime: "pi" }, install("pi")));
    assert.equal(asPi.ok ? "ok" : asPi.blocker.code, "ANTHROPIC_REQUIRES_CLAUDE_CODE");
    const asCodex = createCodexAdapter().buildLaunch(input(s, { ...anthropic, runtime: "codex" }, install("codex")));
    assert.equal(asCodex.ok ? "ok" : asCodex.blocker.code, "ANTHROPIC_REQUIRES_CLAUDE_CODE");
    const openai = profile("codex", "openai", "gpt-test-1", "medium");
    const asClaude = createClaudeAdapter().buildLaunch(input(s, { ...openai, runtime: "claude-code" }, install("claude-code")));
    assert.equal(asClaude.ok ? "ok" : asClaude.blocker.code, "RUNTIME_PROVIDER_MISMATCH");
  } finally {
    removeDir(s.root);
  }
});

test("Codex adapter: interactive session with exact model/effort, developer instructions, sandbox by role, no bypass flags", () => {
  for (const role of ["developer", "reviewer"] as const) {
    const s = setup(role);
    try {
      const plan = createCodexAdapter().buildLaunch(input(s, profile("codex", "openai", "gpt-test-1", "high"), install("codex")));
      assert.ok(plan.ok);
      if (!plan.ok) continue;
      const argv = plan.value.argv;
      assert.ok(!argv.includes("exec") && !argv.includes("--json"), "interactive, not exec mode");
      assert.equal(argv[argv.indexOf("--model") + 1], "gpt-test-1");
      assert.ok(argv.includes('model_reasoning_effort="high"'));
      assert.ok(argv.includes(`developer_instructions=${JSON.stringify(SYSTEM)}`));
      assert.equal(argv[argv.indexOf("--sandbox") + 1], role === "reviewer" ? "read-only" : "workspace-write");
      assert.equal(argv[argv.indexOf("--ask-for-approval") + 1], "never");
      assert.equal(argv[argv.indexOf("--cd") + 1], s.authority.worktree);
      for (const forbidden of CODEX_FORBIDDEN_FLAGS) assert.ok(!argv.includes(forbidden), forbidden);
      assert.match(lastArg(argv), /brief\.md/);
    } finally {
      removeDir(s.root);
    }
  }
});

test("Pi adapter: interactive session with provider/model/thinking, system prompt, role tools, no project-local or extension loading", () => {
  const s = setup("reviewer");
  try {
    const plan = createPiAdapter().buildLaunch(input(s, profile("pi", "openai", "gpt-test-1", "medium"), install("pi")));
    assert.ok(plan.ok);
    if (!plan.ok) return;
    const argv = plan.value.argv;
    assert.ok(!argv.includes("-p") && !argv.includes("--print") && !argv.includes("--mode"), "interactive, not print or RPC mode");
    assert.equal(argv[argv.indexOf("--provider") + 1], "openai");
    assert.equal(argv[argv.indexOf("--model") + 1], "gpt-test-1");
    assert.equal(argv[argv.indexOf("--thinking") + 1], "medium");
    assert.equal(argv[argv.indexOf("--append-system-prompt") + 1], SYSTEM);
    for (const flag of ["--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates"]) assert.ok(argv.includes(flag), flag);
    assert.deepEqual(plan.value.tools, ["read", "grep", "find", "ls", "write"]);
  } finally {
    removeDir(s.root);
  }
  const dev = setup("developer");
  try {
    const plan = createPiAdapter().buildLaunch(input(dev, profile("pi", "openai", "gpt-test-1", "medium"), install("pi")));
    assert.ok(plan.ok && plan.value.tools.includes("bash") && plan.value.tools.includes("edit"));
  } finally {
    removeDir(dev.root);
  }
});

test("worker environment inherits the user's environment without API-key, endpoint, proxy, or Radian variables", () => {
  const env = workerEnv({ HOME: "/fixture-home", PATH: "/opt/homebrew/bin:/usr/bin", ANTHROPIC_API_KEY: "k", OPENAI_BASE_URL: "u", https_proxy: "p", RADIAN_ATTEMPT: "a" }, { DISABLE_AUTOUPDATER: "1", OPENAI_API_KEY: "never" });
  assert.equal(env.HOME, "/fixture-home");
  assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
  assert.equal(env.DISABLE_AUTOUPDATER, "1");
  for (const name of [...PROHIBITED_RUNTIME_ENV, "https_proxy", "RADIAN_ATTEMPT"]) assert.ok(!(name in env), name);
});

test("runtime detection refuses missing runtimes and unreviewed versions", async () => {
  const dir = tempDir();
  try {
    const fake = path.join(dir, "codex");
    writeFileSync(fake, "#!/bin/sh\necho 'codex-cli 9.9.9'\n", { mode: 0o755 });
    const unsupported = await createCodexAdapter({ executable: fake }).detect();
    assert.equal(unsupported.ok ? "ok" : unsupported.blocker.code, "RUNTIME_VERSION_UNSUPPORTED");
    writeFileSync(fake, "#!/bin/sh\necho 'codex-cli 0.160.0'\n", { mode: 0o755 });
    const ok = await createCodexAdapter({ executable: fake }).detect();
    assert.ok(ok.ok && ok.value.version === "0.160.0");
    const missing = await createClaudeAdapter({ executable: path.join(dir, "absent") }).detect();
    assert.equal(missing.ok ? "ok" : missing.blocker.code, "RUNTIME_UNAVAILABLE");
    const piWrongVersion = await createPiAdapter({ executable: fake }).detect();
    assert.equal(piWrongVersion.ok ? "ok" : piWrongVersion.blocker.code, "RUNTIME_VERSION_UNSUPPORTED");
  } finally {
    removeDir(dir);
  }
});

function fakeHerdr(responses: Partial<Record<string, { code: number; stdout: string; timedOut?: boolean }>>): { runner: HerdrRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: HerdrRunner = async (args) => {
    calls.push([...args]);
    const r = responses[`${args[0]} ${args[1]}`] ?? { code: 0, stdout: "{}" };
    return { code: r.code, stdout: r.stdout, stderr: "", timedOut: r.timedOut ?? false };
  };
  return { runner, calls };
}

test("Herdr transport: explicit parent, no focus, owned IDs only, no resend, close only after verified termination", async () => {
  const dir = tempDir();
  try {
    const { runner, calls } = fakeHerdr({ "pane split": { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p7" } } }) } });
    const transport = new HerdrTransport({ runner, stateDir: dir });
    const pane = await transport.createPane({ assignment: "asg_fixture-1", attempt: "att_fixture-1", parentPane: "w1:p1", cwd: "/tmp" });
    assert.ok(pane.ok && pane.value.paneId === "w1:p7");
    assert.deepEqual(calls[0], ["pane", "split", "--pane", "w1:p1", "--direction", "right", "--cwd", "/tmp", "--no-focus"]);
    const unowned = await transport.runInPane("w1:p2", ["/bin/true"]);
    assert.equal(unowned.ok ? "ok" : unowned.blocker.code, "OWNERSHIP_AMBIGUOUS");
    assert.ok((await transport.runInPane("w1:p7", ["/usr/bin/node", "x y", "it's"])).ok);
    assert.equal(calls.at(-1)?.[3], `'/usr/bin/node' 'x y' 'it'"'"'s'`);
    const refusedClose = await transport.closePane("w1:p7", "unknown");
    assert.equal(refusedClose.ok ? "ok" : refusedClose.blocker.code, "TERMINATION_UNVERIFIED");
    assert.ok((await transport.closePane("w1:p7", "verified")).ok);
    assert.equal(await transport.owned("w1:p7"), undefined);

    const slow = fakeHerdr({ "pane split": { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p9" } } }) }, "pane run": { code: 1, stdout: "", timedOut: true } });
    const t2 = new HerdrTransport({ runner: slow.runner, stateDir: path.join(dir, "2") });
    await t2.createPane({ assignment: "asg_fixture-2", attempt: "att_fixture-2", parentPane: "w1:p1", cwd: "/tmp" });
    const uncertain = await t2.runInPane("w1:p9", ["/bin/true"]);
    assert.ok(uncertain.ok && uncertain.value === "uncertain");
    assert.equal(slow.calls.filter((c) => c[1] === "run").length, 1, "uncertain delivery is never resent");

    const bad = fakeHerdr({ "pane split": { code: 0, stdout: "not json" } });
    const t3 = new HerdrTransport({ runner: bad.runner, stateDir: path.join(dir, "3") });
    const failed = await t3.createPane({ assignment: "asg_fixture-3", attempt: "att_fixture-3", parentPane: "w1:p1", cwd: "/tmp" });
    assert.equal(failed.ok ? "ok" : failed.blocker.code, "TRANSPORT_FAILURE");
    assert.equal(parseCreatedPane(JSON.stringify({ result: { pane: { pane_id: "bad id; rm" } } })), undefined);
    assert.equal(shellCommand(["a\nb"]).ok, false);
  } finally {
    removeDir(dir);
  }
});
