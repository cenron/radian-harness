import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evaluateProfile, type ResolvedProfile } from "../../../src/config/provider-policy.ts";
import { resolveAuthority, type ResolvedAuthority } from "../../../src/contracts/authority.ts";
import { newId, type AssignmentIdentity, type Role } from "../../../src/contracts/identity.ts";
import type { Projection } from "../../../src/isolation/credentials.ts";
import { CLAUDE_FORBIDDEN_FLAGS, createClaudeAdapter } from "../../../src/runtimes/claude.ts";
import { CODEX_FORBIDDEN_FLAGS, createCodexAdapter } from "../../../src/runtimes/codex.ts";
import type { LaunchInput, RuntimeInstall } from "../../../src/runtimes/contract.ts";
import { classify, classifyText, sanitizeSummary } from "../../../src/runtimes/errors.ts";
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
  for (const d of [worktree, output, scratch, path.join(root, "proj", "agent")]) mkdirSync(d, { recursive: true });
  const ops = role === "reviewer" ? ["read", "git-inspect", "write-report"] : role === "scout" ? ["read", "shell", "network-outbound", "write-report"] : ["read", "edit", "shell", "run-checks", "network-outbound", "write-report"];
  const authority = resolveAuthority({ role, worktree, readRoots: [], writeRoots: role === "reviewer" || role === "scout" ? [] : [worktree], outputDir: output, scratchDir: scratch, operations: ops as never }, { projectRoot: worktree, protectedPaths: [] });
  if (!authority.ok) throw new Error(authority.blocker.message);
  const identity: AssignmentIdentity = { workspace: newId("ws"), project: newId("prj"), run: newId("run"), task: newId("task"), assignment: newId("asg"), attempt: newId("att"), generation: 1, role };
  const projection: Projection = { dir: path.join(root, "proj"), runtime: "pi", provider: "openai", sourceFingerprint: "x", env: { PI_CODING_AGENT_DIR: path.join(root, "proj", "agent"), CODEX_HOME: path.join(root, "proj", "codex"), CLAUDE_CONFIG_DIR: path.join(root, "proj", "claude") }, readOnlyFiles: [], writableDirs: [] };
  return { root, authority: authority.value, identity, projection };
}

function input(s: ReturnType<typeof setup>, p: ResolvedProfile, install: RuntimeInstall): LaunchInput {
  return { identity: s.identity, profile: p, authority: s.authority, install, projection: s.projection, briefFile: path.join(s.authority.outputDir, "brief.md"), resultFile: path.join(s.authority.outputDir, "result.json"), sessionId: "00000000-0000-4000-8000-000000000001" };
}

const install = (runtime: "pi" | "codex" | "claude-code"): RuntimeInstall => ({ runtime, executable: `/opt/fixture/${runtime}`, version: "fixture", installRoots: ["/opt/fixture"], helpers: [] });

test("Claude Code adapter: exact model/effort, fresh session, safe mode, no bypass/bare/fallback, reviewer restricted", () => {
  for (const role of ["developer", "reviewer"] as const) {
    const s = setup(role);
    try {
      const plan = createClaudeAdapter().buildLaunch(input(s, profile("claude-code", "anthropic", "claude-test-model-1", "high"), install("claude-code")));
      assert.ok(plan.ok, plan.ok ? "" : plan.blocker.message);
      if (!plan.ok) continue;
      const argv = plan.value.argv;
      const at = (flag: string) => argv[argv.indexOf(flag) + 1];
      assert.equal(at("--model"), "claude-test-model-1");
      assert.equal(at("--effort"), "high");
      assert.equal(at("--session-id"), "00000000-0000-4000-8000-000000000001");
      for (const flag of ["-p", "--no-session-persistence", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands"]) assert.ok(argv.includes(flag), flag);
      for (const forbidden of CLAUDE_FORBIDDEN_FLAGS) assert.ok(!argv.includes(forbidden), forbidden);
      assert.equal(argv.includes("--restricted"), role === "reviewer");
      assert.deepEqual(plan.value.tools, role === "reviewer" ? ["Read", "Glob", "Grep"] : ["Read", "Glob", "Grep", "Bash", "Edit", "Write"]);
      assert.ok(!Object.keys(plan.value.env).some((k) => /API_KEY|BASE_URL|AUTH_TOKEN/.test(k)));
      assert.equal(plan.value.parity.herdrAgentDetection, false);
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

test("Codex adapter: exact model/effort, sandbox by role, user config ignored, no bypass flags", () => {
  for (const role of ["developer", "reviewer"] as const) {
    const s = setup(role);
    try {
      const plan = createCodexAdapter().buildLaunch(input(s, profile("codex", "openai", "gpt-test-1", "high"), install("codex")));
      assert.ok(plan.ok);
      if (!plan.ok) continue;
      const argv = plan.value.argv;
      assert.equal(argv[argv.indexOf("--model") + 1], "gpt-test-1");
      assert.ok(argv.includes('model_reasoning_effort="high"'));
      assert.equal(argv[argv.indexOf("--sandbox") + 1], role === "reviewer" ? "read-only" : "workspace-write");
      for (const flag of ["--json", "--ignore-user-config", "--ignore-rules", "--ephemeral"]) assert.ok(argv.includes(flag));
      for (const forbidden of CODEX_FORBIDDEN_FLAGS) assert.ok(!argv.includes(forbidden), forbidden);
      assert.equal(plan.value.env.CODEX_HOME, s.projection.env.CODEX_HOME);
    } finally {
      removeDir(s.root);
    }
  }
});

test("Pi adapter: SDK bridge launch, role tools, and explicit missing parity", () => {
  const s = setup("reviewer");
  try {
    const plan = createPiAdapter().buildLaunch(input(s, profile("pi", "openai", "gpt-test-1", "medium"), install("pi")));
    assert.ok(plan.ok);
    if (!plan.ok) return;
    assert.deepEqual(plan.value.tools, ["read", "grep", "find", "ls"]);
    assert.ok(plan.value.argv[1]!.endsWith("pi-bridge.ts"));
    assert.equal(plan.value.parity.interactiveUi, false);
    assert.equal(plan.value.env.PI_OFFLINE, "1");
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

test("event parsing: binding evidence, settlement, usage, and classified errors", () => {
  const claude = createClaudeAdapter();
  const init = claude.parseEvent(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-test-model-1", apiKeySource: "none", tools: ["Read"] }));
  assert.equal(init[0]?.kind, "session-started");
  assert.equal(init[0]?.kind === "session-started" ? init[0].authSource : "", "none");
  const failed = claude.parseEvent(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Claude usage limit reached", usage: { input_tokens: 5, output_tokens: 1 } }));
  assert.deepEqual(failed.map((e) => e.kind), ["usage", "error", "settled"]);
  assert.equal(failed[1]?.kind === "error" ? failed[1].error.class : "", "quota");
  const codex = createCodexAdapter();
  const reset = new Date(Date.now() + 3_600_000).toISOString();
  const quota = codex.parseEvent(JSON.stringify({ type: "turn.failed", error: { message: "rate limit exceeded", resets_at: reset } }));
  assert.equal(quota[0]?.kind === "error" ? quota[0].error.resetAtMs : 0, Date.parse(reset));
  assert.deepEqual(codex.parseEvent("not json"), []);
  assert.deepEqual(codex.parseEvent(JSON.stringify({ type: "thread.started", thread_id: "t" })).map((e) => e.kind), ["session-started"]);
  const pi = createPiAdapter();
  assert.deepEqual(pi.parseEvent(JSON.stringify({ type: "radian_blocker", code: "EFFORT_UNSUPPORTED", message: "clamped" })).map((e) => e.kind), ["error", "settled"]);
  assert.deepEqual(pi.parseEvent(JSON.stringify({ type: "agent_settled" })).map((e) => e.kind), ["settled"]);
});

test("error classification is provider-safe and never invents reset times", () => {
  assert.equal(classifyText("HTTP 429 Too Many Requests"), "quota");
  assert.equal(classifyText("401 Unauthorized: token expired"), "authentication");
  assert.equal(classifyText("Operation not permitted (sandbox)"), "trust-permission");
  assert.equal(classifyText("ECONNRESET while streaming"), "infrastructure");
  assert.equal(classifyText("something odd happened"), "unknown");
  assert.equal(classify("quota exhausted, try again later").resetAtMs, undefined);
  assert.equal(classify("quota exhausted", { resetsAt: "next week" }).resetAtMs, undefined);
  const secret = "s" + "k-" + "abcdefghijklmnopqrstuvwx";
  const home = ["", "Users", "fixture"].join("/");
  const cleaned = sanitizeSummary(`failed with ${secret} for someone@mail.example at ${home}/x`);
  assert.ok(!cleaned.includes(secret) && !cleaned.includes("someone@") && !cleaned.includes(home));
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
    const piLayoutMissing = await createPiAdapter({ executable: fake }).detect();
    assert.equal(piLayoutMissing.ok ? "ok" : piLayoutMissing.blocker.code, "RUNTIME_UNAVAILABLE");
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
