// Generic publication-safety rules. Each rule has a stable ID used in findings
// and in reviewed allowances. Built-in safe values (neutral examples, GitHub
// noreply addresses) are narrow, named exceptions rather than disabled rules.
//
// Patterns are deliberately written so that their own source text does not
// match them (for example `-{5}` rather than five literal dashes).

export type RuleId =
  | "RH-HOME-PATH"
  | "RH-MACOS-TEMP-PATH"
  | "RH-EMAIL"
  | "RH-PRIVATE-IPV4"
  | "RH-PRIVATE-KEY"
  | "RH-TOKEN"
  | "RH-SECRET-ASSIGNMENT"
  | "RH-PRIVATE-TERM";

export interface RuleMatch {
  rule: RuleId;
  /** Human-readable subtype (e.g. token family); never contains the matched value. */
  kind: string;
  /** Column (1-based) of the match within its line. */
  column: number;
  /** The matched value; used only for fingerprinting and is never printed. */
  value: string;
}

export interface Rule {
  id: RuleId;
  description: string;
  scan(line: string): RuleMatch[];
}

function collect(
  id: RuleId,
  kind: string,
  pattern: RegExp,
  line: string,
  accept: (match: RegExpExecArray) => string | undefined,
): RuleMatch[] {
  const out: RuleMatch[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const value = accept(m);
    if (value !== undefined) out.push({ rule: id, kind, column: m.index + 1, value });
  }
  return out;
}

// --- Home and machine paths -------------------------------------------------

export const NEUTRAL_HOME_NAMES: ReadonlySet<string> = new Set([
  "example",
  "user",
  "username",
  "you",
  "me",
  "name",
  "someone",
  "runner",
  "shared",
]);

const UNIX_HOME = /(?<![A-Za-z0-9._-])\/(?:Users|home)\/([A-Za-z0-9._-]+)/;
const WINDOWS_HOME = /\b[A-Za-z]:\\{1,2}Users\\{1,2}([^\\\s"'<>|]+)/i;
const MACOS_TEMP = /\/(?:private\/)?var\/folders\/[A-Za-z0-9_+-]{2}\/[A-Za-z0-9_+-]{6,}/;

const homePathRule: Rule = {
  id: "RH-HOME-PATH",
  description: "Absolute user-home path (use ~/ or a neutral placeholder)",
  scan(line) {
    const accept = (m: RegExpExecArray): string | undefined => {
      const name = (m[1] ?? "").toLowerCase();
      if (NEUTRAL_HOME_NAMES.has(name)) return undefined;
      return m[0];
    };
    return [
      ...collect("RH-HOME-PATH", "unix-home", UNIX_HOME, line, accept),
      ...collect("RH-HOME-PATH", "windows-home", WINDOWS_HOME, line, accept),
    ];
  },
};

const macosTempRule: Rule = {
  id: "RH-MACOS-TEMP-PATH",
  description: "Machine-specific macOS temporary directory path",
  scan(line) {
    return collect("RH-MACOS-TEMP-PATH", "per-user-temp", MACOS_TEMP, line, (m) => m[0]);
  },
};

// --- Email addresses --------------------------------------------------------

const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/;
export const NEUTRAL_EMAIL_DOMAINS: readonly string[] = ["example.com", "example.org", "example.net"];
export const NEUTRAL_EMAIL_SUFFIXES: readonly string[] = [".example", ".invalid", ".test", ".localhost"];
export const NEUTRAL_EMAIL_EXACT: ReadonlySet<string> = new Set([
  "noreply@github.com",
  "git@github.com",
  "noreply@anthropic.com",
]);

export function isNeutralEmail(address: string): boolean {
  const lower = address.toLowerCase();
  if (NEUTRAL_EMAIL_EXACT.has(lower)) return true;
  const domain = lower.slice(lower.lastIndexOf("@") + 1);
  if (domain === "users.noreply.github.com") return true;
  if (NEUTRAL_EMAIL_DOMAINS.includes(domain)) return true;
  return NEUTRAL_EMAIL_SUFFIXES.some((suffix) => domain.endsWith(suffix));
}

const emailRule: Rule = {
  id: "RH-EMAIL",
  description: "Email address (neutral example domains and GitHub noreply addresses are allowed)",
  scan(line) {
    return collect("RH-EMAIL", "address", EMAIL, line, (m) => (isNeutralEmail(m[0]) ? undefined : m[0]));
  },
};

// --- Private IPv4 -----------------------------------------------------------

const IPV4 = /(?<![0-9.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![0-9]|\.[0-9])/;

export function isPrivateIPv4(octets: readonly number[]): boolean {
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

const privateIpRule: Rule = {
  id: "RH-PRIVATE-IPV4",
  description: "Private, link-local, or carrier-grade NAT IPv4 address",
  scan(line) {
    return collect("RH-PRIVATE-IPV4", "address", IPV4, line, (m) => {
      const octets = [m[1], m[2], m[3], m[4]].map((o) => Number(o));
      return isPrivateIPv4(octets) ? m[0] : undefined;
    });
  },
};

// --- Private keys -----------------------------------------------------------

const PRIVATE_KEY = /-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-{5}/;

const privateKeyRule: Rule = {
  id: "RH-PRIVATE-KEY",
  description: "Private-key header",
  scan(line) {
    return collect("RH-PRIVATE-KEY", "pem-header", PRIVATE_KEY, line, (m) => m[0]);
  },
};

// --- Common token formats ---------------------------------------------------

const TOKEN_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["github-fine-grained-token", /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ["aws-access-key-id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ["sk-style-api-key", /\bsk-(?:proj-|ant-[a-z0-9]+-|svcacct-)?[A-Za-z0-9_-]{20,}/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["stripe-live-key", /\b[rs]k_live_[0-9A-Za-z]{16,}\b/],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["bearer-credential", /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{24,}=*/],
];

const tokenRule: Rule = {
  id: "RH-TOKEN",
  description: "Common API token or credential format",
  scan(line) {
    const out: RuleMatch[] = [];
    for (const [kind, pattern] of TOKEN_PATTERNS) out.push(...collect("RH-TOKEN", kind, pattern, line, (m) => m[0]));
    return out;
  },
};

// --- Hardcoded secret assignments ------------------------------------------

const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)[A-Za-z0-9_-]*`;
const QUOTED_ASSIGNMENT = new RegExp(String.raw`(?<![A-Za-z0-9_])["']?(${SECRET_NAME})["']?\s*(?::|=|:=|=>)\s*["'\x60]([^"'\x60\s]{8,})["'\x60]`, "i");
const ENV_ASSIGNMENT = new RegExp(String.raw`^\s*(?:export\s+)?([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)=([^\s"'$\x60]{8,})\s*$`);

const PLACEHOLDER_VALUE = /^(?:x+|\*+|\.+|-+|_+|0+|changeme|redacted.*|placeholder.*|example.*|your[-_].*|dummy.*|fake.*|sample.*|synthetic.*|<.*>|\{\{.*\}\}|\$\{.*\}|\$[A-Z_]+|process\.env\..*|env\..*|none|null|undefined|true|false)$/i;

export function looksLikeSecretValue(value: string): boolean {
  if (PLACEHOLDER_VALUE.test(value)) return false;
  if (/[<>{}]/.test(value)) return false;
  if (value.includes("${")) return false;
  const hasLetter = /[A-Za-z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  // Pure identifiers or prose words are typically names, not secrets. This is a
  // documented limitation: letter-only secrets are not detected by this rule.
  return hasLetter && hasDigit;
}

const secretAssignmentRule: Rule = {
  id: "RH-SECRET-ASSIGNMENT",
  description: "Hardcoded secret-like value assigned to a credential-named field",
  scan(line) {
    const accept = (m: RegExpExecArray): string | undefined => {
      const value = m[2] ?? "";
      return looksLikeSecretValue(value) ? value : undefined;
    };
    return [
      ...collect("RH-SECRET-ASSIGNMENT", "quoted-assignment", QUOTED_ASSIGNMENT, line, accept),
      ...collect("RH-SECRET-ASSIGNMENT", "environment-assignment", ENV_ASSIGNMENT, line, accept),
    ];
  },
};

export const GENERIC_RULES: readonly Rule[] = [
  homePathRule,
  macosTempRule,
  emailRule,
  privateIpRule,
  privateKeyRule,
  tokenRule,
  secretAssignmentRule,
];

export function ruleById(id: RuleId): Rule | undefined {
  return GENERIC_RULES.find((rule) => rule.id === id);
}
