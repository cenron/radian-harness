// Final verification runner. Runs every documented automated check and prints a
// sanitized summary (no absolute paths, credentials, or raw logs). Skips are
// reported as skips, never as passes. Optional `--out <file>` writes the
// summary JSON to a private location outside the repository.
//
// Steps: tool versions, type check, unit tests, integration (offline runtime
// compatibility) tests, publication checks over the working tree, staged
// content, committed tree, full commit metadata, package manifest and
// whitespace, a package archive built into private scratch and inspected, and
// the preserved offline feasibility suites (default modes only; the opt-in live
// and real-auth modes are never invoked).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPackagePath } from "../src/publication/package.ts";
import { resolveExecutable } from "../src/util/proc.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface StepResult {
  id: string;
  outcome: "passed" | "failed" | "skipped" | "not-run";
  exitCode: number | null;
  detail: string;
}

function sanitize(text: string): string {
  return text.replaceAll(ROOT, "<repo>").replaceAll(os.homedir(), "~").replace(/\/(private\/)?var\/folders\/[^\s"']+/g, "<tmp>").replace(/\/tmp\/[^\s"']+/g, "<tmp>");
}

function run(argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd: options.cwd ?? ROOT, env: options.env ?? process.env, encoding: "utf8", timeout: options.timeoutMs ?? 900_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function testSummary(output: string): string {
  const pick = (name: string) => new RegExp(`ℹ ${name} (\\d+)`).exec(output)?.[1] ?? "?";
  return `tests ${pick("tests")}, pass ${pick("pass")}, fail ${pick("fail")}, skipped ${pick("skipped")}, cancelled ${pick("cancelled")}`;
}

const results: StepResult[] = [];
const versions: Record<string, string> = {};
const version = (label: string, argv: string[]) => {
  const exe = resolveExecutable(argv[0]!, process.env.PATH);
  if (!exe) {
    versions[label] = "not installed";
    return;
  }
  const out = run([exe, ...argv.slice(1)], { timeoutMs: 30_000 });
  versions[label] = sanitize((out.stdout || out.stderr).trim().split("\n")[0] ?? "unknown");
};
version("node", ["node", "--version"]);
version("git", ["git", "--version"]);
version("pi", ["pi", "--version"]);
version("codex", ["codex", "--version"]);
version("claude", ["claude", "--version"]);
version("herdr", ["herdr", "--version"]);
version("macOS", ["sw_vers", "-productVersion"]);
const head = run(["git", "rev-parse", "HEAD"]).stdout.trim();
const dirty = run(["git", "status", "--porcelain"]).stdout.trim().length > 0;

const tsc = path.join(ROOT, "node_modules", ".bin", "tsc");
const typecheck = run([tsc, "-p", "tsconfig.json"]);
results.push({ id: "typecheck", outcome: typecheck.status === 0 ? "passed" : "failed", exitCode: typecheck.status, detail: typecheck.status === 0 ? "tsc --noEmit clean" : sanitize(typecheck.stdout).slice(0, 2000) });

for (const [id, pattern] of [["unit-tests", "tests/unit/**/*.test.ts"], ["integration-tests", "tests/integration/**/*.test.ts"]] as const) {
  const out = run([process.execPath, "--test", pattern]);
  const summary = testSummary(out.stdout);
  const failed = out.status !== 0;
  const skippedOnly = /skipped [1-9]/.test(summary) && /pass 0/.test(summary);
  results.push({ id, outcome: failed ? "failed" : skippedOnly ? "skipped" : "passed", exitCode: out.status, detail: summary + (failed ? `\n${sanitize(out.stdout.split("\n").filter((l) => l.startsWith("✖") || l.includes("AssertionError")).join("\n")).slice(0, 3000)}` : "") });
}

const publication = run([process.execPath, path.join(ROOT, "scripts", "publication-check.ts"), "--staged", "--worktree", "--tree", "HEAD", "--metadata", "HEAD", "--package", "--whitespace"]);
results.push({ id: "publication-check", outcome: publication.status === 0 ? "passed" : "failed", exitCode: publication.status, detail: sanitize(publication.stdout.split("\n").filter((l) => /^\[|RESULT|private denylist|FINDING|ERROR/.test(l)).join("\n")) });

// Package archive: build into private scratch with lifecycle scripts disabled, then inspect the actual bytes.
const scratch = mkdtempSync(path.join(os.tmpdir(), "radian-verify-"));
try {
  const npm = resolveExecutable("npm", process.env.PATH);
  const packed = npm ? run([npm, "pack", "--ignore-scripts", "--json", "--pack-destination", scratch]) : undefined;
  if (!packed || packed.status !== 0) {
    results.push({ id: "package-archive", outcome: "failed", exitCode: packed?.status ?? null, detail: "npm pack failed" });
  } else {
    const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename;
    const listing = run(["/usr/bin/tar", "-tzf", path.join(scratch, path.basename(filename))]);
    const files = listing.stdout.split("\n").filter(Boolean).map((f) => f.replace(/^package\//, ""));
    const problems = files.map((f) => [f, classifyPackagePath(f)] as const).filter(([, p]) => p !== undefined);
    results.push({ id: "package-archive", outcome: problems.length === 0 && listing.status === 0 ? "passed" : "failed", exitCode: listing.status, detail: `${files.length} file(s) in archive; ${problems.length} outside the package-content boundary${problems.length ? `: ${problems.map(([f, p]) => `${f} (${p})`).join(", ")}` : ""}` });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const suites: Array<[string, string[]]> = [
  ["feasibility-filesystem", ["bash", "tests/feasibility/macos-filesystem.sh"]],
  ["feasibility-runtime-startup", ["python3", "tests/feasibility/macos-runtime-startup.py"]],
  ["feasibility-network-loopback", ["python3", "tests/feasibility/macos-network.py"]],
  ["feasibility-processes", ["python3", "tests/feasibility/macos-processes.py"]],
  ["feasibility-supervision", ["python3", "tests/feasibility/macos-supervision.py"]],
  ["feasibility-pi-auth-store", ["python3", "tests/feasibility/macos-pi-auth-store.py"]],
];
const skipFeasibility = process.argv.includes("--skip-feasibility");
for (const [id, argv] of suites) {
  if (skipFeasibility) {
    results.push({ id, outcome: "not-run", exitCode: null, detail: "skipped by --skip-feasibility" });
    continue;
  }
  const out = run(argv, { timeoutMs: 600_000 });
  const lines = (out.stdout + out.stderr).split("\n").filter((l) => /^(PASS|FAIL|SKIP|ok|not ok)|passed|failed/i.test(l.trim()));
  results.push({ id, outcome: out.status === 0 ? "passed" : out.status === 77 ? "skipped" : "failed", exitCode: out.status, detail: sanitize(`${lines.length} result line(s); ${lines.filter((l) => /^PASS/i.test(l.trim())).length} PASS`) });
}

const summary = { schema: "radian.verification/1", revision: head, workingTreeDirty: dirty, versions, results };
const outIndex = process.argv.indexOf("--out");
if (outIndex !== -1 && process.argv[outIndex + 1]) writeFileSync(process.argv[outIndex + 1]!, JSON.stringify(summary, null, 2));
process.stdout.write(`Radian verification at ${head.slice(0, 12)}${dirty ? " (working tree has uncommitted changes)" : ""}\n`);
for (const [k, v] of Object.entries(versions)) process.stdout.write(`  ${k}: ${v}\n`);
for (const r of results) process.stdout.write(`${r.outcome.toUpperCase().padEnd(8)} ${r.id} (exit ${r.exitCode}) — ${r.detail.split("\n")[0]}\n`);
process.exitCode = results.some((r) => r.outcome === "failed") ? 1 : 0;
