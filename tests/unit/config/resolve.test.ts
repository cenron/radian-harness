import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { selectProfile } from "../../../src/config/dispatch.ts";
import { loadAndResolve, resolveConfig, shippedConfigDir, type ConfigLayer } from "../../../src/config/resolve.ts";
import { removeDir, tempDir } from "../helpers/fixture.ts";

const OPENAI_MODEL = "gpt-test-1";
const CLAUDE_MODEL = "claude-test-model-1";

function shipped(): ConfigLayer {
  const result = loadAndResolve({});
  assert.ok(result.ok, "shipped configuration must validate");
  if (!result.ok) throw new Error("unreachable");
  return { layer: "shipped", label: "shipped", harness: result.value.harness, dispatch: result.value.dispatch };
}

test("shipped defaults: three workers, 30 minutes, three rounds, one recovery, fail-closed", () => {
  const result = loadAndResolve({});
  assert.ok(result.ok);
  if (!result.ok) return;
  const { harness, dispatch } = result.value;
  assert.equal(harness.concurrency.maxActiveWorkers, 3);
  assert.equal(harness.assignment.executionLimitMinutes, 30);
  assert.equal(harness.assignment.candidateRounds, 3);
  assert.equal(harness.assignment.automaticRecoveries, 1);
  assert.equal(harness.execution.unverifiedCapabilities, "deny");
  assert.equal(dispatch.default, "developer-standard");
  assert.equal(dispatch.profiles["pi-default"]?.runtime, "pi");
  assert.equal(dispatch.profiles["claude-code"]?.provider, "anthropic");
  assert.equal(dispatch.selection.onUnavailable, "block");
  for (const profile of Object.values(dispatch.profiles)) {
    assert.ok(profile.model, "user-confirmed exact models are configured");
    assert.equal(profile.provider, profile.runtime === "claude-code" ? "anthropic" : "openai");
  }
  assert.ok(shippedConfigDir().endsWith("config"));
});

test("shipped default selects standard development without enabling capabilities", () => {
  const result = loadAndResolve({});
  assert.ok(result.ok);
  if (!result.ok) return;
  const selection = selectProfile(result.value.dispatch, { role: "developer" });
  assert.ok(selection.ok);
  if (selection.ok) {
    assert.equal(selection.value.profile.name, "developer-standard");
    assert.equal(selection.value.profile.model, "gpt-6.1-sol");
    assert.equal(selection.value.profile.runtime, "pi");
    assert.equal(selection.value.profile.effort, "medium");
  }
  assert.equal(result.value.harness.execution.unverifiedCapabilities, "deny");
});

test("shipped role/task rules resolve exact profiles with explicit coordinator choices", () => {
  const result = loadAndResolve({});
  assert.ok(result.ok);
  if (!result.ok) return;
  const cases = [
    ["scout", "scouting", "scout-fast", "gpt-6-luna", "pi", "low"],
    ["tester", "mechanical-testing", "tester-fast", "gpt-6-luna", "pi", "low"],
    ["tester", "test-analysis", "tester-analysis", "gpt-6.1-sol", "pi", "medium"],
    ["tester", "test-analysis", "tester-analysis-codex", "gpt-6.1-sol", "codex", "medium"],
    ["developer", "development", "developer-standard", "gpt-6.1-sol", "pi", "medium"],
    ["developer", "development", "developer-codex", "gpt-6.1-sol", "codex", "medium"],
    ["reviewer", "ordinary-review", "reviewer-standard", "claude-sonnet-5-5", "claude-code", "medium"],
    ["reviewer", "safety-review", "safety-review", "claude-opus-5-5", "claude-code", "high"],
  ] as const;
  for (const [role, id, profile, model, runtime, effort] of cases) {
    const selected = selectProfile(result.value.dispatch, { role, rule: { id, profile, rationale: "approved assignment classification" } });
    assert.ok(selected.ok, `${id}/${profile}`);
    if (!selected.ok) continue;
    assert.equal(selected.value.source, "rule");
    assert.equal(selected.value.ruleId, id);
    assert.equal(selected.value.profile.model, model);
    assert.equal(selected.value.profile.runtime, runtime);
    assert.equal(selected.value.profile.effort, effort);
  }
  // Conditions are coordinator guidance, not automatic classification.
  const noChoice = selectProfile(result.value.dispatch, { role: "tester" });
  assert.ok(noChoice.ok && noChoice.value.source === "default" && noChoice.value.profile.name === "developer-standard");
  const wrongRole = selectProfile(result.value.dispatch, { role: "developer", rule: { id: "safety-review", profile: "safety-review", rationale: "x" } });
  assert.equal(wrongRole.ok ? "ok" : wrongRole.blocker.code, "PROFILE_NOT_IN_CANDIDATES");
});

test("rejected shipped selection never falls back to another model or runtime", () => {
  const result = resolveConfig([shipped(), { layer: "project", label: "project", dispatch: { profiles: { "tester-fast": { provider: "anthropic", model: "claude-sonnet-5-5" } } } }]);
  assert.ok(result.ok);
  if (!result.ok) return;
  const selected = selectProfile(result.value.dispatch, { role: "tester", rule: { id: "mechanical-testing", profile: "tester-fast", rationale: "prescribed checks" } });
  assert.equal(selected.ok ? "ok" : selected.blocker.code, "ANTHROPIC_REQUIRES_CLAUDE_CODE");
});

test("precedence: shipped → workspace → project, with provenance and snapshot hash", () => {
  const base = shipped();
  const workspace: ConfigLayer = {
    layer: "workspace",
    label: "workspace",
    harness: { concurrency: { maxActiveWorkers: 5 } },
    dispatch: { default: "pi-default", profiles: { "pi-default": { provider: "openai", model: OPENAI_MODEL } } },
  };
  const project: ConfigLayer = { layer: "project", label: "project", harness: { concurrency: { maxActiveWorkers: 2 } } };
  const result = resolveConfig([base, workspace, project]);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.harness.concurrency.maxActiveWorkers, 2);
  assert.equal(result.value.provenance["harness.concurrency.maxActiveWorkers"], "project");
  assert.equal(result.value.provenance["dispatch.profiles.pi-default.model"], "workspace");
  assert.equal(result.value.provenance["harness.assignment.executionLimitMinutes"], "shipped");
  assert.match(result.value.hash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(result.value.harness));
  const again = resolveConfig([base, workspace, project]);
  assert.ok(again.ok && again.value.hash === result.value.hash, "resolution is deterministic");
  const selection = selectProfile(result.value.dispatch, { role: "developer" });
  assert.ok(selection.ok);
  if (selection.ok) {
    assert.equal(selection.value.source, "default");
    assert.equal(selection.value.profile.model, OPENAI_MODEL);
  }
});

test("overrides cannot exceed product invariants or weaken fail-closed policy", () => {
  const base = shipped();
  const cases: unknown[] = [
    { assignment: { candidateRounds: 4 } },
    { assignment: { automaticRecoveries: 2 } },
    { execution: { unverifiedCapabilities: "allow" } },
    { execution: { blanketPermissionBypass: true } },
    { concurrency: { maxActiveWorkers: 0 } },
    { surprise: true },
  ];
  for (const harness of cases) {
    const result = resolveConfig([base, { layer: "project", label: "project", harness }]);
    assert.equal(result.ok ? "ok" : result.blocker.code, "CONFIG_INVALID", JSON.stringify(harness));
  }
});

test("layer order is enforced", () => {
  const base = shipped();
  const result = resolveConfig([base, { layer: "project", label: "p" }, { layer: "workspace", label: "w" }]);
  assert.equal(result.ok ? "ok" : result.blocker.code, "CONFIG_INVALID");
  assert.equal((() => { const r = resolveConfig([{ layer: "workspace", label: "w" }]); return r.ok ? "ok" : r.blocker.code; })(), "CONFIG_INVALID");
});

test("custom endpoint fields in overrides are refused specifically", () => {
  const base = shipped();
  const result = resolveConfig([base, { layer: "workspace", label: "w", dispatch: { profiles: { "pi-default": { baseUrl: "x" } } } }]);
  assert.equal(result.ok ? "ok" : result.blocker.code, "CUSTOM_ENDPOINT_PROHIBITED");
});

test("an override that moves an Anthropic model to Pi is rejected at selection, never rerouted", () => {
  const base = shipped();
  const project: ConfigLayer = {
    layer: "project",
    label: "project",
    dispatch: {
      default: "pi-default",
      profiles: {
        "pi-default": { provider: "anthropic", model: CLAUDE_MODEL },
        "claude-code": { model: CLAUDE_MODEL },
      },
      rules: [{ id: "review", roles: ["reviewer"], when: "reviews", use: ["claude-code"], why: "independent review" }],
    },
  };
  const result = resolveConfig([base, project]);
  assert.ok(result.ok);
  if (!result.ok) return;
  const selection = selectProfile(result.value.dispatch, { role: "developer" });
  assert.equal(selection.ok ? "ok" : selection.blocker.code, "ANTHROPIC_REQUIRES_CLAUDE_CODE");
  const review = selectProfile(result.value.dispatch, { role: "reviewer", rule: { id: "review", profile: "claude-code", rationale: "configured reviewer" } });
  assert.ok(review.ok);
  if (review.ok) {
    assert.equal(review.value.profile.runtime, "claude-code");
    assert.equal(review.value.ruleId, "review");
  }
  const outside = selectProfile(result.value.dispatch, { role: "reviewer", rule: { id: "review", profile: "pi-default", rationale: "x" } });
  assert.equal(outside.ok ? "ok" : outside.blocker.code, "PROFILE_NOT_IN_CANDIDATES");
  const wrongRole = selectProfile(result.value.dispatch, { role: "developer", rule: { id: "review", profile: "claude-code", rationale: "x" } });
  assert.equal(wrongRole.ok ? "ok" : wrongRole.blocker.code, "PROFILE_NOT_IN_CANDIDATES");
});

test("rule references and defaults must name defined profiles", () => {
  const base = shipped();
  const bad = resolveConfig([base, { layer: "project", label: "p", dispatch: { rules: [{ id: "x", roles: ["developer"], when: "w", use: ["nope"], why: "y" }] } }]);
  assert.equal(bad.ok ? "ok" : bad.blocker.code, "CONFIG_INVALID");
  const noFallback = resolveConfig([base, { layer: "project", label: "p", dispatch: { selection: { onUnavailable: "fallback" } } }]);
  assert.equal(noFallback.ok ? "ok" : noFallback.blocker.code, "CONFIG_INVALID");
});

test("override files load from .radian/config and malformed JSON is a blocker", () => {
  const workspace = tempDir();
  const project = tempDir();
  try {
    mkdirSync(path.join(workspace, ".radian", "config"), { recursive: true });
    writeFileSync(path.join(workspace, ".radian", "config", "harness.json"), JSON.stringify({ concurrency: { maxActiveWorkers: 4 } }));
    const ok = loadAndResolve({ workspaceRoot: workspace, projectRoot: project });
    assert.ok(ok.ok && ok.value.harness.concurrency.maxActiveWorkers === 4);
    mkdirSync(path.join(project, ".radian", "config"), { recursive: true });
    writeFileSync(path.join(project, ".radian", "config", "dispatch.json"), "{ nope");
    const bad = loadAndResolve({ workspaceRoot: workspace, projectRoot: project });
    assert.equal(bad.ok ? "ok" : bad.blocker.code, "CONFIG_INVALID");
  } finally {
    removeDir(workspace);
    removeDir(project);
  }
});
