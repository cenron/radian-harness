// Provider-safe error classification. Quota/rate-limit, authentication,
// trust/permission, and infrastructure failures are distinguished; anything
// else is unknown. A reset time is recorded only from an explicit, parseable
// timestamp field — never guessed from prose. Classification never triggers a
// fallback or profile change.

import type { ClassifiedError, ErrorClass } from "./contract.ts";

const PATTERNS: ReadonlyArray<readonly [ErrorClass, RegExp]> = [
  ["quota", /\b(rate[ _-]?limit|quota|usage limit|too many requests|429|limit reached|exceeded your|insufficient_quota|overloaded_error)\b/i],
  ["authentication", /\b(401|unauthori[sz]ed|authentication|not logged in|login required|invalid[_ ]?(api[_ ]?key|token|grant)|expired token|token (has )?expired|oauth)\b/i],
  ["trust-permission", /\b(403|forbidden|permission denied|operation not permitted|not trusted|trust (dialog|prompt)|sandbox|EPERM|EACCES)\b/i],
  ["infrastructure", /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error|timed? ?out|5\d\d|bad gateway|service unavailable|internal server error|spawn|ENOENT|crash(ed)?|killed|SIGKILL|SIGTERM)\b/i],
];

export function classifyText(text: string): ErrorClass {
  for (const [cls, pattern] of PATTERNS) if (pattern.test(text)) return cls;
  return "unknown";
}

/** Parse an explicit reset timestamp: ISO string, epoch seconds, or epoch ms in a known field. */
export function explicitResetMs(value: unknown, nowMs: number): number | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > nowMs ? parsed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return ms > nowMs ? ms : undefined;
  }
  return undefined;
}

export function classify(text: string, fields: { resetsAt?: unknown } = {}, nowMs = Date.now()): ClassifiedError {
  const cls = classifyText(text);
  const out: ClassifiedError = { class: cls, summary: sanitizeSummary(text) };
  if (cls === "quota") {
    const reset = explicitResetMs(fields.resetsAt, nowMs);
    if (reset !== undefined) out.resetAtMs = reset;
  }
  return out;
}

/** Bound and scrub an error message for display: no tokens, emails, or home paths. */
export function sanitizeSummary(text: string): string {
  return text
    .replace(/(?:sk|ghp|gho|xox[abposr]|npm)[-_][A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\/(Users|home)\/[^/\s]+/g, "~")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
