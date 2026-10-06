// Publication scanner core: scans text from an explicit content source
// (working tree, Git index, or committed tree) and commit metadata. Findings are
// redacted: they carry a location, rule ID, and optional fingerprint, never the
// matched value.

import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { type GitContext, gitOk, splitNul } from "../git/exec.ts";
import { ALLOWANCES_PATH, type Allowance, fingerprint, isAllowed, parseAllowances } from "./allowances.ts";
import { scanDenylist } from "./denylist.ts";
import { GENERIC_RULES, isNeutralEmail, type RuleId, type RuleMatch } from "./rules.ts";

export type SourceKind = "worktree" | "staged" | "tree" | "metadata" | "package";

export interface Finding {
  source: SourceKind;
  path: string;
  line: number;
  column: number;
  rule: RuleId;
  kind: string;
  /** Present only for generic rules; private-term matches are never fingerprinted. */
  fingerprint?: string;
}

export interface ScanIssue {
  source: SourceKind;
  path: string;
  reason: string;
}

export interface SourceReport {
  source: SourceKind;
  label: string;
  scanned: number;
  findings: Finding[];
  /** Files excluded by policy (binary content, submodules). Reported, not hidden. */
  excluded: ScanIssue[];
  /** Inputs that could not be scanned. Any error makes the scan incomplete. */
  errors: ScanIssue[];
}

export interface ScanContext {
  denylistTerms: readonly string[];
  allowances: readonly Allowance[];
  maxFileBytes: number;
}

export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;

export function isBinary(content: Buffer): boolean {
  const limit = Math.min(content.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i += 1) if (content[i] === 0) return true;
  return false;
}

export function scanLine(line: string, denylistTerms: readonly string[]): RuleMatch[] {
  const matches: RuleMatch[] = [];
  for (const rule of GENERIC_RULES) matches.push(...rule.scan(line));
  matches.push(...scanDenylist(line, denylistTerms));
  return matches;
}

export function scanText(source: SourceKind, filePath: string, text: string, ctx: ScanContext): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of scanLine(line, ctx.denylistTerms)) {
      if (match.rule === "RH-PRIVATE-TERM") {
        findings.push({ source, path: filePath, line: index + 1, column: match.column, rule: match.rule, kind: match.kind });
        continue;
      }
      const print = fingerprint(match.rule, match.value);
      if (isAllowed(ctx.allowances, match.rule, filePath, print)) continue;
      findings.push({ source, path: filePath, line: index + 1, column: match.column, rule: match.rule, kind: match.kind, fingerprint: print });
    }
  });
  return findings;
}

/** Scan one blob/file body, applying binary and size policy. */
export function scanContent(report: SourceReport, filePath: string, content: Buffer, ctx: ScanContext): void {
  if (content.length > ctx.maxFileBytes) {
    report.errors.push({ source: report.source, path: filePath, reason: `larger than ${ctx.maxFileBytes} bytes; not scanned` });
    return;
  }
  if (isBinary(content)) {
    report.excluded.push({ source: report.source, path: filePath, reason: "binary content (text rules not applied)" });
    return;
  }
  report.scanned += 1;
  // Path names are published too.
  report.findings.push(...scanText(report.source, filePath, filePath, ctx).map((f) => ({ ...f, line: 0 })));
  report.findings.push(...scanText(report.source, filePath, content.toString("utf8"), ctx));
}

function newReport(source: SourceKind, label: string): SourceReport {
  return { source, label, scanned: 0, findings: [], excluded: [], errors: [] };
}

// --- Content sources --------------------------------------------------------

export interface BlobEntry {
  mode: string;
  object: string;
  path: string;
}

/** Read many blobs through one `git cat-file --batch` invocation. */
export async function readBlobs(ctx: GitContext, objects: readonly string[]): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const unique = [...new Set(objects)];
  if (unique.length === 0) return result;
  const out = await gitOk(ctx, ["cat-file", "--batch"], { input: unique.join("\n") + "\n" });
  let offset = 0;
  for (const object of unique) {
    const headerEnd = out.indexOf(0x0a, offset);
    if (headerEnd === -1) throw new Error("truncated cat-file output");
    const header = out.subarray(offset, headerEnd).toString("utf8");
    const parts = header.split(" ");
    if (parts[1] === "missing" || parts.length < 3) throw new Error(`object unavailable for ${object.slice(0, 12)}`);
    const size = Number(parts[2]);
    const start = headerEnd + 1;
    result.set(object, out.subarray(start, start + size));
    offset = start + size + 1;
  }
  return result;
}

export function parseStageEntries(buffer: Buffer): BlobEntry[] {
  // `<mode> <object> <stage>\t<path>`
  return splitNul(buffer).map((record) => {
    const tab = record.indexOf("\t");
    const [mode = "", object = ""] = record.slice(0, tab).split(" ");
    return { mode, object, path: record.slice(tab + 1) };
  });
}

export function parseTreeEntries(buffer: Buffer): BlobEntry[] {
  // `<mode> <type> <object>\t<path>`
  return splitNul(buffer).map((record) => {
    const tab = record.indexOf("\t");
    const [mode = "", , object = ""] = record.slice(0, tab).split(" ");
    return { mode, object, path: record.slice(tab + 1) };
  });
}

async function scanBlobEntries(report: SourceReport, git: GitContext, entries: BlobEntry[], scan: ScanContext): Promise<void> {
  const blobs = entries.filter((entry) => entry.mode !== "160000");
  for (const entry of entries) {
    if (entry.mode === "160000") report.excluded.push({ source: report.source, path: entry.path, reason: "submodule gitlink (separate repository)" });
  }
  let contents: Map<string, Buffer>;
  try {
    contents = await readBlobs(git, blobs.map((entry) => entry.object));
  } catch (error) {
    report.errors.push({ source: report.source, path: "(object database)", reason: (error as Error).message });
    return;
  }
  for (const entry of blobs) {
    const content = contents.get(entry.object);
    if (!content) {
      report.errors.push({ source: report.source, path: entry.path, reason: "blob unavailable" });
      continue;
    }
    // Symlink blobs (mode 120000) hold the link target, scanned as text without following it.
    scanContent(report, entry.path, content, scan);
  }
}

export async function loadAllowancesFrom(read: () => Promise<string | undefined>): Promise<{ allowances: Allowance[]; error?: string }> {
  let text: string | undefined;
  try {
    text = await read();
  } catch {
    return { allowances: [], error: `${ALLOWANCES_PATH} unreadable` };
  }
  const parsed = parseAllowances(text);
  return parsed.ok ? { allowances: parsed.allowances } : { allowances: [], error: parsed.reason };
}

export async function scanStaged(git: GitContext, scan: Omit<ScanContext, "allowances">): Promise<SourceReport> {
  const report = newReport("staged", "Git index (exact staged content)");
  let entries: BlobEntry[];
  try {
    entries = parseStageEntries(await gitOk(git, ["ls-files", "-z", "--stage"]));
  } catch (error) {
    report.errors.push({ source: "staged", path: "(index)", reason: (error as Error).message });
    return report;
  }
  const allowanceEntry = entries.find((entry) => entry.path === ALLOWANCES_PATH);
  const loaded = await loadAllowancesFrom(async () =>
    allowanceEntry ? (await readBlobs(git, [allowanceEntry.object])).get(allowanceEntry.object)?.toString("utf8") : undefined,
  );
  if (loaded.error) report.errors.push({ source: "staged", path: ALLOWANCES_PATH, reason: loaded.error });
  await scanBlobEntries(report, git, entries, { ...scan, allowances: loaded.allowances });
  return report;
}

export async function scanTree(git: GitContext, revision: string, scan: Omit<ScanContext, "allowances">): Promise<SourceReport> {
  const report = newReport("tree", `committed tree ${revision}`);
  let entries: BlobEntry[];
  try {
    entries = parseTreeEntries(await gitOk(git, ["ls-tree", "-r", "-z", "--full-tree", revision, "--"]));
  } catch (error) {
    report.errors.push({ source: "tree", path: revision, reason: (error as Error).message });
    return report;
  }
  const allowanceEntry = entries.find((entry) => entry.path === ALLOWANCES_PATH);
  const loaded = await loadAllowancesFrom(async () =>
    allowanceEntry ? (await readBlobs(git, [allowanceEntry.object])).get(allowanceEntry.object)?.toString("utf8") : undefined,
  );
  if (loaded.error) report.errors.push({ source: "tree", path: ALLOWANCES_PATH, reason: loaded.error });
  await scanBlobEntries(report, git, entries, { ...scan, allowances: loaded.allowances });
  return report;
}

export async function scanWorktree(git: GitContext, repoRoot: string, scan: Omit<ScanContext, "allowances">): Promise<SourceReport> {
  const report = newReport("worktree", "working tree (tracked and untracked non-ignored files)");
  let paths: string[];
  try {
    paths = [...new Set(splitNul(await gitOk(git, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])))];
  } catch (error) {
    report.errors.push({ source: "worktree", path: "(listing)", reason: (error as Error).message });
    return report;
  }
  const loaded = await loadAllowancesFrom(async () => {
    try {
      return readFileSync(path.join(repoRoot, ALLOWANCES_PATH), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  });
  if (loaded.error) report.errors.push({ source: "worktree", path: ALLOWANCES_PATH, reason: loaded.error });
  const ctx: ScanContext = { ...scan, allowances: loaded.allowances };
  for (const relative of paths.sort()) {
    const absolute = path.join(repoRoot, relative);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        report.excluded.push({ source: "worktree", path: relative, reason: "deleted in working tree" });
      } else {
        report.errors.push({ source: "worktree", path: relative, reason: "unreadable" });
      }
      continue;
    }
    try {
      if (stat.isSymbolicLink()) {
        // Never follow links out of the repository; the link text itself is published.
        scanContent(report, relative, Buffer.from(readlinkSync(absolute), "utf8"), ctx);
      } else if (stat.isDirectory()) {
        report.excluded.push({ source: "worktree", path: relative, reason: "submodule or nested repository" });
      } else if (stat.isFile()) {
        scanContent(report, relative, readFileSync(absolute), ctx);
      } else {
        report.errors.push({ source: "worktree", path: relative, reason: "not a regular file" });
      }
    } catch {
      report.errors.push({ source: "worktree", path: relative, reason: "unreadable" });
    }
  }
  return report;
}

// --- Commit metadata ---------------------------------------------------------

export interface CommitMetadata {
  commit: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  message: string;
}

export function parseCommitMetadata(buffer: Buffer): CommitMetadata[] {
  return splitNul(buffer)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [commit = "", authorName = "", authorEmail = "", committerName = "", committerEmail = "", ...rest] = record.split("\x1f");
      return { commit, authorName, authorEmail, committerName, committerEmail, message: rest.join("\x1f") };
    });
}

export async function scanMetadata(git: GitContext, range: string | readonly string[], scan: Omit<ScanContext, "allowances">): Promise<SourceReport> {
  const rangeArgs = typeof range === "string" ? [range] : [...range];
  const report = newReport("metadata", `commit metadata ${rangeArgs.join(" ")}`);
  let commits: CommitMetadata[];
  try {
    commits = parseCommitMetadata(await gitOk(git, ["log", "-z", "--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B", ...rangeArgs, "--"]));
  } catch (error) {
    report.errors.push({ source: "metadata", path: rangeArgs.join(" "), reason: (error as Error).message });
    return report;
  }
  const ctx: ScanContext = { ...scan, allowances: [] };
  for (const commit of commits) {
    report.scanned += 1;
    const label = `commit ${commit.commit.slice(0, 12)}`;
    for (const [field, email] of [["author", commit.authorEmail], ["committer", commit.committerEmail]] as const) {
      if (!isNeutralEmail(email)) {
        report.findings.push({ source: "metadata", path: `${label} ${field} email`, line: 0, column: 0, rule: "RH-EMAIL", kind: "commit-identity", fingerprint: fingerprint("RH-EMAIL", email) });
      }
    }
    const names = `${commit.authorName}\n${commit.committerName}`;
    report.findings.push(...scanText("metadata", `${label} identity names`, names, ctx));
    report.findings.push(...scanText("metadata", `${label} message`, commit.message, ctx));
  }
  return report;
}
