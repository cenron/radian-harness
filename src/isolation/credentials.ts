// Credential ownership and projection (proposal 0015 constrained).
//
// - The runtime/provider pairing is rechecked before any credential is read:
//   Anthropic credentials go only to Claude Code; Pi and Codex never get them.
// - Required credential and billing-path capabilities must be verified before
//   any source is read; unverified capabilities block without exposure.
// - Only the selected provider's subscription OAuth record is projected, into a
//   private directory whose credential files are write-denied to the worker.
//   API-key or unknown credential types are refused (no pay-as-you-go path).
// - Workers never refresh. Radian has one explicit refresh owner per provider
//   but performs no refresh in this release: a credential without enough
//   validity for the assignment blocks instead.
// - Personal credential stores are opened read-only and never written.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { AssignmentIdentity, RuntimeKind } from "../contracts/identity.ts";
import { type ResolvedProfile, recheckResolvedProfile } from "../config/provider-policy.ts";
import { canonicalJson, sha256 } from "../util/canonical.ts";
import { type Clock, systemClock } from "../util/clock.ts";
import { run, succeeded } from "../util/proc.ts";
import type { CapabilityContext, CapabilityRegistry } from "./capabilities.ts";

export type CredentialKind = "subscription-oauth" | "api-key" | "unknown";

export interface SourceRecord {
  kind: CredentialKind;
  /** Expiry in epoch ms when known. */
  expiresAtMs?: number;
  /** Fingerprint of the selected record, for rotation detection; never the value. */
  fingerprint: string;
  /** The single selected record to project. Never logged. */
  payload: unknown;
}

export interface CredentialSource {
  runtime: RuntimeKind;
  provider: string;
  describe: string;
  read(): Promise<Outcome<SourceRecord>>;
}

function fingerprintOf(value: unknown): string {
  return "sha256:" + sha256(canonicalJson(value)).slice(0, 16);
}

function readJsonFile(file: string): Outcome<unknown> {
  try {
    return success(JSON.parse(readFileSync(file, { encoding: "utf8", flag: "r" })) as unknown);
  } catch {
    return refuse("CREDENTIAL_UNAVAILABLE", "credential source is missing or unreadable");
  }
}

/** Pi's multi-provider auth store; only the selected provider entry is used. */
export function piAuthFileSource(file: string, provider: string): CredentialSource {
  return {
    runtime: "pi",
    provider,
    describe: "Pi auth store (selected provider only)",
    async read() {
      const data = readJsonFile(file);
      if (!data.ok) return data;
      const entry = (data.value as Record<string, unknown>)[provider];
      if (typeof entry !== "object" || entry === null) return refuse("CREDENTIAL_UNAVAILABLE", "selected provider has no stored credential");
      const record = entry as Record<string, unknown>;
      const kind: CredentialKind = record.type === "oauth" ? "subscription-oauth" : record.type === "api_key" || record.type === "apiKey" || "key" in record ? "api-key" : "unknown";
      const out: SourceRecord = { kind, fingerprint: fingerprintOf(record), payload: record };
      if (typeof record.expires === "number") out.expiresAtMs = record.expires;
      return success(out);
    },
  };
}

function jwtExpiry(token: unknown): number | undefined {
  if (typeof token !== "string") return undefined;
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Codex CLI auth file: ChatGPT login tokens are subscription OAuth; an API key is not. */
export function codexAuthFileSource(file: string): CredentialSource {
  return {
    runtime: "codex",
    provider: "openai",
    describe: "Codex CLI auth file",
    async read() {
      const data = readJsonFile(file);
      if (!data.ok) return data;
      const record = data.value as Record<string, unknown>;
      const apiKey = record.OPENAI_API_KEY;
      const tokens = record.tokens as Record<string, unknown> | undefined;
      let kind: CredentialKind = "unknown";
      if (typeof apiKey === "string" && apiKey.length > 0) kind = "api-key";
      else if (tokens && typeof tokens === "object" && typeof tokens.access_token === "string") kind = "subscription-oauth";
      const out: SourceRecord = { kind, fingerprint: fingerprintOf(record), payload: record };
      const exp = jwtExpiry(tokens?.access_token);
      if (exp !== undefined) out.expiresAtMs = exp;
      return success(out);
    },
  };
}

export type KeychainReader = (service: string) => Promise<string | undefined>;

/** Reads one explicitly named Keychain item through the host `security` tool; never grants workers Keychain access. */
export const securityKeychainReader: KeychainReader = async (service) => {
  const result = await run("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 30_000 });
  return succeeded(result) ? result.stdout.toString("utf8").trim() : undefined;
};

export function claudeKeychainSource(service: string, reader: KeychainReader = securityKeychainReader): CredentialSource {
  return {
    runtime: "claude-code",
    provider: "anthropic",
    describe: "Claude Code claude.ai OAuth Keychain item",
    async read() {
      const raw = await reader(service);
      if (!raw) return refuse("CREDENTIAL_UNAVAILABLE", "Claude Code subscription credential is not available");
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return refuse("CREDENTIAL_UNAVAILABLE", "Claude Code credential is not in the expected format");
      }
      const oauth = data.claudeAiOauth as Record<string, unknown> | undefined;
      const kind: CredentialKind = oauth && typeof oauth.accessToken === "string" ? "subscription-oauth" : "unknown";
      const out: SourceRecord = { kind, fingerprint: fingerprintOf(oauth ?? data), payload: { claudeAiOauth: oauth } };
      if (oauth && typeof oauth.expiresAt === "number") out.expiresAtMs = oauth.expiresAt;
      return success(out);
    },
  };
}

/** Environment variables that would route a runtime to API-key billing or a custom endpoint. */
export const PROHIBITED_RUNTIME_ENV: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
];

export function assertNoProhibitedEnv(env: Record<string, string>): Outcome<true> {
  const present = PROHIBITED_RUNTIME_ENV.filter((name) => name in env);
  if (present.length > 0) return refuse("CUSTOM_ENDPOINT_PROHIBITED", "launch environment contains API-key, endpoint, or proxy variables", "Launch environments are built from scratch; remove these variables.", { names: present.join(",") });
  return success(true);
}

export interface Projection {
  dir: string;
  runtime: RuntimeKind;
  provider: string;
  sourceFingerprint: string;
  expiresAtMs?: number;
  /** Environment entries pointing the runtime at its projected configuration. */
  env: Record<string, string>;
  /** Credential files the worker may read but never write, rename, or delete. */
  readOnlyFiles: string[];
  /** Runtime home directories the worker may write (sessions, caches), without credentials. */
  writableDirs: string[];
}

export interface ProjectionRequest {
  identity: AssignmentIdentity;
  profile: ResolvedProfile;
  source: CredentialSource;
  /** Private parent directory (outside worker-writable scope) for projections. */
  projectionRoot: string;
  /** Minimum remaining validity required: assignment budget plus a safety margin. */
  minValidityMs: number;
  capabilities: CapabilityRegistry;
  capabilityContext: CapabilityContext;
}

/**
 * Pre-exposure gate: profile pairing, source/profile match, and capabilities,
 * checked before any credential source is read.
 */
export function assertProjectionAllowed(request: Omit<ProjectionRequest, "projectionRoot" | "minValidityMs">): Outcome<true> {
  const recheck = recheckResolvedProfile(request.profile);
  if (!recheck.ok) return recheck;
  const { profile, source } = request;
  if (profile.family === "anthropic" && profile.runtime !== "claude-code") return refuse("CREDENTIAL_EXPOSURE_PROHIBITED", "Anthropic credentials are never projected into Pi or Codex workers");
  if (source.runtime !== profile.runtime) return refuse("CREDENTIAL_EXPOSURE_PROHIBITED", "credential source belongs to a different runtime");
  if (source.provider !== profile.provider) return refuse("CREDENTIAL_EXPOSURE_PROHIBITED", "credential source belongs to a different provider");
  if (source.provider === "anthropic" && profile.runtime !== "claude-code") return refuse("CREDENTIAL_EXPOSURE_PROHIBITED", "Anthropic credentials are never projected into Pi or Codex workers");
  return request.capabilities.require([`credential.${profile.runtime}.non-refreshing-access`, `billing.${profile.runtime}.subscription-path`], { ...request.capabilityContext, runtime: profile.runtime });
}

function layout(runtime: RuntimeKind, dir: string, provider: string, payload: unknown): { files: Array<{ path: string; content: string }>; env: Record<string, string>; writableDirs: string[] } {
  switch (runtime) {
    case "pi": {
      const agent = path.join(dir, "pi-agent");
      return {
        files: [{ path: path.join(agent, "auth.json"), content: JSON.stringify({ [provider]: payload }) }],
        env: { PI_CODING_AGENT_DIR: agent },
        writableDirs: [path.join(agent, "sessions")],
      };
    }
    case "codex": {
      const home = path.join(dir, "codex-home");
      return { files: [{ path: path.join(home, "auth.json"), content: JSON.stringify(payload) }], env: { CODEX_HOME: home }, writableDirs: [home] };
    }
    case "claude-code": {
      const config = path.join(dir, "claude-config");
      return { files: [{ path: path.join(config, ".credentials.json"), content: JSON.stringify(payload) }], env: { CLAUDE_CONFIG_DIR: config }, writableDirs: [config] };
    }
  }
}

export class CredentialBroker {
  private readonly clock: Clock;
  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  async project(request: ProjectionRequest): Promise<Outcome<Projection>> {
    const allowed = assertProjectionAllowed(request);
    if (!allowed.ok) return allowed;
    const record = await request.source.read();
    if (!record.ok) return record;
    if (record.value.kind === "api-key") return refuse("BILLING_PATH_UNVERIFIED", "stored credential is an API key; only subscription OAuth is permitted", "Use the runtime's supported subscription login; Radian never uses API-key billing.");
    if (record.value.kind !== "subscription-oauth") return refuse("BILLING_PATH_UNVERIFIED", "credential type cannot be confirmed as subscription OAuth");
    if (record.value.expiresAtMs === undefined) return refuse("CREDENTIAL_REFRESH_OWNERSHIP", "credential expiry is unknown; non-refreshing use cannot be bounded");
    if (record.value.expiresAtMs < this.clock.now() + request.minValidityMs) {
      return refuse("CREDENTIAL_REFRESH_OWNERSHIP", "credential would expire during the assignment; refresh is owned outside workers and is not performed automatically", "Refresh through the runtime's own login outside Radian, then retry.");
    }
    const dir = path.join(request.projectionRoot, `${request.identity.assignment}-${request.identity.attempt}`);
    if (existsSync(dir)) return refuse("OWNERSHIP_AMBIGUOUS", "a projection already exists for this attempt");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const plan = layout(request.profile.runtime, dir, request.profile.provider, record.value.payload);
    try {
      for (const file of plan.files) {
        mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o700 });
        writeFileSync(file.path, file.content, { mode: 0o600, flag: "wx" });
        chmodSync(file.path, 0o400);
      }
      for (const writable of plan.writableDirs) mkdirSync(writable, { recursive: true, mode: 0o700 });
    } catch {
      rmSync(dir, { recursive: true, force: true });
      return refuse("CREDENTIAL_UNAVAILABLE", "credential projection could not be written");
    }
    const projection: Projection = {
      dir,
      runtime: request.profile.runtime,
      provider: request.profile.provider,
      sourceFingerprint: record.value.fingerprint,
      env: plan.env,
      readOnlyFiles: plan.files.map((f) => f.path),
      writableDirs: plan.writableDirs,
    };
    projection.expiresAtMs = record.value.expiresAtMs;
    return success(projection);
  }

  /** Detect rotation of the personal store or approaching expiry; affected execution must be retired. */
  async check(projection: Projection, source: CredentialSource, minValidityMs: number): Promise<Outcome<true>> {
    const current = await source.read();
    if (!current.ok) return refuse("CREDENTIAL_EXPIRED", "credential source is no longer available");
    if (current.value.fingerprint !== projection.sourceFingerprint) return refuse("CREDENTIAL_EXPIRED", "credential source changed (rotated) since projection; retire affected workers and preserve work");
    if (projection.expiresAtMs === undefined || projection.expiresAtMs < this.clock.now() + minValidityMs) return refuse("CREDENTIAL_EXPIRED", "projected credential is expiring");
    return success(true);
  }

  /** Destroy a projection; verifies it is gone. */
  destroy(projection: Projection): Outcome<true> {
    for (const file of projection.readOnlyFiles) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // already absent
      }
    }
    rmSync(projection.dir, { recursive: true, force: true });
    return existsSync(projection.dir) ? refuse("CREDENTIAL_UNAVAILABLE", "projection could not be destroyed") : success(true);
  }
}
