// Narrow reviewed allowances. Each allowance names one rule, one exact
// repository path, and the fingerprint of one matched value. Wildcards and
// whole-rule disabling are rejected by validation.

import { createHash } from "node:crypto";
import { GENERIC_RULES, type RuleId } from "./rules.ts";

export const ALLOWANCES_PATH = "config/publication-allowances.json";

export interface Allowance {
  rule: RuleId;
  path: string;
  fingerprint: string;
  reason: string;
}

export function fingerprint(rule: RuleId, value: string): string {
  return "sha256:" + createHash("sha256").update(rule).update("\0").update(value).digest("hex").slice(0, 16);
}

export type AllowanceLoad = { ok: true; allowances: Allowance[] } | { ok: false; reason: string };

const KNOWN_RULES = new Set<string>(GENERIC_RULES.map((rule) => rule.id));

export function parseAllowances(text: string | undefined): AllowanceLoad {
  if (text === undefined) return { ok: true, allowances: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${ALLOWANCES_PATH} is not valid JSON` };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, reason: `${ALLOWANCES_PATH} must be an object` };
  }
  const record = data as Record<string, unknown>;
  if (record.version !== 1) return { ok: false, reason: `${ALLOWANCES_PATH} version must be 1` };
  const list = record.allowances;
  if (!Array.isArray(list)) return { ok: false, reason: `${ALLOWANCES_PATH} allowances must be an array` };
  const allowances: Allowance[] = [];
  for (const [index, entry] of list.entries()) {
    const where = `${ALLOWANCES_PATH} allowances[${index}]`;
    if (typeof entry !== "object" || entry === null) return { ok: false, reason: `${where} must be an object` };
    const e = entry as Record<string, unknown>;
    const keys = Object.keys(e).sort().join(",");
    if (keys !== "fingerprint,path,reason,rule") return { ok: false, reason: `${where} must have exactly rule, path, fingerprint, reason` };
    if (typeof e.rule !== "string" || !KNOWN_RULES.has(e.rule)) return { ok: false, reason: `${where} names an unknown or non-allowable rule` };
    if (typeof e.path !== "string" || e.path === "" || /[*?[\]]/.test(e.path) || e.path.startsWith("/") || e.path.split("/").includes("..")) {
      return { ok: false, reason: `${where} path must be one exact repository-relative path` };
    }
    if (typeof e.fingerprint !== "string" || !/^sha256:[0-9a-f]{16}$/.test(e.fingerprint)) {
      return { ok: false, reason: `${where} fingerprint must be sha256:<16 hex>` };
    }
    if (typeof e.reason !== "string" || e.reason.trim().length < 10) return { ok: false, reason: `${where} needs a reviewed reason` };
    allowances.push({ rule: e.rule as RuleId, path: e.path, fingerprint: e.fingerprint, reason: e.reason });
  }
  return { ok: true, allowances };
}

export function isAllowed(allowances: readonly Allowance[], rule: RuleId, filePath: string, print: string): boolean {
  return allowances.some((a) => a.rule === rule && a.path === filePath && a.fingerprint === print);
}
