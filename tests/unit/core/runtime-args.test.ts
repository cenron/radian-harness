import assert from "node:assert/strict";
import { test } from "node:test";
import type { Profile } from "../../../src/core/profiles.ts";
import { SCRUBBED_ENV, readScreen, runtimeArgs } from "../../../src/core/runtime-args.ts";

const dirs = { workerDir: "/ws/.radian/projects/demo/workers/w1" };
const claude: Profile = {
  name: "c",
  runtime: "claude",
  model: "claude-sonnet-5-5",
  effort: "high",
};
const codex: Profile = { name: "x", runtime: "codex", model: "gpt-6.1-sol", effort: "medium" };
const pi: Profile = {
  name: "p",
  runtime: "pi",
  provider: "openai",
  model: "gpt-6.1-sol",
  effort: "low",
};

test("claude flags carry model, effort, role tools, and the worker directory", () => {
  const args = runtimeArgs({ profile: claude, role: "developer", ...dirs });
  assert.deepEqual(args, [
    "--model",
    "claude-sonnet-5-5",
    "--effort",
    "high",
    "--tools",
    "Read,Glob,Grep,Bash,Write,Edit",
    "--allowedTools",
    "Read,Glob,Grep,Bash,Write,Edit",
    "--add-dir",
    dirs.workerDir,
    "--permission-mode",
    "dontAsk",
  ]);
});

test("claude reviewers get no Edit tool", () => {
  const args = runtimeArgs({ profile: claude, role: "reviewer", ...dirs });
  assert.ok(args.includes("Read,Glob,Grep,Bash,Write"));
  assert.ok(!args.some((arg) => arg.includes("Edit")));
});

test("codex flags set effort, sandbox, approvals, and writable directories", () => {
  assert.deepEqual(runtimeArgs({ profile: codex, role: "tester", ...dirs }), [
    "--model",
    "gpt-6.1-sol",
    "-c",
    'model_reasoning_effort="medium"',
    "-c",
    "sandbox_workspace_write.network_access=true",
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    "--add-dir",
    dirs.workerDir,
  ]);
});

test("pi flags select provider, thinking, tools, and skip project files and extensions", () => {
  assert.deepEqual(runtimeArgs({ profile: pi, role: "scout", ...dirs }), [
    "--provider",
    "openai",
    "--model",
    "gpt-6.1-sol",
    "--thinking",
    "low",
    "--tools",
    "read,grep,find,ls,bash,write",
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
  ]);
  assert.ok(
    runtimeArgs({ profile: pi, role: "developer", ...dirs }).includes(
      "read,grep,find,ls,bash,write,edit",
    ),
  );
});

test("no runtime receives a prompt on its command line", () => {
  for (const profile of [claude, codex, pi]) {
    const args = runtimeArgs({ profile, role: "developer", ...dirs });
    assert.ok(args.every((arg) => !/Read and do/.test(arg)));
  }
});

test("runtimeArgs refuses an Anthropic model on another runtime", () => {
  assert.throws(
    () => runtimeArgs({ profile: { ...pi, model: "claude-opus-5-5" }, role: "developer", ...dirs }),
    /Anthropic/,
  );
});

test("SCRUBBED_ENV blanks API keys, endpoints, and proxies", () => {
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "HTTPS_PROXY"]) {
    assert.ok(SCRUBBED_ENV.includes(key), key);
  }
});

// Screens captured from real Herdr panes during the smoke test, including narrow ones.
const CLAUDE_TRUST = ` Accessing workspace:
 ~/ws/.radian/projects/demo/worktrees/demo-developer-1
 Quick safety check: Is this a project you created or one
 you trust? (Like your own code, a well-known open source
 Claude Code'll be able to read, edit, and execute files
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`;
const CLAUDE_READY = ` ▐▛███▛█   Claude Code v2.1.285
❯ Try "write a test for <filepath>"
  ⏵⏵ don't ask on (shift+tab to cycle) · ← for agents`;
const CODEX_TRUST = `  Note: You’re in a subdirectory of a Git project. Trusting
  Trust this folder? Codex can read, edit, and run files
  here, subject to your permission settings.
› 1. Trust and continue
  2. Quit`;
const CODEX_TRUST_NARROW = `  Trust this fol
  der? Codex can
› 1. Trust and c`;
const CODEX_READY_NARROW = `  >_ OpenAI C…
› Ask Codex t
  GPT-6.1-Sol…`;
const PI_READY = ` ▀▀█  v1.0.2
 █▀ █ escape interrupt ·
 ctrl+c/ctrl+d clear/exit`;

test("readScreen finds a startup prompt, even wrapped in a narrow pane", () => {
  assert.equal(readScreen("claude", CLAUDE_TRUST), "asking");
  assert.equal(readScreen("codex", CODEX_TRUST), "asking");
  assert.equal(readScreen("codex", CODEX_TRUST_NARROW), "asking");
});

// A 32-column pane cuts Claude Code's footer short (captured live).
const CLAUDE_READY_NARROW = `❯ Try "refactor <filepath>"
──────────────────────────────
  ⏵⏵ don't ask on (shift+tab`;

test("readScreen reports ready only when the runtime's input is showing", () => {
  assert.equal(readScreen("claude", CLAUDE_READY_NARROW), "ready");
  assert.equal(readScreen("claude", CLAUDE_READY), "ready");
  assert.equal(readScreen("codex", CODEX_READY_NARROW), "ready");
  assert.equal(readScreen("pi", PI_READY), "ready");
});

test("readScreen treats anything else as still starting, so nothing is typed yet", () => {
  for (const runtime of ["claude", "codex", "pi"] as const)
    assert.equal(readScreen(runtime, ""), "starting");
  assert.equal(
    readScreen("claude", "radni@mac ~/ws % claude --model claude-sonnet-5-5"),
    "starting",
  );
});
