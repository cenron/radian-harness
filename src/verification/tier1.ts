// Tier 1 capability checks: the native boundary and independent supervision
// on this machine, with Radian's production profile generator, dependency
// resolver, watcher, and termination code. No model call, no credential, no
// existing pane. Each check returns PASS/FAIL with sanitized sub-check lines.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { newId } from "../contracts/identity.ts";
import { isWithin } from "../contracts/paths.ts";
import { resolveDependencies } from "../isolation/dependencies.ts";
import { systemProcessOps } from "../isolation/processes.ts";
import { generateProfile } from "../isolation/profile.ts";
import { SupervisionRegistry } from "../isolation/registry.ts";
import { SupervisionClient } from "../isolation/supervision.ts";
import { terminateOwned } from "../isolation/terminate.ts";
import { lossFile } from "../isolation/watcher.ts";
import { createClaudeAdapter } from "../runtimes/claude.ts";
import { psProbe } from "../util/process-identity.ts";
import { type CheckResult, type VerifyLayout, authorityFor, cleanup, contained, expectations, verifyLayout } from "./harness.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

function profileFor(l: VerifyLayout, options: Parameters<typeof authorityFor>[1] = {}, extra: { readRoots?: readonly string[]; readFiles?: readonly string[]; denyRead?: readonly string[] } = {}): string {
  const projection = path.join(l.root, "projection");
  mkdirSync(projection, { recursive: true });
  const profile = generateProfile({
    authority: authorityFor(l, options),
    dependencies: { readRoots: [...(extra.readRoots ?? [])], readFiles: [...(extra.readFiles ?? [])] },
    credentialDir: projection,
    denyRead: [l.secret, l.state, ...(extra.denyRead ?? [])],
    gitPointer: path.join(l.worktree, ".git"),
  });
  if (!profile.ok) throw new Error(`profile generation refused: ${profile.blocker.message}`);
  return profile.value.text;
}

async function withLayout(run: (l: VerifyLayout) => Promise<CheckResult> | CheckResult): Promise<CheckResult> {
  const l = verifyLayout();
  try {
    return await run(l);
  } finally {
    cleanup(l);
  }
}

export function checkFilesystem(): Promise<CheckResult> {
  return withLayout((l) => {
    const text = profileFor(l);
    const projection = path.join(l.root, "projection");
    writeFileSync(path.join(projection, "auth.json"), '{"synthetic":"projected"}\n');
    symlinkSync(l.outside, path.join(l.worktree, "src", "escape"));
    symlinkSync(path.join(l.secret, "token.json"), path.join(l.worktree, "src", "secret-link"));
    const { passed, details } = expectations((s) => contained(text, l, s), [
      ["read task input", "cat src/input.txt", true],
      ["write task file", "echo ok > src/out.txt", true],
      ["write output", `echo ok > "${l.output}/report.md"`, true],
      ["write scratch", `echo ok > "${l.scratch}/tmp.txt"`, true],
      ["read projected credential", `cat "${projection}/auth.json"`, true],
      ["write projected credential", `echo x > "${projection}/auth.json"`, false],
      ["read personal credential", `cat "${l.secret}/token.json"`, false],
      ["read personal credential via symlink", "cat src/secret-link", false],
      ["write shared Git config", `echo x >> "${l.gitDir}/config"`, false],
      ["create Git hook", `mkdir -p "${l.gitDir}/hooks" && echo x > "${l.gitDir}/hooks/pre-commit"`, false],
      ["rewrite worktree Git pointer", "echo gitdir: /tmp > .git", false],
      ["write coordinator state", `echo x > "${l.state}/approval.json"`, false],
      ["write outside", `echo x > "${l.outside}/x"`, false],
      ["write outside via symlink", "echo x > src/escape/x", false],
      ["write outside task write roots", "echo x > README.md", false],
      ["child process write outside", `/bin/sh -c 'echo x > "${l.outside}/child"'`, false],
      ["read home directory listing contents", `cat "${os.homedir()}/.zshrc" 2>/dev/null || cat "${os.homedir()}/.bash_profile"`, false],
    ]);
    const untouched = readFileSync(path.join(l.gitDir, "config"), "utf8") === "[core]\n" && !existsSync(path.join(l.outside, "x")) && !existsSync(path.join(l.outside, "child"));
    if (!untouched) details.push("FAIL protected files changed on disk");
    return { capability: "containment.sandbox-exec.filesystem", passed: passed && untouched, details };
  });
}

export function checkSignals(): Promise<CheckResult> {
  return withLayout(async (l) => {
    const text = profileFor(l);
    const victim = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
    try {
      await sleep(100);
      const { passed, details } = expectations((s) => contained(text, l, s), [
        ["probe another process (kill -0)", `kill -0 ${victim.pid}`, false],
        ["terminate another process", `kill -TERM ${victim.pid}`, false],
        ["signal its own child", "/bin/sleep 5 & kill $!", true],
      ]);
      const alive = psProbe(victim.pid!).state === "running";
      details.push(`${alive ? "ok  " : "FAIL"} the other process is still running`);
      return { capability: "containment.sandbox-exec.process-signals", passed: passed && alive, details };
    } finally {
      try {
        process.kill(victim.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
}

export function checkNetwork(): Promise<CheckResult> {
  return withLayout(async (l) => {
    const owned = await freePort();
    const other = await freePort();
    const text = profileFor(l, { ports: [owned], operations: ["read", "edit", "shell", "run-checks", "start-local-services", "network-outbound", "write-report"] });
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const target = (server.address() as net.AddressInfo).port;
    try {
      const listen = (port: number) => `/usr/bin/nc -l 127.0.0.1 ${port} >/dev/null 2>&1 & p=$!; /bin/sleep 1; kill -0 $p; s=$?; kill $p 2>/dev/null; exit $s`;
      const { passed, details } = expectations((s) => contained(text, l, s), [
        ["outbound TCP connection", `/usr/bin/nc -z -w 3 127.0.0.1 ${target}`, true],
        ["listen on its owned local port", listen(owned), true],
        ["listen on another local port", listen(other), false],
      ]);
      details.push("note: ordinary outbound networking is allowed by the approved policy; no destination isolation is claimed");
      return { capability: "containment.sandbox-exec.network-outbound", passed, details };
    } finally {
      server.close();
    }
  });
}

const SENSITIVE = [".ssh", "Library/Keychains", ".claude", ".claude.json", ".pi", ".codex", ".aws", ".gnupg", ".config", ".netrc", "Library/Application Support", "Library/Cookies"];

export function checkDependencyAccess(): Promise<CheckResult> {
  return withLayout(async (l) => {
    const details: string[] = [];
    const install = await createClaudeAdapter().detect();
    if (!install.ok) return { capability: "containment.dependency-access-audit", passed: false, details: [`FAIL Claude Code was not detected: ${install.blocker.message}`] };
    const deps = await resolveDependencies(install.value.executable, install.value.installRoots);
    let passed = true;
    if (deps.missing.length > 0) {
      passed = false;
      details.push(`FAIL ${deps.missing.length} runtime dependencies could not be resolved narrowly`);
    } else details.push(`ok   ${deps.readRoots.length} read roots and ${deps.readFiles.length} files resolved for Claude Code ${install.value.version}`);
    const home = os.homedir();
    const sensitive = SENSITIVE.map((s) => path.join(home, s));
    for (const root of deps.readRoots) {
      const coversHome = root === home || isWithin(home, root);
      const insideSensitive = sensitive.some((s) => root === s || isWithin(root, s) || isWithin(s, root));
      if (coversHome || insideSensitive) {
        passed = false;
        details.push(`FAIL a dependency read root ${coversHome ? "covers the home directory" : "overlaps a credential/config store"}`);
      }
    }
    const text = profileFor(l, {}, { readRoots: deps.readRoots, readFiles: deps.readFiles });
    const reads = sensitive.filter((s) => existsSync(s)).map((s) => [`read ${s.replace(home, "~")}`, `ls -la "${s}" >/dev/null 2>&1 && cat "${s}" >/dev/null 2>&1 || ls "${s}"/* >/dev/null 2>&1`, false] as const);
    const result = expectations((s) => contained(text, l, s), [["read the Claude Code installation", `ls "${install.value.installRoots[0]}" >/dev/null`, true], ...reads]);
    return { capability: "containment.dependency-access-audit", passed: passed && result.passed, details: [...details, ...result.details] };
  });
}

export async function checkDescendantTermination(): Promise<CheckResult> {
  const l = verifyLayout();
  try {
    const program = 'use POSIX qw(setsid); $|=1; my $pid = fork(); if ($pid == 0) { setsid(); $SIG{TERM}="IGNORE"; print "$$\\n"; sleep 60; exit 0; } print "$$\\n"; sleep 60;';
    const parent = spawn("/usr/bin/perl", ["-e", program], { cwd: l.worktree, stdio: ["ignore", "pipe", "ignore"], detached: true });
    const pids = await new Promise<number[]>((resolve) => {
      let data = "";
      const timer = setTimeout(() => resolve([]), 5_000);
      parent.stdout!.on("data", (chunk) => {
        data += chunk;
        const lines = data.split("\n").filter(Boolean);
        if (lines.length >= 2) {
          clearTimeout(timer);
          resolve(lines.map(Number));
        }
      });
    });
    const state = psProbe(parent.pid!);
    if (pids.length < 2 || state.state !== "running") return { capability: "supervision.descendant-termination", passed: false, details: ["FAIL the detached-child fixture did not start"] };
    const outcome = await terminateOwned(systemProcessOps, { registered: [{ pid: parent.pid!, start: state.start }], ownedRoots: [l.worktree], unresolvedIntents: 0, protectedPids: [process.pid], graceMs: 300 });
    const gone = pids.every((pid) => psProbe(pid).state === "absent");
    for (const pid of pids) if (psProbe(pid).state !== "absent") process.kill(pid, "SIGKILL");
    return {
      capability: "supervision.descendant-termination",
      passed: gone && outcome.postcondition === "verified" && outcome.escalated >= 1,
      details: [`${gone ? "ok  " : "FAIL"} a detached, TERM-ignoring descendant and its parent are gone`, `${outcome.postcondition === "verified" ? "ok  " : "FAIL"} termination postcondition ${outcome.postcondition}`, `${outcome.escalated >= 1 ? "ok  " : "FAIL"} escalated to KILL (${outcome.escalated})`],
    };
  } finally {
    cleanup(l);
  }
}

async function watchedSleeper(stateDir: string) {
  const sleeper = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
  await sleep(100);
  const state = psProbe(sleeper.pid!);
  if (state.state !== "running") throw new Error("the fixture process did not start");
  const assignment = newId("asg");
  const attempt = newId("att");
  await new SupervisionRegistry(stateDir, assignment).append({ kind: "process", attempt, label: "runtime", identity: { pid: sleeper.pid!, start: state.start }, source: "launcher" });
  return { sleeper, state, assignment, attempt };
}

async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

export async function checkIndependentWatcher(): Promise<CheckResult> {
  const l = verifyLayout();
  let pid: number | undefined;
  try {
    const { sleeper, assignment, attempt } = await watchedSleeper(l.state);
    pid = sleeper.pid;
    const client = new SupervisionClient({ stateDir: l.state, leaseMs: 2000, graceMs: 200 });
    const started = await client.start();
    if (!started.ok) return { capability: "supervision.independent-watcher", passed: false, details: [`FAIL the watcher did not start: ${started.blocker.message}`] };
    await client.watch({ assignment, attempt, ownedRoots: [], projectionDirs: [] });
    const healthy = client.health().ok;
    client.dropHeartbeat();
    const stopped = await until(() => psProbe(sleeper.pid!).state !== "running", 10_000);
    const reported = await until(() => existsSync(lossFile(l.state)), 5_000);
    const reason = reported ? (JSON.parse(readFileSync(lossFile(l.state), "utf8")) as { reason?: string }).reason : undefined;
    return {
      capability: "supervision.independent-watcher",
      passed: healthy && stopped && reason === "heartbeat-eof",
      details: [`${healthy ? "ok  " : "FAIL"} the watcher runs as a separate process and reports healthy`, `${stopped ? "ok  " : "FAIL"} owned work stopped after the coordinator heartbeat ended`, `${reason === "heartbeat-eof" ? "ok  " : "FAIL"} loss recorded (${reason ?? "none"})`],
    };
  } finally {
    if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    cleanup(l);
  }
}

export async function checkWatcherLoss(): Promise<CheckResult> {
  const l = verifyLayout();
  let pid: number | undefined;
  try {
    const { sleeper, state, assignment, attempt } = await watchedSleeper(l.state);
    pid = sleeper.pid;
    const client = new SupervisionClient({ stateDir: l.state, leaseMs: 2000, graceMs: 200 });
    const started = await client.start();
    if (!started.ok) return { capability: "supervision.watcher-loss-response", passed: false, details: [`FAIL the watcher did not start: ${started.blocker.message}`] };
    await client.watch({ assignment, attempt, ownedRoots: [], projectionDirs: [] });
    let notified = false;
    client.onLoss(() => (notified = true));
    process.kill(started.value.pid, "SIGKILL");
    const detected = await until(() => notified && !client.health().ok, 5_000);
    // The coordinator's response to a loss: stop owned work with verified termination.
    const outcome = await terminateOwned(systemProcessOps, { registered: [{ pid: sleeper.pid!, start: state.start }], ownedRoots: [], unresolvedIntents: 0, protectedPids: [process.pid], graceMs: 200 });
    const gone = psProbe(sleeper.pid!).state !== "running";
    return {
      capability: "supervision.watcher-loss-response",
      passed: detected && gone && outcome.postcondition === "verified",
      details: [`${detected ? "ok  " : "FAIL"} killing the watcher is detected as a supervision loss`, `${gone && outcome.postcondition === "verified" ? "ok  " : "FAIL"} owned work is stopped with verified termination`],
    };
  } finally {
    if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    cleanup(l);
  }
}

export const TIER1 = [checkFilesystem, checkSignals, checkNetwork, checkDependencyAccess, checkIndependentWatcher, checkDescendantTermination, checkWatcherLoss] as const;
