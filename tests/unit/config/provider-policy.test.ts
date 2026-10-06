import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateProfile, recheckResolvedProfile, type ProfileInput } from "../../../src/config/provider-policy.ts";

// Synthetic model identifiers used only by tests; they are not shipped defaults.
const OPENAI_MODEL = "gpt-test-1";
const CLAUDE_MODEL = "claude-test-model-1";

function evaluate(profile: ProfileInput, aliases = {}, raw = {}) {
  return evaluateProfile("p", profile, aliases, raw);
}

function code(outcome: ReturnType<typeof evaluate>): string {
  return outcome.ok ? "ok" : outcome.blocker.code;
}

test("Anthropic models are permitted only on Claude Code with provider anthropic", () => {
  assert.equal(code(evaluate({ runtime: "claude-code", provider: "anthropic", model: CLAUDE_MODEL, effort: "high" })), "ok");
  for (const runtime of ["pi", "codex"] as const) {
    assert.equal(code(evaluate({ runtime, provider: "anthropic", model: CLAUDE_MODEL, effort: "medium" })), "ANTHROPIC_REQUIRES_CLAUDE_CODE");
  }
});

test("disguised Anthropic models through other providers or names are rejected", () => {
  // Custom provider name with an Anthropic model on Pi.
  assert.equal(code(evaluate({ runtime: "pi", provider: "my-gateway", model: CLAUDE_MODEL, effort: "medium" })), "ANTHROPIC_REQUIRES_CLAUDE_CODE");
  // Known non-Anthropic provider carrying an Anthropic model name.
  assert.equal(code(evaluate({ runtime: "pi", provider: "openai", model: "opus-preview-2", effort: "medium" })), "ANTHROPIC_REQUIRES_CLAUDE_CODE");
  assert.equal(code(evaluate({ runtime: "codex", provider: "openai", model: "sonnet-x1", effort: "medium" })), "ANTHROPIC_REQUIRES_CLAUDE_CODE");
  // Anthropic model via a non-anthropic provider on Claude Code (custom endpoint disguise).
  assert.equal(code(evaluate({ runtime: "claude-code", provider: "bedrock", model: CLAUDE_MODEL, effort: "high" })), "PROVIDER_PROVENANCE_UNKNOWN");
});

test("aliases resolve fully and every chain element is inspected", () => {
  const aliases = {
    fast: { model: "@inner" },
    inner: { provider: "openai", model: CLAUDE_MODEL },
    plain: { provider: "openai", model: OPENAI_MODEL },
    loop: { model: "@loop" },
  };
  assert.equal(code(evaluate({ runtime: "pi", provider: "openai", model: "@fast", effort: "medium" }, aliases)), "ANTHROPIC_REQUIRES_CLAUDE_CODE");
  const ok = evaluate({ runtime: "pi", provider: "openai", model: "@plain", effort: "medium" }, aliases);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.value.model, OPENAI_MODEL);
    assert.deepEqual(ok.value.aliasChain, ["plain"]);
  }
  assert.equal(code(evaluate({ runtime: "pi", provider: "openai", model: "@loop", effort: "medium" }, aliases)), "ALIAS_UNRESOLVED");
  assert.equal(code(evaluate({ runtime: "pi", provider: "openai", model: "@missing", effort: "medium" }, aliases)), "ALIAS_UNRESOLVED");
  // An alias whose name implies Anthropic provenance is suspicious even if its target is not.
  const named = { "opus-like": { provider: "openai", model: OPENAI_MODEL } };
  assert.equal(code(evaluate({ runtime: "pi", provider: "openai", model: "@opus-like", effort: "medium" }, named)), "ANTHROPIC_REQUIRES_CLAUDE_CODE");
});

test("native aliases, provider prefixes, and thinking suffixes are not exact IDs", () => {
  assert.equal(code(evaluate({ runtime: "claude-code", provider: "anthropic", model: "opus", effort: "high" })), "ALIAS_UNRESOLVED");
  assert.equal(code(evaluate({ runtime: "claude-code", provider: "anthropic", model: "sonnet[1m]", effort: "high" })), "ALIAS_UNRESOLVED");
  assert.equal(code(evaluate({ runtime: "pi", provider: "openai", model: `openai/${OPENAI_MODEL}`, effort: "medium" })), "PROVIDER_PROVENANCE_UNKNOWN");
  assert.equal(code(evaluate({ runtime: "pi", provider: "openai", model: `${OPENAI_MODEL}:high`, effort: "medium" })), "PROVIDER_PROVENANCE_UNKNOWN");
  assert.equal(code(evaluate({ runtime: "pi", provider: "openai", model: "gpt-*", effort: "medium" })), "ALIAS_UNRESOLVED");
});

test("unknown providers, mismatched runtimes, and custom endpoints block", () => {
  assert.equal(code(evaluate({ runtime: "pi", provider: "some-new-provider", model: "m-1", effort: "medium" })), "PROVIDER_PROVENANCE_UNKNOWN");
  assert.equal(code(evaluate({ runtime: "claude-code", provider: "openai", model: OPENAI_MODEL, effort: "high" })), "RUNTIME_PROVIDER_MISMATCH");
  assert.equal(code(evaluate({ runtime: "pi", provider: "openai", model: OPENAI_MODEL, effort: "medium" }, {}, { baseUrl: "x" })), "CUSTOM_ENDPOINT_PROHIBITED");
  assert.equal(code(evaluate({ runtime: "pi", provider: "openai", model: OPENAI_MODEL, effort: "medium" }, {}, { apiKeyEnv: "X" })), "CUSTOM_ENDPOINT_PROHIBITED");
});

test("unconfigured profiles and unsupported effort block without clamping", () => {
  assert.equal(code(evaluate({ runtime: "pi", provider: null, model: null, effort: "medium" })), "PROFILE_UNCONFIGURED");
  assert.equal(code(evaluate({ runtime: "claude-code", provider: "anthropic", model: CLAUDE_MODEL, effort: "minimal" })), "EFFORT_UNSUPPORTED");
  assert.equal(code(evaluate({ runtime: "codex", provider: "openai", model: OPENAI_MODEL, effort: "max" })), "EFFORT_UNSUPPORTED");
});

test("recheck refuses a resolved profile whose request carried Anthropic provenance", () => {
  const ok = evaluate({ runtime: "pi", provider: "openai", model: OPENAI_MODEL, effort: "medium" });
  assert.ok(ok.ok);
  if (!ok.ok) return;
  assert.ok(recheckResolvedProfile(ok.value).ok);
  const tampered = { ...ok.value, requested: { provider: "openai", model: CLAUDE_MODEL } };
  const again = recheckResolvedProfile(tampered);
  assert.equal(again.ok ? "ok" : again.blocker.code, "ANTHROPIC_REQUIRES_CLAUDE_CODE");
  const swapped = { ...ok.value, model: CLAUDE_MODEL };
  const swappedCheck = recheckResolvedProfile(swapped);
  assert.equal(swappedCheck.ok ? "ok" : swappedCheck.blocker.code, "ANTHROPIC_REQUIRES_CLAUDE_CODE");
});
