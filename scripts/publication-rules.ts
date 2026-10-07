// Rules for text that must not be published. Each pattern is written so that its own
// source does not match it (for example `-{5}` instead of five dashes), because the
// scanner also scans this file.

export type RuleId = "home-path" | "email" | "token" | "private-key" | "denylist";

export interface LineFinding {
  rule: RuleId;
  /** Column (1-based) where the match starts. */
  column: number;
  /** The match with its sensitive part masked; safe to print. */
  excerpt: string;
}

const HOME_PATH = /(?<![\w.-])\/(?:Users|home)\/[\w.-]+/g;
const EMAIL = /(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const TOKEN =
  /\b(?:gh[pos]_[A-Za-z0-9]{36}|github_pat_\w{22,}|sk-[\w-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})/g;
const PRIVATE_KEY = /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/g;

const ALLOWED_EMAILS = new Set(["noreply@anthropic.com"]);
const ALLOWED_EMAIL_DOMAINS = ["example.com", "example.invalid", "users.noreply.github.com"];

export function scanLine(line: string, denylist: readonly string[] = []): LineFinding[] {
  return [
    ...matchAll(line, HOME_PATH, "home-path", (value) =>
      maskAfter(value, value.indexOf("/", 1) + 1),
    ),
    ...matchAll(line, EMAIL, "email", maskEmail),
    ...matchAll(line, TOKEN, "token", (value) => maskAfter(value, tokenPrefixLength(value))),
    ...matchAll(line, PRIVATE_KEY, "private-key", (value) => value),
    ...denylistFindings(line, denylist),
  ];
}

/** One literal per line; blank lines and `#` comments are ignored. */
export function parseDenylist(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export function isAllowedEmail(address: string): boolean {
  const lower = address.toLowerCase();
  const domain = lower.slice(lower.lastIndexOf("@") + 1);
  return ALLOWED_EMAILS.has(lower) || ALLOWED_EMAIL_DOMAINS.includes(domain);
}

function matchAll(
  line: string,
  pattern: RegExp,
  rule: RuleId,
  mask: (value: string) => string | undefined,
): LineFinding[] {
  const findings: LineFinding[] = [];
  for (const match of line.matchAll(pattern)) {
    const excerpt = mask(match[0]);
    if (excerpt !== undefined) findings.push({ rule, column: match.index + 1, excerpt });
  }
  return findings;
}

function denylistFindings(line: string, denylist: readonly string[]): LineFinding[] {
  const lower = line.toLowerCase();
  // Private values are never echoed, not even partially; the entry number identifies them.
  return denylist.flatMap((literal, entryIndex) => {
    const index = lower.indexOf(literal.toLowerCase());
    if (index === -1) return [];
    return [{ rule: "denylist" as const, column: index + 1, excerpt: `entry ${entryIndex + 1}` }];
  });
}

function maskEmail(address: string): string | undefined {
  if (isAllowedEmail(address)) return undefined;
  const at = address.lastIndexOf("@");
  return `${maskAfter(address.slice(0, at), 1)}${address.slice(at)}`;
}

/** Keeps the token family visible (ghp_, sk-ant-, AKIA…) and hides the secret. */
function tokenPrefixLength(token: string): number {
  if (token.startsWith("github_pat_")) return "github_pat_".length;
  if (token.startsWith("sk-ant-")) return "sk-ant-".length;
  return token.startsWith("sk-") ? 3 : 4;
}

function maskAfter(value: string, visibleLength: number): string {
  return `${value.slice(0, visibleLength)}***`;
}
