#!/usr/bin/env python3
"""Offline proof of Pi's public injectable read-only CredentialStore contract.

Synthetic OAuth only; networking denied; no prompt or model inference.
Not a CLI adapter and not a shared-refresh ownership implementation.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    if sys.platform != "darwin" or not shutil.which("pi") or not Path("/usr/bin/sandbox-exec").exists():
        print("SKIP: requires macOS, sandbox-exec and installed Pi")
        return 77
    spec = importlib.util.spec_from_file_location("pi_task_probe", Path(__file__).with_name("macos-pi-task.py"))
    helper = importlib.util.module_from_spec(spec)
    original_bytecode = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        spec.loader.exec_module(helper)
    finally:
        sys.dont_write_bytecode = original_bytecode
    pi = Path(shutil.which("pi")).resolve()
    roots, files = helper.dependency_reads(pi)
    package = pi.parent.parent / "libexec/lib/node_modules/@earendil-works/pi-coding-agent"
    launcher = pi.parent.parent / "libexec/bin/pi"
    with launcher.open() as handle:
        shebang = handle.readline().strip()
    if not shebang.startswith("#!/") or " " in shebang[2:] or not (package / "dist/index.js").is_file():
        print("SKIP: unrecognized installed Pi layout")
        return 77
    node = Path(shebang[2:]).resolve()
    root = Path(tempfile.mkdtemp(prefix="radian-pi-auth-store.", dir="/tmp")).resolve()
    success = False
    try:
        (root / "home").mkdir()
        script = root / "probe.mjs"
        script.write_text(f'import {{ ModelRuntime }} from {json.dumps((package / "dist/index.js").as_uri())};\n' + '''
let modifies = 0;
let expired = false;
const credential = () => ({
  type: "oauth", access: "synthetic-access-not-a-token", refresh: "synthetic-refresh-not-a-token",
  clientId: "synthetic-client", expires: expired ? 0 : Date.now() + 3600000,
});
// Implements the exported CredentialStore interface; no private Pi class imports.
const credentials = {
  async read(provider) { return provider === "openai" ? credential() : undefined; },
  async list() { return [{ providerId: "openai", type: "oauth" }]; },
  async modify(provider, callback) {
    modifies++;
    // Never call the callback: it owns the provider's remote refresh operation.
    throw new Error("synthetic read-only store forbids mutation");
  },
  async delete() { throw new Error("synthetic read-only store forbids mutation"); },
};
const runtime = await ModelRuntime.create({
  credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  modelsStorePath: process.env.HOME + "/catalog.json",
});
const fresh = await runtime.getAuth("openai");
if (!fresh || fresh.source !== "OAuth" || modifies !== 0) throw new Error("fresh resolution failed");
console.log("PASS fresh_synthetic_oauth_without_store_writes");
expired = true;
let refused = false;
try { await runtime.getAuth("openai"); }
catch (error) { refused = String(error.message).includes("Credential store modify failed"); }
if (!refused || modifies !== 1) throw new Error("expired refusal failed");
console.log("PASS expired_synthetic_oauth_refused_before_refresh_callback");
''')
        q = lambda p: json.dumps(str(p))
        rules = ["(version 1)", "(deny default)", "(allow process-exec)", "(allow process-fork)",
                 "(allow sysctl-read)", "(allow file-read-metadata)",
                 '(allow file-read* (literal "/") (literal "/private") (literal "/private/tmp"))',
                 '(allow file-read* (literal "/private/etc/ssl/openssl.cnf") (literal "/private/etc/ssl/cert.pem"))',
                 '(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
                 '(allow file-write* (literal "/dev/null"))']
        reads = roots | {root} | {Path(p) for p in ("/System", "/usr", "/bin", "/sbin", "/Library")}
        rules += [f"(allow file-read* (subpath {q(p)}))" for p in sorted(reads)]
        rules += [f"(allow file-read* (literal {q(p)}))" for p in sorted(files)]
        rules += [f"(allow file-write* (subpath {q(root / 'home')}))"]
        profile = root / "probe.sb"
        profile.write_text("\n".join(rules) + "\n")
        env = {"PATH": "/usr/bin:/bin", "HOME": str(root / "home"),
               "PI_CODING_AGENT_DIR": str(root / "home"), "PI_OFFLINE": "1", "PI_TELEMETRY": "0"}
        result = subprocess.run(["/usr/bin/sandbox-exec", "-f", str(profile), str(node), str(script)],
                                cwd=root, env=env, capture_output=True, timeout=30)
        (root / "stdout").write_bytes(result.stdout)
        (root / "stderr").write_bytes(result.stderr)
        expected = ["PASS fresh_synthetic_oauth_without_store_writes",
                    "PASS expired_synthetic_oauth_refused_before_refresh_callback"]
        success = result.returncode == 0 and result.stdout.decode().splitlines() == expected
        for line in expected:
            print(line if success else line.replace("PASS", "FAIL", 1))
        return 0 if success else 1
    finally:
        if success and os.environ.get("RADIAN_KEEP_FIXTURE") != "1":
            shutil.rmtree(root)
        else:
            Path("/tmp/radian-last-pi-auth-store-fixture").write_text(str(root) + "\n")
            print("Synthetic diagnostics retained outside repository.")


if __name__ == "__main__":
    raise SystemExit(main())
