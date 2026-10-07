import assert from "node:assert/strict";
import { test } from "node:test";
import type { Profile } from "../../../src/core/profiles.ts";
import { SCRUBBED_ENV, runtimeArgs, showsStartupPrompt } from "../../../src/core/runtime-args.ts";

const dirs = { workerDir: "/ws/.radian/projects/demo/workers/w1", gitCommonDir: "/ws/demo/.git" };
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
    "--add-dir",
    dirs.gitCommonDir,
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

test("showsStartupPrompt recognises the trust prompts of Claude Code and Codex", () => {
  assert.equal(
    showsStartupPrompt(
      "Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder",
    ),
    true,
  );
  assert.equal(
    showsStartupPrompt(
      "Trust this folder? Codex can read, edit, and run files here.\n› 1. Trust and continue",
    ),
    true,
  );
  assert.equal(showsStartupPrompt("› Ask Codex to do anything"), false);
  assert.equal(showsStartupPrompt('❯ Try "write a test for <filepath>"'), false);
});
