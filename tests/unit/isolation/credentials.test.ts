import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evaluateProfile, type ResolvedProfile } from "../../../src/config/provider-policy.ts";
import { newId, type AssignmentIdentity } from "../../../src/contracts/identity.ts";
import { CapabilityRegistry, type CapabilityContext } from "../../../src/isolation/capabilities.ts";
import { CredentialBroker, assertNoProhibitedEnv, claudeKeychainSource, codexAuthFileSource, piAuthFileSource, type CredentialSource } from "../../../src/isolation/credentials.ts";
import { PROFILE_TEMPLATE_VERSION } from "../../../src/isolation/profile.ts";
import { HumanChannel } from "../../../src/state/approvals.ts";
import { FakeClock } from "../../../src/util/clock.ts";
import { removeDir, tempDir } from "../helpers/fixture.ts";

const clock = new FakeClock(Date.UTC(2026, 5, 1));
const HOUR = 3_600_000;

function profile(runtime: "pi" | "codex" | "claude-code", provider: string, model: string, effort = "medium"): ResolvedProfile {
  const p = evaluateProfile("fixture", { runtime, provider, model, effort }, {});
  if (!p.ok) throw new Error(p.blocker.code);
  return p.value;
}

function identity(): AssignmentIdentity {
  return { workspace: newId("ws"), project: newId("prj"), run: newId("run"), task: newId("task"), assignment: newId("asg"), attempt: newId("att"), generation: 1, role: "developer" };
}

async function verifiedRegistry(dir: string, runtime: "pi" | "codex" | "claude-code"): Promise<{ registry: CapabilityRegistry; context: CapabilityContext }> {
  const registry = new CapabilityRegistry(dir, clock);
  const context: CapabilityContext = { osVersion: "27.0", runtime, runtimeVersion: "fixture", policyTemplate: PROFILE_TEMPLATE_VERSION };
  const human = HumanChannel.fromUserInput("user-command", "fixture-user", "/radian capability");
  await registry.record(human, { capability: `credential.${runtime}.non-refreshing-access`, status: "verified", context, reference: "synthetic" });
  await registry.record(human, { capability: `billing.${runtime}.subscription-path`, status: "verified", context, reference: "synthetic" });
  return { registry, context };
}

function spySource(inner: CredentialSource): CredentialSource & { reads: number } {
  const spy = { ...inner, reads: 0, read: async () => { spy.reads += 1; return inner.read(); } };
  return spy;
}

test("Pi projection: only the selected subscription provider, read-only, personal store untouched", async () => {
  const dir = tempDir();
  try {
    const store = path.join(dir, "personal-auth.json");
    const personal = { openai: { type: "oauth", access: "synthetic-a", refresh: "synthetic-r", expires: clock.now() + 4 * HOUR }, other: { type: "api_key", key: "synthetic-k" } };
    writeFileSync(store, JSON.stringify(personal));
    const before = readFileSync(store, "utf8");
    const { registry, context } = await verifiedRegistry(dir, "pi");
    const broker = new CredentialBroker(clock);
    const result = await broker.project({ identity: identity(), profile: profile("pi", "openai", "gpt-test-1"), source: piAuthFileSource(store, "openai"), projectionRoot: path.join(dir, "projections"), minValidityMs: HOUR, capabilities: registry, capabilityContext: context });
    assert.ok(result.ok, result.ok ? "" : result.blocker.message);
    if (!result.ok) return;
    const projected = JSON.parse(readFileSync(result.value.readOnlyFiles[0]!, "utf8"));
    assert.deepEqual(Object.keys(projected), ["openai"], "multi-provider store is never projected");
    assert.equal(statSync(result.value.readOnlyFiles[0]!).mode & 0o777, 0o400);
    assert.equal(readFileSync(store, "utf8"), before, "personal store unchanged");
    assert.ok(result.value.env.PI_CODING_AGENT_DIR?.startsWith(result.value.dir));
    // Rotation of the personal store retires the projection.
    writeFileSync(store, JSON.stringify({ ...personal, openai: { ...personal.openai, access: "rotated" } }));
    const rotated = await broker.check(result.value, piAuthFileSource(store, "openai"), HOUR);
    assert.equal(rotated.ok ? "ok" : rotated.blocker.code, "CREDENTIAL_EXPIRED");
    assert.ok(broker.destroy(result.value).ok);
    assert.ok(!existsSync(result.value.dir));
  } finally {
    removeDir(dir);
  }
});

test("Anthropic credentials never reach Pi/Codex; prohibited pairings are refused before any read", async () => {
  const dir = tempDir();
  try {
    const { registry, context } = await verifiedRegistry(dir, "pi");
    const claudeSource = spySource(claudeKeychainSource("fixture-service", async () => JSON.stringify({ claudeAiOauth: { accessToken: "synthetic", expiresAt: clock.now() + 5 * HOUR } })));
    const piProfile = profile("pi", "openai", "gpt-test-1");
    const crossed = await new CredentialBroker(clock).project({ identity: identity(), profile: piProfile, source: claudeSource, projectionRoot: path.join(dir, "p"), minValidityMs: HOUR, capabilities: registry, capabilityContext: context });
    assert.equal(crossed.ok ? "ok" : crossed.blocker.code, "CREDENTIAL_EXPOSURE_PROHIBITED");
    // A tampered resolved profile carrying an Anthropic model on Pi is refused by the recheck.
    const tampered = { ...piProfile, model: "claude-test-model-1" };
    const disguised = await new CredentialBroker(clock).project({ identity: identity(), profile: tampered, source: claudeSource, projectionRoot: path.join(dir, "p"), minValidityMs: HOUR, capabilities: registry, capabilityContext: context });
    assert.equal(disguised.ok ? "ok" : disguised.blocker.code, "ANTHROPIC_REQUIRES_CLAUDE_CODE");
    assert.equal(claudeSource.reads, 0, "no credential was read for a prohibited pairing");
    assert.ok(!existsSync(path.join(dir, "p")));
  } finally {
    removeDir(dir);
  }
});

test("unverified credential/billing capabilities block before the source is read", async () => {
  const dir = tempDir();
  try {
    const registry = new CapabilityRegistry(dir, clock);
    const context: CapabilityContext = { osVersion: "27.0", runtime: "claude-code", runtimeVersion: "fixture", policyTemplate: PROFILE_TEMPLATE_VERSION };
    const source = spySource(claudeKeychainSource("fixture-service", async () => JSON.stringify({ claudeAiOauth: { accessToken: "synthetic", expiresAt: clock.now() + 5 * HOUR } })));
    const result = await new CredentialBroker(clock).project({ identity: identity(), profile: profile("claude-code", "anthropic", "claude-test-model-1", "high"), source, projectionRoot: path.join(dir, "p"), minValidityMs: HOUR, capabilities: registry, capabilityContext: context });
    assert.equal(result.ok ? "ok" : result.blocker.code, "CAPABILITY_UNVERIFIED");
    assert.equal(source.reads, 0);
  } finally {
    removeDir(dir);
  }
});

test("API keys, unknown types, unknown expiry, and expiring credentials block", async () => {
  const dir = tempDir();
  try {
    const { registry, context } = await verifiedRegistry(dir, "codex");
    const broker = new CredentialBroker(clock);
    const codex = profile("codex", "openai", "gpt-test-1");
    const file = path.join(dir, "codex-auth.json");
    const run = async () => {
      const r = await broker.project({ identity: identity(), profile: codex, source: codexAuthFileSource(file), projectionRoot: path.join(dir, "p"), minValidityMs: HOUR, capabilities: registry, capabilityContext: context });
      return r.ok ? "ok" : r.blocker.code;
    };
    writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: "synthetic-key-value" }));
    assert.equal(await run(), "BILLING_PATH_UNVERIFIED");
    writeFileSync(file, JSON.stringify({ something: "else" }));
    assert.equal(await run(), "BILLING_PATH_UNVERIFIED");
    const jwt = (exp: number) => ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString("base64url"), "sig"].join(".");
    writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: "opaque-without-expiry" } }));
    assert.equal(await run(), "CREDENTIAL_REFRESH_OWNERSHIP");
    writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: jwt(clock.now() + 10 * 60_000) } }));
    assert.equal(await run(), "CREDENTIAL_REFRESH_OWNERSHIP");
    writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: jwt(clock.now() + 3 * HOUR) } }));
    assert.equal(await run(), "ok");
  } finally {
    removeDir(dir);
  }
});

test("launch environments with API-key, endpoint, or proxy variables are refused", () => {
  assert.ok(assertNoProhibitedEnv({ PATH: "/usr/bin" }).ok);
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "HTTPS_PROXY", "CLAUDE_CODE_USE_BEDROCK"]) {
    const r = assertNoProhibitedEnv({ PATH: "/usr/bin", [name]: "x" });
    assert.equal(r.ok ? "ok" : r.blocker.code, "CUSTOM_ENDPOINT_PROHIBITED");
  }
});
