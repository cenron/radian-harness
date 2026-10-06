// Publication check command. Exit codes: 0 = every selected input scanned with no
// findings; 1 = findings; 2 = incomplete scan or error (never reported as clean).

import { realpathSync } from "node:fs";
import { type GitContext, git, gitText, locateGit } from "../git/exec.ts";
import { succeeded } from "../util/proc.ts";
import { loadDenylist, type DenylistStatus } from "./denylist.ts";
import { scanPackage } from "./package.ts";
import {
  DEFAULT_MAX_FILE_BYTES,
  type SourceReport,
  scanMetadata,
  scanStaged,
  scanTree,
  scanWorktree,
} from "./scanner.ts";

export interface CliOptions {
  repo?: string;
  staged: boolean;
  worktree: boolean;
  trees: string[];
  metadata: string[];
  package: boolean;
  whitespace: boolean;
  denylist?: string;
  requireDenylist: boolean;
  ci: boolean;
  prePush: boolean;
  bounded: string;
}

export interface WhitespaceReport {
  label: string;
  locations: string[];
  error?: string;
}

export interface CheckOutcome {
  exitCode: 0 | 1 | 2;
  lines: string[];
}

export function parseArgs(argv: readonly string[]): CliOptions | { error: string } {
  const options: CliOptions = {
    staged: false,
    worktree: false,
    trees: [],
    metadata: [],
    package: false,
    whitespace: false,
    requireDenylist: false,
    ci: false,
    prePush: false,
    bounded: "unknown",
  };
  let selected = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string | undefined => argv[++i];
    switch (arg) {
      case "--staged": options.staged = true; selected = true; break;
      case "--worktree": options.worktree = true; selected = true; break;
      case "--package": options.package = true; selected = true; break;
      case "--whitespace": options.whitespace = true; selected = true; break;
      case "--tree": { const v = value(); if (!v) return { error: "--tree needs a revision" }; options.trees.push(v); selected = true; break; }
      case "--metadata": { const v = value(); if (!v) return { error: "--metadata needs a revision range" }; options.metadata.push(v); selected = true; break; }
      case "--repo": { const v = value(); if (!v) return { error: "--repo needs a path" }; options.repo = v; break; }
      case "--denylist": { const v = value(); if (!v) return { error: "--denylist needs a path" }; options.denylist = v; break; }
      case "--require-denylist": options.requireDenylist = true; break;
      case "--ci": options.ci = true; break;
      case "--pre-push": options.prePush = true; selected = true; break;
      case "--bounded-state": { const v = value(); options.bounded = v ?? "unknown"; break; }
      default: return { error: `unknown argument: ${arg}` };
    }
  }
  if (!selected) {
    options.staged = true;
    options.worktree = true;
    options.trees.push("HEAD");
    options.package = true;
    options.whitespace = true;
    options.metadata.push("@{upstream}..HEAD");
  }
  return options;
}

/** Keep only `path:line:` locations from `git diff --check`; drop echoed content. */
export function whitespaceLocations(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => /^[^+\-\s].*:\d+: /.test(line))
    .map((line) => line.replace(/:\s.*$/, "").trim())
    .filter((line, index, all) => all.indexOf(line) === index);
}

async function whitespace(ctx: GitContext, label: string, args: string[]): Promise<WhitespaceReport> {
  const result = await git(ctx, ["diff", "--no-ext-diff", "--no-textconv", "--check", ...args]);
  if (result.code === 0) return { label, locations: [] };
  if (result.code === 2 || result.code === 1) {
    const locations = whitespaceLocations(result.stdout.toString("utf8"));
    if (locations.length > 0) return { label, locations };
  }
  return { label, locations: [], error: "git diff --check failed" };
}

async function hasUpstream(ctx: GitContext): Promise<boolean> {
  return succeeded(await git(ctx, ["rev-parse", "--verify", "--quiet", "@{upstream}"]));
}

export interface PrePushRef {
  localSha: string;
  remoteSha: string;
}

export function parsePrePushInput(text: string): PrePushRef[] {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 4)
    .map(([, localSha = "", , remoteSha = ""]) => ({ localSha, remoteSha }))
    .filter((ref) => !/^0+$/.test(ref.localSha));
}

function denylistLine(status: DenylistStatus): string {
  switch (status.state) {
    case "absent": return "private denylist: NOT SUPPLIED — private-term coverage is absent (this is not a clean private scan)";
    case "loaded": return `private denylist: loaded (${status.termCount} term(s); values never printed)`;
    case "error": return `private denylist: ERROR — ${status.reason}`;
  }
}

export function formatReport(report: SourceReport, ci: boolean): string[] {
  const lines = [
    `[${report.source}] ${report.label}: ${report.scanned} scanned, ${report.findings.length} finding(s), ${report.excluded.length} excluded, ${report.errors.length} error(s)`,
  ];
  for (const f of report.findings) {
    const where = f.line > 0 ? `${f.path}:${f.line}:${f.column}` : f.path;
    const print = !ci && f.fingerprint ? ` ${f.fingerprint}` : "";
    lines.push(`  FINDING ${f.rule} (${f.kind}) ${where}${print}`);
  }
  for (const e of report.excluded) lines.push(`  excluded ${e.path}: ${e.reason}`);
  for (const e of report.errors) lines.push(`  ERROR ${e.path}: ${e.reason}`);
  return lines;
}

export async function runCheck(options: CliOptions, prePushInput = ""): Promise<CheckOutcome> {
  const lines: string[] = [];
  const gitPath = locateGit();
  if (!gitPath) return { exitCode: 2, lines: ["ERROR git executable not found"] };
  const start: GitContext = { gitPath, cwd: options.repo ?? process.cwd() };
  let repoRoot: string;
  try {
    repoRoot = realpathSync(await gitText(start, ["rev-parse", "--show-toplevel"]));
  } catch {
    return { exitCode: 2, lines: ["ERROR not inside a Git working tree"] };
  }
  const ctx: GitContext = { gitPath, cwd: repoRoot };
  const denylist = loadDenylist(options.denylist, repoRoot);
  const scan = { denylistTerms: denylist.terms, maxFileBytes: DEFAULT_MAX_FILE_BYTES };
  let incomplete = denylist.status.state === "error" || (options.requireDenylist && denylist.status.state !== "loaded");

  const reports: SourceReport[] = [];
  const whitespaceReports: WhitespaceReport[] = [];

  if (options.prePush) {
    for (const ref of parsePrePushInput(prePushInput)) {
      reports.push(await scanTree(ctx, ref.localSha, scan));
      const range = /^0+$/.test(ref.remoteSha) ? [ref.localSha, "--not", "--remotes"] : [`${ref.remoteSha}..${ref.localSha}`];
      reports.push(await scanMetadata(ctx, range, scan));
    }
  }
  if (options.staged) reports.push(await scanStaged(ctx, scan));
  if (options.worktree) reports.push(await scanWorktree(ctx, repoRoot, scan));
  for (const tree of options.trees) reports.push(await scanTree(ctx, tree, scan));
  for (const range of options.metadata) {
    if (range.includes("@{upstream}") && !(await hasUpstream(ctx))) {
      lines.push(`[metadata] ${range}: no upstream configured; scanning all commits reachable from HEAD`);
      reports.push(await scanMetadata(ctx, "HEAD", scan));
    } else {
      reports.push(await scanMetadata(ctx, range, scan));
    }
  }
  if (options.package) reports.push(await scanPackage(repoRoot, scan));
  if (options.whitespace) {
    whitespaceReports.push(await whitespace(ctx, "staged changes", ["--cached"]));
    whitespaceReports.push(await whitespace(ctx, "unstaged changes", []));
    if (await hasUpstream(ctx)) whitespaceReports.push(await whitespace(ctx, "unpushed commits", ["@{upstream}", "HEAD"]));
  }

  let findings = 0;
  lines.push(`publication check — scanner execution boundary: ${options.bounded}`);
  lines.push(denylistLine(denylist.status));
  if (options.requireDenylist && denylist.status.state !== "loaded") lines.push("ERROR --require-denylist was given but no denylist was loaded");
  for (const report of reports) {
    lines.push(...formatReport(report, options.ci));
    findings += report.findings.length;
    if (report.errors.length > 0) incomplete = true;
  }
  for (const ws of whitespaceReports) {
    lines.push(`[whitespace] ${ws.label}: ${ws.error ? "ERROR " + ws.error : ws.locations.length + " issue(s)"}`);
    for (const location of ws.locations) lines.push(`  FINDING RH-WHITESPACE ${location}`);
    findings += ws.locations.length;
    if (ws.error) incomplete = true;
  }
  lines.push(
    "coverage limits: text patterns only; binary/ignored content, semantic review of images, every secret format, and Git history beyond the selected range are not covered.",
  );
  const exitCode = incomplete ? 2 : findings > 0 ? 1 : 0;
  lines.push(exitCode === 0 ? "RESULT clean for covered generic patterns" : exitCode === 1 ? `RESULT ${findings} finding(s)` : "RESULT INCOMPLETE — scan errors present; not a clean result");
  return { exitCode, lines };
}
