// Tier 2 capability checks: the real Claude Code binary under Radian's
// production profile, with a scoped, read-only projection of the user's
// Claude Code subscription login. No model call is made. The Keychain item is
// read only by the host `security` tool, exactly as production does; workers
// never get Keychain access. Only whitelisted, non-secret status fields are
// reported (never tokens, account identifiers, or email addresses).

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { newId, type AssignmentIdentity } from "../contracts/identity.ts";
import { evaluateProfile } from "../config/provider-policy.ts";
import { type Projection, claudeKeychainSource, projectionLayout } from "../isolation/credentials.ts";
import { personalCredentialStores } from "../ui/session.ts";
import { resolveDependencies } from "../isolation/dependencies.ts";
import { generateProfile } from "../isolation/profile.ts";
import { createClaudeAdapter } from "../runtimes/claude.ts";
import { type CheckResult, type VerifyLayout, authorityFor, cleanup, verifyLayout } from "./harness.ts";

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const STATUS_FIELDS = ["loggedIn", "authMethod", "apiProvider", "subscriptionType", "authType", "provider", "type"];

export interface ClaudeFixture {
  l: VerifyLayout;
  sessionId: string;
  model: string;
  tools: string[];
  argv: string[];
  version: string;
  argv0: string;
  env: Record<string, string>;
  cwd: string;
  profileFile: string;
  credentialFile: string;
  credentialHash: string;
  sourceFingerprint: string;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Build the production-shaped launch for a Claude Code worker (projection, env, dependencies, profile, argv). */
export async function claudeFixture(options: { role?: "developer" | "reviewer"; model?: string; effort?: string; brief?: string } = {}): Promise<{ ok: true; value: ClaudeFixture } | { ok: false; reason: string }> {
  const role = options.role ?? "developer";
  const l = verifyLayout();
  const fail = (reason: string) => (cleanup(l), { ok: false as const, reason });
  const adapter = createClaudeAdapter();
  const install = await adapter.detect();
  if (!install.ok) return fail(`Claude Code was not detected: ${install.blocker.message}`);
  const record = await claudeKeychainSource(CLAUDE_KEYCHAIN_SERVICE).read();
  if (!record.ok) return fail(`the Claude Code login could not be read from its Keychain item: ${record.blocker.message}`);
  if (record.value.kind !== "subscription-oauth") return fail(`the stored Claude Code login is not subscription OAuth (${record.value.kind})`);
  if (record.value.expiresAtMs === undefined || record.value.expiresAtMs < Date.now() + 10 * 60_000) return fail("the Claude Code login expires within 10 minutes; refresh it with Claude Code itself, then retry");
  const dir = path.join(l.root, "projection");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const plan = projectionLayout("claude-code", dir, "anthropic", record.value.payload);
  for (const file of plan.files) {
    mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o700 });
    writeFileSync(file.path, file.content, { mode: 0o600, flag: "wx" });
    chmodSync(file.path, 0o400);
  }
  for (const writable of plan.writableDirs) mkdirSync(writable, { recursive: true, mode: 0o700 });
  const projection: Projection = { dir, runtime: "claude-code", provider: "anthropic", sourceFingerprint: record.value.fingerprint, expiresAtMs: record.value.expiresAtMs, env: plan.env, readOnlyFiles: plan.files.map((f) => f.path), writableDirs: plan.writableDirs };
  const profile = evaluateProfile("verification", { runtime: "claude-code", provider: "anthropic", model: options.model ?? "claude-sonnet-5-5", effort: options.effort ?? "medium" }, {});
  if (!profile.ok) return fail(profile.blocker.message);
  const authority = authorityFor(l, { role });
  const identity: AssignmentIdentity = { workspace: newId("ws"), project: newId("prj"), run: newId("run"), task: newId("task"), assignment: newId("asg"), attempt: newId("att"), generation: 1, role };
  const briefFile = path.join(l.output, "brief.md");
  writeFileSync(briefFile, options.brief ?? "# Verification brief\nNo task.\n", { mode: 0o600 });
  const sessionId = randomUUID();
  const launch = adapter.buildLaunch({ identity, profile: profile.value, authority, install: install.value, projection, briefFile, resultFile: path.join(l.output, "result.json"), sessionId });
  if (!launch.ok) return fail(`the production launch plan was refused: ${launch.blocker.message}`);
  const deps = await resolveDependencies(launch.value.argv[0]!, [...install.value.installRoots, ...launch.value.readRoots]);
  if (deps.missing.length) return fail(`${deps.missing.length} runtime dependencies could not be resolved narrowly`);
  const generated = generateProfile({ authority, dependencies: { readRoots: deps.readRoots, readFiles: [...deps.readFiles, ...(launch.value.readFiles ?? [])] }, credentialDir: dir, denyRead: [...personalCredentialStores(), l.state, l.secret], gitPointer: path.join(l.worktree, ".git") });
  if (!generated.ok) return fail(`profile generation refused: ${generated.blocker.message}`);
  const profileFile = path.join(l.root, "worker.sb");
  writeFileSync(profileFile, generated.value.text);
  const credentialFile = plan.files[0]!.path;
  return { ok: true, value: { l, sessionId, model: profile.value.model, tools: launch.value.tools, argv: launch.value.argv, version: install.value.version, argv0: launch.value.argv[0]!, env: launch.value.env, cwd: launch.value.cwd, profileFile, credentialFile, credentialHash: sha(readFileSync(credentialFile, "utf8")), sourceFingerprint: record.value.fingerprint } };
}

export function runContained(f: ClaudeFixture, argv: string[], timeoutMs = 60_000) {
  return spawnSync("/usr/bin/sandbox-exec", ["-f", f.profileFile, "--", ...argv], { cwd: f.cwd, env: f.env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
}

/** Non-secret fields of `claude auth status --json`. */
export function statusFields(stdout: string): Record<string, string> {
  try {
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const key of STATUS_FIELDS) if (key in parsed && ["string", "boolean"].includes(typeof parsed[key])) out[key] = String(parsed[key]);
    return out;
  } catch {
    return {};
  }
}

function homeSnapshot(): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  for (const name of [".claude.json", ".claude"]) {
    const file = path.join(os.homedir(), name);
    out[name] = existsSync(file) ? statSync(file).mtimeMs : undefined;
  }
  return out;
}

export interface Tier2Report {
  results: CheckResult[];
  /** Non-secret login facts for the billing review (Tier 3 confirmation). */
  login: Record<string, string>;
}

export async function runTier2(): Promise<Tier2Report> {
  const fixture = await claudeFixture();
  if (!fixture.ok) {
    const details = [`FAIL ${fixture.reason}`];
    return { results: [{ capability: "runtime.claude-code.contained-launch", passed: false, details }, { capability: "credential.claude-code.non-refreshing-access", passed: false, details }], login: {} };
  }
  const f = fixture.value;
  try {
    const before = homeSnapshot();
    const version = runContained(f, [f.argv0, "--version"]);
    const versionOk = version.status === 0 && version.stdout.includes(f.version);
    const status = runContained(f, [f.argv0, "auth", "status", "--json"]);
    const login = statusFields(status.stdout ?? "");
    const loggedIn = status.status === 0 && login.loggedIn === "true";
    const keychain = runContained(f, ["/usr/bin/security", "find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE]);
    const keychainDenied = keychain.status !== 0;
    const writeHome = runContained(f, ["/bin/sh", "-c", `echo x > "${path.join(os.homedir(), ".radian-verify-probe")}"`]);
    const homeDenied = writeHome.status !== 0 && !existsSync(path.join(os.homedir(), ".radian-verify-probe"));
    const after = homeSnapshot();
    const homeUntouched = JSON.stringify(before) === JSON.stringify(after);
    const projectionUnchanged = sha(readFileSync(f.credentialFile, "utf8")) === f.credentialHash;
    const writeCredential = runContained(f, ["/bin/sh", "-c", `echo x > "${f.credentialFile}"`]);
    const credentialWriteDenied = writeCredential.status !== 0 && sha(readFileSync(f.credentialFile, "utf8")) === f.credentialHash;
    const reread = await claudeKeychainSource(CLAUDE_KEYCHAIN_SERVICE).read();
    const keychainUnchanged = reread.ok && reread.value.fingerprint === f.sourceFingerprint;
    const firstLine = (s: string | undefined) => (s ?? "").trim().split("\n")[0]?.slice(0, 160) ?? "";
    return {
      login,
      results: [
        {
          capability: "runtime.claude-code.contained-launch",
          passed: versionOk && homeDenied && homeUntouched,
          details: [
            `${versionOk ? "ok  " : "FAIL"} Claude Code ${f.version} starts under the worker profile${versionOk ? "" : ` (exit ${version.status}: ${firstLine(version.stderr)})`}`,
            `${homeDenied ? "ok  " : "FAIL"} the worker cannot write the home directory`,
            `${homeUntouched ? "ok  " : "FAIL"} the personal Claude Code config (~/.claude, ~/.claude.json) was not touched`,
          ],
        },
        {
          capability: "credential.claude-code.non-refreshing-access",
          passed: loggedIn && keychainDenied && projectionUnchanged && credentialWriteDenied && keychainUnchanged,
          details: [
            `${loggedIn ? "ok  " : "FAIL"} Claude Code is logged in from the scoped, read-only copy${loggedIn ? "" : ` (exit ${status.status}: ${firstLine(status.stderr) || firstLine(status.stdout)})`}`,
            `${keychainDenied ? "ok  " : "FAIL"} the worker cannot query the Keychain`,
            `${credentialWriteDenied ? "ok  " : "FAIL"} the worker cannot modify its credential copy`,
            `${projectionUnchanged ? "ok  " : "FAIL"} the credential copy was not changed (no refresh written)`,
            `${keychainUnchanged ? "ok  " : "FAIL"} the Keychain login is unchanged after the run`,
          ],
        },
      ],
    };
  } finally {
    rmSync(path.join(f.l.root, "projection"), { recursive: true, force: true });
    cleanup(f.l);
  }
}
