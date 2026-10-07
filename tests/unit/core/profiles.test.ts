import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertProfileAllowed,
  isAnthropicModel,
  selectProfile,
  type DispatchConfig,
  type Profile,
} from "../../../src/core/profiles.ts";

const claude: Profile = {
  name: "developer",
  runtime: "claude",
  model: "claude-sonnet-5-5",
  effort: "medium",
};
const codex: Profile = {
  name: "developer-codex",
  runtime: "codex",
  model: "gpt-6.1-sol",
  effort: "medium",
};
const pi: Profile = {
  name: "developer-pi",
  runtime: "pi",
  provider: "openai",
  model: "gpt-6.1-sol",
  effort: "medium",
};

const config: DispatchConfig = {
  roles: { developer: "developer", tester: "developer", reviewer: "developer", scout: "developer" },
  profiles: { developer: claude, "developer-codex": codex, "developer-pi": pi },
};

test("selectProfile uses the role default when no profile is named", () => {
  assert.equal(selectProfile(config, "developer").name, "developer");
});

test("selectProfile uses the coordinator's named profile", () => {
  assert.equal(selectProfile(config, "developer", "developer-codex").name, "developer-codex");
});

test("selectProfile rejects an unknown profile", () => {
  assert.throws(() => selectProfile(config, "developer", "nope"), /Unknown profile "nope"/);
});

test("isAnthropicModel recognises Anthropic model names and providers", () => {
  assert.equal(isAnthropicModel(claude), true);
  assert.equal(isAnthropicModel({ ...pi, model: "opus-latest" }), true);
  assert.equal(isAnthropicModel({ ...pi, provider: "anthropic", model: "x" }), true);
  assert.equal(isAnthropicModel({ ...pi, provider: "amazon-bedrock", model: "x" }), true);
  assert.equal(isAnthropicModel(codex), false);
});

test("Anthropic models run only on Claude Code", () => {
  assert.doesNotThrow(() => assertProfileAllowed(claude));
  assert.throws(
    () => assertProfileAllowed({ ...pi, model: "claude-sonnet-5-5" }),
    /Anthropic models run only on Claude Code/,
  );
  assert.throws(
    () => assertProfileAllowed({ ...codex, model: "claude-haiku-4-5" }),
    /Anthropic models run only on Claude Code/,
  );
});

test("Claude Code runs only Anthropic models", () => {
  assert.throws(() => assertProfileAllowed({ ...claude, model: "gpt-6.1-sol" }), /only Anthropic/);
});

test("a Pi profile must name its provider", () => {
  const { provider: _provider, ...withoutProvider } = pi;
  assert.throws(() => assertProfileAllowed(withoutProvider), /provider/);
});

test("effort must be one the runtime supports", () => {
  assert.throws(() => assertProfileAllowed({ ...claude, effort: "off" }), /effort "off"/);
  assert.doesNotThrow(() => assertProfileAllowed({ ...pi, effort: "off" }));
  assert.doesNotThrow(() => assertProfileAllowed({ ...codex, effort: "xhigh" }));
});
