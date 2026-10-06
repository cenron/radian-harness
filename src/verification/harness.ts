// Capability verification harness: disposable assignment layouts and command
// execution under Radian's production sandbox profile. Used by the
// verification runner and the interactive `/radian capabilities verify`
// command. Checks never record evidence themselves; only the user records
// what passed, through an explicit interactive decision.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAuthority, type ResolvedAuthority } from "../contracts/authority.ts";
import type { Operation } from "../contracts/authority.ts";
import type { CapabilityId } from "../isolation/capabilities.ts";

export interface CheckResult {
  capability: CapabilityId;
  passed: boolean;
  /** Short, sanitized lines describing each sub-check (no credentials, no raw logs). */
  details: string[];
}

export interface VerifyLayout {
  root: string;
  project: string;
  gitDir: string;
  worktree: string;
  output: string;
  scratch: string;
  state: string;
  secret: string;
  outside: string;
}

/** A disposable layout under the system temporary directory (removed by `cleanup`). */
export function verifyLayout(): VerifyLayout {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "radian-verify-")));
  const l: VerifyLayout = {
    root,
    project: path.join(root, "project"),
    gitDir: path.join(root, "project", ".git"),
    worktree: path.join(root, "worktrees", "a1"),
    output: path.join(root, "exchange", "a1"),
    scratch: path.join(root, "scratch", "a1"),
    state: path.join(root, "state"),
    secret: path.join(root, "personal-credentials"),
    outside: path.join(root, "outside"),
  };
  for (const dir of [l.gitDir, path.join(l.worktree, "src"), l.output, l.scratch, l.state, l.secret, l.outside]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(l.gitDir, "config"), "[core]\n");
  writeFileSync(path.join(l.secret, "token.json"), '{"synthetic": true}\n');
  writeFileSync(path.join(l.worktree, "src", "input.txt"), "task input\n");
  writeFileSync(path.join(l.worktree, ".git"), `gitdir: ${l.gitDir}/worktrees/a1\n`);
  return l;
}

export function cleanup(l: VerifyLayout): void {
  rmSync(l.root, { recursive: true, force: true });
}

export const DEVELOPER_OPS: Operation[] = ["read", "edit", "shell", "run-checks", "install-locked-dependencies", "deliver-changes", "write-report", "network-outbound"];

export function authorityFor(l: VerifyLayout, options: { role?: "developer" | "reviewer"; ports?: number[]; operations?: Operation[] } = {}): ResolvedAuthority {
  const role = options.role ?? "developer";
  const operations = options.operations ?? (role === "reviewer" ? (["read", "git-inspect", "write-report"] as Operation[]) : DEVELOPER_OPS);
  const a = resolveAuthority(
    {
      role,
      worktree: l.worktree,
      readRoots: [l.project],
      writeRoots: role === "reviewer" ? [] : [path.join(l.worktree, "src")],
      outputDir: l.output,
      scratchDir: l.scratch,
      operations,
      ...(options.ports ? { ports: options.ports } : {}),
    },
    { projectRoot: l.project, protectedPaths: [l.gitDir, l.state] },
  );
  if (!a.ok) throw new Error(`verification layout authority: ${a.blocker.message}`);
  return a.value;
}

/** Run a shell script under a generated profile; returns the exit status (null on timeout/signal). */
export function contained(profileText: string, l: VerifyLayout, script: string, timeoutMs = 15_000): number | null {
  const file = path.join(l.root, "profile.sb");
  writeFileSync(file, profileText);
  const result = spawnSync("/usr/bin/sandbox-exec", ["-f", file, "/bin/sh", "-c", script], { cwd: l.worktree, env: { PATH: "/usr/bin:/bin", HOME: l.scratch, TMPDIR: l.scratch }, timeout: timeoutMs });
  return result.status;
}

export const nativeAvailable = (): boolean => process.platform === "darwin" && spawnSync("/bin/test", ["-x", "/usr/bin/sandbox-exec"]).status === 0;

/** Evaluate an expectation list; every line records allowed/denied as expected or not. */
export function expectations(run: (script: string) => number | null, checks: ReadonlyArray<readonly [string, string, boolean]>): { passed: boolean; details: string[] } {
  const details: string[] = [];
  let passed = true;
  for (const [name, script, allowed] of checks) {
    const status = run(script);
    const ok = (status === 0) === allowed;
    if (!ok) passed = false;
    details.push(`${ok ? "ok  " : "FAIL"} ${name}: expected ${allowed ? "allowed" : "denied"}, ${status === 0 ? "allowed" : "denied"}`);
  }
  return { passed, details };
}
