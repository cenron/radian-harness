import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CapabilityRegistry, requiredCapabilities, type CapabilityContext } from "../../../src/isolation/capabilities.ts";
import { resolveDependencies, shebangInterpreter } from "../../../src/isolation/dependencies.ts";
import { PROFILE_TEMPLATE_VERSION, diagnoseAccess, generateProfile } from "../../../src/isolation/profile.ts";
import { HumanChannel } from "../../../src/state/approvals.ts";
import { removeDir, tempDir } from "../helpers/fixture.ts";
import { authorityFor, layout, type Layout } from "../helpers/layout.ts";

const native = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const nativeSkip = native ? false : "requires macOS sandbox-exec";

test("profile: deny-default, protected denies after allows, unsafe input refused", () => {
  const l = layout();
  try {
    const authority = authorityFor(l);
    const profile = generateProfile({ authority, dependencies: { readRoots: [], readFiles: [] }, denyRead: [l.secret], gitPointer: path.join(l.worktree, ".git") });
    assert.ok(profile.ok);
    if (!profile.ok) return;
    const text = profile.value.text;
    assert.match(text, /^\(version 1\)/);
    assert.ok(text.includes("(deny default)"));
    assert.ok(text.indexOf(`(deny file-write* (subpath "${l.gitDir}"))`) > text.indexOf(`(allow file-write* (subpath "${path.join(l.worktree, "src")}"))`));
    assert.ok(text.includes(`(deny file-read* file-write* (subpath "${l.secret}"))`));
    assert.ok(text.includes('(allow network-outbound (remote ip "*:*"))'));
    assert.ok(!text.includes("network-bind"), "no ports were granted");
    assert.ok(!text.includes("mach-lookup"), "no Mach services (for example Keychain) are granted");
    assert.match(profile.value.hash, /^sha256:/);
    const bad = generateProfile({ authority: { ...authority, writeRoots: [l.root + '/x"y'] }, dependencies: { readRoots: [], readFiles: [] } });
    assert.equal(bad.ok ? "ok" : bad.blocker.code, "PATH_INVALID");
    const inside = generateProfile({ authority: { ...authority, writeRoots: [path.join(l.gitDir, "hooks")] }, dependencies: { readRoots: [], readFiles: [] } });
    assert.equal(inside.ok ? "ok" : inside.blocker.code, "POLICY_TAMPERED");
    const tty = generateProfile({ authority, dependencies: { readRoots: [], readFiles: [] }, terminal: "/dev/ttys*" });
    assert.equal(tty.ok ? "ok" : tty.blocker.code, "PATH_INVALID");
    const ports = generateProfile({ authority: { ...authority, ports: [43123] }, dependencies: { readRoots: [], readFiles: [] } });
    assert.ok(ports.ok && ports.value.text.includes('localhost:43123'));
  } finally {
    removeDir(l.root);
  }
});

function contained(profileText: string, l: Layout, script: string): number | null {
  const file = path.join(l.root, "profile.sb");
  writeFileSync(file, profileText);
  const result = spawnSync("/usr/bin/sandbox-exec", ["-f", file, "/bin/sh", "-c", script], { cwd: l.worktree, env: { PATH: "/usr/bin:/bin", HOME: l.scratch, TMPDIR: l.scratch }, timeout: 15_000 });
  return result.status;
}

test("native boundary: scoped reads/writes, protected state, credentials, symlinks, children", { skip: nativeSkip }, () => {
  const l = layout();
  try {
    const authority = authorityFor(l);
    const projection = path.join(l.root, "projection");
    mkdirSync(projection);
    writeFileSync(path.join(projection, "auth.json"), '{"synthetic":"projected"}\n');
    const profile = generateProfile({ authority, dependencies: { readRoots: [], readFiles: [] }, credentialDir: projection, denyRead: [l.secret], gitPointer: path.join(l.worktree, ".git") });
    assert.ok(profile.ok);
    if (!profile.ok) return;
    symlinkSync(l.outside, path.join(l.worktree, "src", "escape"));
    symlinkSync(path.join(l.secret, "token.json"), path.join(l.worktree, "src", "secret-link"));
    const checks: Array<[string, string, boolean]> = [
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
    ];
    for (const [name, script, allowed] of checks) {
      const status = contained(profile.value.text, l, script);
      assert.equal(status === 0, allowed, `${name}: expected ${allowed ? "allowed" : "denied"}`);
    }
    assert.equal(readFileSync(path.join(projection, "auth.json"), "utf8"), '{"synthetic":"projected"}\n');
    assert.equal(readFileSync(path.join(l.gitDir, "config"), "utf8"), "[core]\n");
    assert.ok(!existsSync(path.join(l.outside, "x")) && !existsSync(path.join(l.outside, "child")));
  } finally {
    removeDir(l.root);
  }
});

test("dependency resolution: explicit files, interpreters, and honest missing entries", async () => {
  const dir = tempDir();
  try {
    const node = await resolveDependencies(process.execPath);
    assert.deepEqual(node.missing, []);
    assert.ok(node.readFiles.length >= 1);
    const script = path.join(dir, "tool");
    writeFileSync(script, "#!/nonexistent/interpreter\n", { mode: 0o755 });
    assert.equal(shebangInterpreter(script), "/nonexistent/interpreter");
    const broken = await resolveDependencies(script);
    assert.ok(broken.missing.includes("/nonexistent/interpreter"));
    const absent = await resolveDependencies(path.join(dir, "absent"));
    assert.equal(absent.missing.length, 1);
    const system = await resolveDependencies("/bin/sh");
    assert.deepEqual(system.missing, []);
  } finally {
    removeDir(dir);
  }
});

test("capabilities: unverified by default, human-recorded evidence bound to versions", async () => {
  const dir = tempDir();
  try {
    const registry = new CapabilityRegistry(dir);
    const context: CapabilityContext = { osVersion: "27.0", runtime: "pi", runtimeVersion: "1.0.2", policyTemplate: PROFILE_TEMPLATE_VERSION };
    const required = requiredCapabilities("pi", "developer");
    assert.ok(required.includes("runtime.pi.cancellation") && required.includes("credential.pi.non-refreshing-access") && required.includes("billing.pi.subscription-path"));
    const denied = registry.require(required, context);
    assert.equal(denied.ok ? "ok" : denied.blocker.code, "CAPABILITY_UNVERIFIED");
    const forged = Object.create(HumanChannel.prototype) as HumanChannel;
    const refused = await registry.record(forged, { capability: "runtime.pi.cancellation", status: "verified", context, reference: "x" });
    assert.equal(refused.ok ? "ok" : refused.blocker.code, "APPROVAL_NOT_HUMAN");
    const human = HumanChannel.fromUserInput("user-command", "fixture-user", "/radian capability");
    for (const capability of required) assert.ok((await registry.record(human, { capability, status: "verified", context, reference: "synthetic fixture" })).ok);
    assert.ok(registry.require(required, context).ok);
    const upgraded = registry.require(required, { ...context, runtimeVersion: "1.0.3" });
    assert.equal(upgraded.ok ? "ok" : upgraded.blocker.code, "CAPABILITY_UNVERIFIED");
    await registry.record(human, { capability: "runtime.pi.cancellation", status: "failed", context, reference: "regression" });
    assert.equal(registry.status("runtime.pi.cancellation", context).state, "failed");
  } finally {
    removeDir(dir);
  }
});

test("denied-action diagnostics name stable rules and safe alternatives", () => {
  const l = layout();
  try {
    const authority = authorityFor(l);
    const input = { authority, dependencies: { readRoots: [], readFiles: [] }, denyRead: [l.secret], gitPointer: path.join(l.worktree, ".git") };
    assert.equal(diagnoseAccess(input, path.join(l.gitDir, "config"), "write").rule, "RH-DENY-PROTECTED");
    assert.equal(diagnoseAccess(input, path.join(l.secret, "token.json"), "read").rule, "RH-DENY-CREDENTIAL");
    assert.equal(diagnoseAccess(input, path.join(l.worktree, ".git"), "write").rule, "RH-DENY-GIT-POINTER");
    assert.equal(diagnoseAccess(input, path.join(l.worktree, "src", "a.ts"), "write").allowed, true);
    assert.equal(diagnoseAccess(input, path.join(l.worktree, "README.md"), "write").rule, "RH-DENY-OUTSIDE-SCOPE");
    assert.equal(diagnoseAccess(input, path.join(l.outside, "x"), "read").allowed, false);
  } finally {
    removeDir(l.root);
  }
});
