// Package/export manifest review, separate from file-content scans. The file
// list comes from `npm pack --dry-run --json --ignore-scripts`, so no package
// lifecycle script executes and no archive is written or published.

import path from "node:path";
import { readFileSync } from "node:fs";
import { resolveExecutable, run, succeeded, describeFailure } from "../util/proc.ts";
import type { ScanContext, SourceReport } from "./scanner.ts";
import { scanContent } from "./scanner.ts";
import { ALLOWANCES_PATH, parseAllowances } from "./allowances.ts";

/** Paths that must never appear in a package or export, whatever `files` says. */
export const FORBIDDEN_PACKAGE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["environment file", /(^|\/)\.env(\.|$)/],
  ["dependency tree", /(^|\/)node_modules\//],
  ["private run state", /(^|\/)\.radian(-scratch)?\//],
  ["credential material", /(^|\/)(auth|credentials?|\.credentials)\.json$/i],
  ["key material", /\.(pem|key|p12|pfx)$/i],
  ["private denylist data", /(^|\/)[^/]*denylist[^/]*\.(txt|lst|list|json|ya?ml)$/i],
  ["Finder metadata", /(^|\/)\.DS_Store$/],
  ["test fixtures and feasibility probes", /^tests\//],
  ["planning and research records", /^docs\/(planning|research|proposals)\//],
  ["archives", /\.(tgz|tar|zip)$/i],
];

/** Top-level roots the package may contain; anything else is reported. */
export const PACKAGE_CONTENT_ALLOWLIST: readonly RegExp[] = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE(\.md)?$/,
  /^NOTICE(\.md)?$/,
  /^config\//,
  /^src\//,
  /^extensions\//,
  /^workers\//,
  /^skills\//,
  /^prompts\//,
  /^docs\/user\//,
];

export function classifyPackagePath(file: string): string | undefined {
  for (const [label, pattern] of FORBIDDEN_PACKAGE_PATTERNS) if (pattern.test(file)) return `forbidden: ${label}`;
  if (!PACKAGE_CONTENT_ALLOWLIST.some((pattern) => pattern.test(file))) return "outside package-content allowlist";
  return undefined;
}

export function parsePackList(stdout: string): string[] {
  const data = JSON.parse(stdout) as Array<{ files?: Array<{ path?: unknown }> }>;
  const first = data[0];
  if (!first || !Array.isArray(first.files)) throw new Error("unexpected npm pack output");
  return first.files.map((entry) => {
    if (typeof entry.path !== "string") throw new Error("unexpected npm pack entry");
    return entry.path;
  });
}

export async function listPackageFiles(repoRoot: string): Promise<string[]> {
  const npm = resolveExecutable("npm", process.env.PATH);
  if (!npm) throw new Error("npm not found on PATH");
  const result = await run(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/nonexistent-radian-home",
      npm_config_ignore_scripts: "true",
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
    },
    timeoutMs: 60_000,
  });
  if (!succeeded(result)) throw new Error(`npm pack --dry-run failed: ${describeFailure(result)}`);
  return parsePackList(result.stdout.toString("utf8"));
}

export async function scanPackage(repoRoot: string, scan: Omit<ScanContext, "allowances">): Promise<SourceReport> {
  const report: SourceReport = { source: "package", label: "package manifest (npm pack --dry-run)", scanned: 0, findings: [], excluded: [], errors: [] };
  let files: string[];
  try {
    files = await listPackageFiles(repoRoot);
  } catch (error) {
    report.errors.push({ source: "package", path: "(package list)", reason: (error as Error).message });
    return report;
  }
  let allowances: ScanContext["allowances"] = [];
  try {
    const parsed = parseAllowances(readFileSync(path.join(repoRoot, ALLOWANCES_PATH), "utf8"));
    if (parsed.ok) allowances = parsed.allowances;
    else report.errors.push({ source: "package", path: ALLOWANCES_PATH, reason: parsed.reason });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") report.errors.push({ source: "package", path: ALLOWANCES_PATH, reason: "unreadable" });
  }
  for (const file of files.sort()) {
    const problem = classifyPackagePath(file);
    if (problem) {
      report.errors.push({ source: "package", path: file, reason: problem });
      continue;
    }
    try {
      scanContent(report, file, readFileSync(path.join(repoRoot, file)), { ...scan, allowances });
    } catch {
      report.errors.push({ source: "package", path: file, reason: "unreadable" });
    }
  }
  return report;
}
