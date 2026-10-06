// Optional private denylist: literal, case-insensitive personal terms kept
// outside the repository. Values are never printed or fingerprinted.

import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { RuleMatch } from "./rules.ts";

export const DENYLIST_ENV = "RADIAN_PUBLICATION_DENYLIST";
export const MIN_TERM_LENGTH = 3;

export type DenylistStatus =
  | { state: "absent" }
  | { state: "loaded"; termCount: number }
  | { state: "error"; reason: string };

export interface Denylist {
  status: DenylistStatus;
  terms: readonly string[];
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Load the denylist from an explicit path (or environment variable). The file
 * must exist outside the repository being scanned; a configured but unreadable
 * or in-repository denylist is an error, never an implicitly clean scan.
 */
export function loadDenylist(explicitPath: string | undefined, repoRoot: string): Denylist {
  const configured = explicitPath ?? process.env[DENYLIST_ENV];
  if (!configured) return { status: { state: "absent" }, terms: [] };
  let resolved: string;
  try {
    resolved = realpathSync(configured);
  } catch {
    return { status: { state: "error", reason: "configured denylist path is unreadable" }, terms: [] };
  }
  let repoReal = repoRoot;
  try {
    repoReal = realpathSync(repoRoot);
  } catch {
    // fall back to the provided root
  }
  if (isInside(resolved, repoReal)) {
    return { status: { state: "error", reason: "denylist must live outside the repository" }, terms: [] };
  }
  let text: string;
  try {
    if (!statSync(resolved).isFile()) {
      return { status: { state: "error", reason: "configured denylist is not a regular file" }, terms: [] };
    }
    text = readFileSync(resolved, "utf8");
  } catch {
    return { status: { state: "error", reason: "configured denylist is unreadable" }, terms: [] };
  }
  const terms: string[] = [];
  let tooShort = 0;
  for (const raw of text.split(/\r?\n/)) {
    const term = raw.trim();
    if (term === "" || term.startsWith("#")) continue;
    if (term.length < MIN_TERM_LENGTH) {
      tooShort += 1;
      continue;
    }
    terms.push(term.toLowerCase());
  }
  if (tooShort > 0) {
    return {
      status: { state: "error", reason: `${tooShort} denylist term(s) shorter than ${MIN_TERM_LENGTH} characters` },
      terms: [],
    };
  }
  if (terms.length === 0) {
    return { status: { state: "error", reason: "configured denylist contains no terms" }, terms: [] };
  }
  return { status: { state: "loaded", termCount: terms.length }, terms };
}

export function scanDenylist(line: string, terms: readonly string[]): RuleMatch[] {
  if (terms.length === 0) return [];
  const lower = line.toLowerCase();
  const out: RuleMatch[] = [];
  for (const term of terms) {
    let index = lower.indexOf(term);
    while (index !== -1) {
      out.push({ rule: "RH-PRIVATE-TERM", kind: "private-term", column: index + 1, value: term });
      index = lower.indexOf(term, index + term.length);
    }
  }
  return out;
}
