import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../helpers/git-fixtures.ts";
import { loadConfig } from "#core/config.ts";
import { writeJsonFile } from "#core/utils/json.ts";

const harnessJson = { version: 1, maxWorkers: 3, startMode: "plan", calm: false, pollSeconds: 3 };
const dispatchJson = {
  version: 1,
  roles: { developer: "dev", tester: "dev", reviewer: "dev", scout: "dev" },
  profiles: {
    dev: { runtime: "claude", model: "claude-sonnet-5-5", effort: "medium", description: "d" },
    "dev-pi": { runtime: "pi", provider: "openai", model: "gpt-6.1-sol", effort: "low" },
  },
};

function setup(overrides: { harness?: unknown; dispatch?: unknown } = {}) {
  const harnessRoot = makeTempDir();
  const workspaceRoot = makeTempDir();
  writeJsonFile(path.join(harnessRoot, "config", "harness.json"), harnessJson);
  writeJsonFile(path.join(harnessRoot, "config", "dispatch.json"), dispatchJson);
  if (overrides.harness) {
    writeJsonFile(path.join(workspaceRoot, ".radian", "config", "harness.json"), overrides.harness);
  }
  if (overrides.dispatch) {
    writeJsonFile(
      path.join(workspaceRoot, ".radian", "config", "dispatch.json"),
      overrides.dispatch,
    );
  }
  return { harnessRoot, workspaceRoot };
}

test("loadConfig reads the shipped configuration and names each profile", () => {
  const config = loadConfig(setup());
  assert.equal(config.harness.maxWorkers, 3);
  assert.equal(config.harness.startMode, "plan");
  assert.equal(config.harness.autoMergeSeconds, 0, "auto-merge is off unless configured");
  assert.equal(config.dispatch.roles.scout, "dev");
  assert.deepEqual(config.dispatch.profiles["dev-pi"], {
    name: "dev-pi",
    runtime: "pi",
    provider: "openai",
    model: "gpt-6.1-sol",
    effort: "low",
  });
});

test("workspace files override harness settings, roles, and profiles", () => {
  const config = loadConfig(
    setup({
      harness: { maxWorkers: 5, autoMergeSeconds: 60 },
      dispatch: {
        roles: { scout: "fast" },
        profiles: { fast: { runtime: "claude", model: "claude-haiku-4-5", effort: "low" } },
      },
    }),
  );
  assert.equal(config.harness.maxWorkers, 5);
  assert.equal(config.harness.pollSeconds, 3);
  assert.equal(config.harness.autoMergeSeconds, 60);
  assert.equal(config.dispatch.roles.scout, "fast");
  assert.equal(config.dispatch.roles.developer, "dev");
  assert.ok(config.dispatch.profiles.dev);
});

test("invalid harness values are rejected with the file name", () => {
  assert.throws(
    () => loadConfig(setup({ harness: { maxWorkers: 0 } })),
    /harness\.json.*maxWorkers/,
  );
  assert.throws(() => loadConfig(setup({ harness: { startMode: "ship" } })), /startMode/);
  assert.throws(() => loadConfig(setup({ harness: { autoMergeSeconds: -5 } })), /autoMergeSeconds/);
});

test("profiles with unknown keys, bad runtimes, or Anthropic models off Claude Code are rejected", () => {
  const profile = (value: unknown) => setup({ dispatch: { profiles: { bad: value } } });
  assert.throws(
    () =>
      loadConfig(
        profile({ runtime: "claude", model: "claude-x", effort: "low", baseUrl: "http://x" }),
      ),
    /unknown key "baseUrl"/,
  );
  assert.throws(
    () => loadConfig(profile({ runtime: "gemini", model: "m", effort: "low" })),
    /runtime/,
  );
  assert.throws(
    () => loadConfig(profile({ runtime: "codex", model: "claude-opus-5-5", effort: "low" })),
    /Anthropic models run only on Claude Code/,
  );
});

test("a role must point at a known profile", () => {
  assert.throws(
    () => loadConfig(setup({ dispatch: { roles: { tester: "missing" } } })),
    /role tester uses unknown profile "missing"/,
  );
});
