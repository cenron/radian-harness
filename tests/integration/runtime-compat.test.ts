// Checks that each installed runtime CLI still documents every flag and value Radian passes.
// Reads `--help` only; no model or provider is contacted. A runtime that is not installed is skipped.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import type { Profile, Runtime } from "../../src/core/profiles.ts";
import { runtimeArgs } from "../../src/core/runtime-args.ts";

const PROFILES: Record<Runtime, Profile> = {
  claude: { name: "c", runtime: "claude", model: "claude-sonnet-5-5", effort: "medium" },
  codex: { name: "x", runtime: "codex", model: "gpt-6.1-sol", effort: "medium" },
  pi: { name: "p", runtime: "pi", provider: "openai", model: "gpt-6.1-sol", effort: "medium" },
};

/** Values Radian passes that the help text lists as choices. */
const DOCUMENTED_VALUES: Record<Runtime, string[]> = {
  claude: ["dontAsk"],
  codex: ["workspace-write", "never"],
  pi: ["medium"],
};

for (const runtime of Object.keys(PROFILES) as Runtime[]) {
  const help = readHelp(runtime);
  test(
    `${runtime} accepts every flag Radian passes`,
    { skip: help ? false : `${runtime} is not installed` },
    () => {
      const args = runtimeArgs({
        profile: PROFILES[runtime],
        role: "developer",
        workerDir: "/w",
        gitCommonDir: "/g",
      });
      for (const flag of args.filter((arg) => arg.startsWith("-"))) {
        assert.ok(
          new RegExp(`(^|[\\s,])${flag}\\b`).test(help ?? ""),
          `${runtime} --help lacks ${flag}`,
        );
      }
      for (const value of DOCUMENTED_VALUES[runtime])
        assert.ok(help?.includes(value), `${runtime} --help lacks ${value}`);
    },
  );
}

function readHelp(runtime: Runtime): string | undefined {
  try {
    return execFileSync(runtime, ["--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
  } catch (_error) {
    return undefined;
  }
}
