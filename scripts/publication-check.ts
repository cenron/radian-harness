// Scans tracked files and commit messages for text that must not be published.
// Author and committer fields are not scanned: they are the user's chosen git identity.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "../src/core/utils/errors.ts";
import { parseDenylist, scanLine } from "./publication-rules.ts";
import type { LineFinding } from "./publication-rules.ts";

interface Finding extends LineFinding {
  source: string;
}

const usage = "Usage: node scripts/publication-check.ts [--repo <dir>]";

process.exitCode = main(process.argv.slice(2));

function main(args: string[]): number {
  const repo = parseRepository(args);
  if (repo === undefined) {
    console.error(usage);
    return 2;
  }
  try {
    const denylist = loadDenylist();
    const findings = [...scanTrackedFiles(repo, denylist), ...scanCommitMessages(repo, denylist)];
    for (const finding of findings) {
      console.log(`${finding.rule}  ${finding.source}  ${finding.excerpt}`);
    }
    console.log(
      findings.length === 0
        ? "Publication check: clean."
        : `Publication check: ${findings.length} finding(s).`,
    );
    return findings.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`Publication check failed: ${errorMessage(error)}`);
    return 2;
  }
}

function parseRepository(args: string[]): string | undefined {
  if (args.length === 0) return process.cwd();
  if (args.length === 2 && args[0] === "--repo") return path.resolve(args[1] as string);
  return undefined;
}

function loadDenylist(): string[] {
  const denylistPath = process.env.RADIAN_PUBLICATION_DENYLIST;
  if (!denylistPath) {
    console.log("Private denylist coverage is absent (RADIAN_PUBLICATION_DENYLIST is not set).");
    return [];
  }
  return parseDenylist(fs.readFileSync(denylistPath, "utf8"));
}

function scanTrackedFiles(repo: string, denylist: readonly string[]): Finding[] {
  const files = git(repo, ["ls-files", "-z"]).split("\0").filter(Boolean);
  return files.flatMap((file) => {
    const content = readTextFile(path.join(repo, file));
    if (content === undefined) return [];
    return scanText(content, denylist, (lineNumber) => `${file}:${lineNumber}`);
  });
}

function scanCommitMessages(repo: string, denylist: readonly string[]): Finding[] {
  const records = git(repo, ["log", "--format=%H%x00%B%x1e", "HEAD"]).split("\x1e");
  return records.flatMap((record) => {
    const [hash, message] = record.replace(/^\n/, "").split("\0");
    if (!hash || message === undefined) return [];
    return scanText(message, denylist, () => `commit ${hash.slice(0, 12)}`);
  });
}

function scanText(
  text: string,
  denylist: readonly string[],
  sourceOf: (lineNumber: number) => string,
): Finding[] {
  return text
    .split("\n")
    .flatMap((line, index) =>
      scanLine(line, denylist).map((finding) => ({ ...finding, source: sourceOf(index + 1) })),
    );
}

/** Undefined for binary files (a NUL byte in the first 8 KB) and for anything not a regular file. */
function readTextFile(file: string): string | undefined {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) return undefined;
  const content = fs.readFileSync(file);
  return content.subarray(0, 8192).includes(0) ? undefined : content.toString("utf8");
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
