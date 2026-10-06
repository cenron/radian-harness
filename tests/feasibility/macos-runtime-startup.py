#!/usr/bin/env python3
"""Offline CLI probes in disposable homes; not a production runtime adapter."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile


def sb_string(value):
    return json.dumps(str(value))


def run_bounded(argv, cwd, env, seconds=30):
    # Only this test's newly created process group may be signalled.
    process = subprocess.Popen(
        argv, cwd=cwd, env=env, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=seconds)
        return process.returncode, stdout, stderr
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        return 124, stdout, stderr


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--real-auth", choices=("pi", "codex", "claude"), help="Opt-in local readiness check; no refresh/model calls or credential output")
    parser.add_argument("--provider", help="Explicit Pi provider to project; required with --real-auth pi")
    parser.add_argument("--keychain-service", help="Explicit Claude credential service; required with --real-auth claude")
    args = parser.parse_args()
    if args.real_auth == "pi" and not args.provider:
        parser.error("--real-auth pi requires an explicit --provider")
    if args.real_auth == "claude" and not args.keychain_service:
        parser.error("--real-auth claude requires an explicit --keychain-service; do not guess alternate services")
    if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists():
        print("SKIP: requires macOS and sandbox-exec")
        return 77
    binaries = {}
    for name in ("pi", "codex", "claude"):
        found = shutil.which(name)
        if not found:
            print(f"SKIP: {name} is not installed")
            return 77
        binaries[name] = Path(found).resolve()

    install_roots = set()
    library_files = set()
    dependency_queue = list(binaries.values())
    for binary in binaries.values():
        install_roots.add(binary.parent.parent if binary.parent.name == "bin" else binary.parent)
    # The inspected Homebrew Pi distribution uses a pinned Node shebang rather
    # than the shell's node. Resolve just that launcher, without reading auth.
    pi_root = binaries["pi"].parent.parent
    pi_launcher = pi_root / "libexec/bin/pi"
    if pi_launcher.exists():
        with pi_launcher.open() as handle:
            shebang = handle.readline().strip()
        if shebang.startswith("#!/") and " " not in shebang[2:]:
            interpreter = Path(shebang[2:]).resolve()
            install_roots.add(interpreter.parent.parent)
            dependency_queue.append(interpreter)

    # Resolve transitive absolute dylib dependencies from installed executables.
    # Grant the actual libraries, not the entire Homebrew prefix or user home.
    inspected = set()
    while dependency_queue:
        binary = dependency_queue.pop()
        if binary in inspected or not binary.is_file():
            continue
        inspected.add(binary)
        result = subprocess.run(["/usr/bin/otool", "-L", str(binary)], capture_output=True, text=True, timeout=10)
        if result.returncode:
            continue
        load_commands = subprocess.run(["/usr/bin/otool", "-l", str(binary)], capture_output=True, text=True, timeout=10)
        rpaths = re.findall(r"cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset", load_commands.stdout)
        for line in result.stdout.splitlines()[1:]:
            library = line.strip().split(" (", 1)[0]
            if library.startswith("@loader_path/"):
                path = binary.parent / library.removeprefix("@loader_path/")
            elif library.startswith("/"):
                path = Path(library)
            elif library.startswith("@rpath/"):
                candidates = []
                for rpath in rpaths:
                    if rpath.startswith("@loader_path/"):
                        base = binary.parent / rpath.removeprefix("@loader_path/")
                    elif rpath.startswith("/"):
                        base = Path(rpath)
                    else:
                        continue
                    candidate = base / library.removeprefix("@rpath/")
                    if candidate.exists():
                        candidates.append(candidate)
                for candidate in candidates:
                    library_files.update((candidate, candidate.resolve()))
                    dependency_queue.append(candidate.resolve())
                continue
            else:
                # Unresolved inherited/executable rpaths fail closed at launch.
                continue
            library_files.update((path, path.resolve()))
            if path.exists() and not str(path).startswith(("/usr/", "/System/")):
                dependency_queue.append(path.resolve())

    # Homebrew OpenSSL reads this global library configuration at startup.
    # Allow only the config file, not its directory or arbitrary host config.
    for library in list(library_files):
        parts = library.parts
        if "Cellar" in parts and "openssl@3" in parts:
            prefix = Path(*parts[:parts.index("Cellar")])
            config = prefix / "etc/openssl@3/openssl.cnf"
            if config.is_file():
                library_files.update((config, config.resolve()))

    root = Path(tempfile.mkdtemp(prefix="radian-runtime-feasibility.", dir="/tmp")).resolve()
    for directory in ("work", "home", "tmp", "evidence", "protected"):
        (root / directory).mkdir()
    for directory in ("pi", "codex", "claude", "cache"):
        (root / "home" / directory).mkdir()
    (root / ".fixture-owner").write_text("owned disposable fixture\n")
    (root / "protected/sentinel").write_text("synthetic unrelated data\n")
    env = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": str(root / "home"),
        "TMPDIR": str(root / "tmp"),
        "XDG_CACHE_HOME": str(root / "home/cache"),
        "PI_CODING_AGENT_DIR": str(root / "home/pi"),
        "PI_OFFLINE": "1",
        "PI_TELEMETRY": "0",
        "CODEX_HOME": str(root / "home/codex"),
        "CLAUDE_CONFIG_DIR": str(root / "home/claude"),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "TERM": "dumb",
    }
    read_roots = [Path(p) for p in ("/System", "/usr", "/bin", "/sbin", "/Library")]
    read_roots += sorted(install_roots) + [root / p for p in ("work", "home", "tmp", "evidence")]
    rules = [
        "(version 1)", "(deny default)",
        "(allow process-exec)", "(allow process-fork)",
        "(allow file-read-metadata)", "(allow sysctl-read)",
        '(allow file-read* (literal "/private/etc/ssl/openssl.cnf") (literal "/private/etc/ssl/cert.pem"))',
        '(allow file-read* (literal "/") (literal "/private") (literal "/private/tmp"))',
        '(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
        '(allow file-write* (literal "/dev/null"))',
    ]
    rules += [f"(allow file-read* (subpath {sb_string(p)}))" for p in read_roots]
    rules += [f"(allow file-read* (literal {sb_string(p)}))" for p in sorted(library_files)]
    rules += [f"(allow file-write* (subpath {sb_string(root / p)}))" for p in ("work", "home", "tmp", "evidence")]
    profile = root / "probe.sb"
    profile.write_text("\n".join(rules) + "\n")

    probes = [
        ("pi_version", [str(binaries["pi"]), "--version"]),
        ("codex_version", [str(binaries["codex"]), "--no-daemon", "--version"]),
        ("claude_version", [str(binaries["claude"]), "--version"]),
        ("pi_help", [str(binaries["pi"]), "--offline", "--no-extensions", "--no-skills", "--no-context-files", "--help"]),
        ("codex_help", [str(binaries["codex"]), "--no-daemon", "--help"]),
        ("claude_help", [str(binaries["claude"]), "--restricted", "--tools", "Read,Glob,Grep", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--help"]),
        ("pi_missing_auth", [str(binaries["pi"]), "auth", "check", "--provider", "openai", "--no-refresh", "--json"]),
        ("codex_missing_auth", [str(binaries["codex"]), "--no-daemon", "login", "status"]),
        ("claude_missing_auth", [str(binaries["claude"]), "--restricted", "--setting-sources", "", "auth", "status", "--json"]),
    ]
    results = []
    success = False
    try:
        for name, command in probes:
            code, stdout, stderr = run_bounded(
                ["/usr/bin/sandbox-exec", "-f", str(profile), *command],
                root / "work", env,
            )
            (root / "evidence" / f"{name}.stdout").write_bytes(stdout)
            (root / "evidence" / f"{name}.stderr").write_bytes(stderr)
            passed = code == 0 and bool(stdout.strip())
            if name == "codex_missing_auth":
                passed = code == 1 and b"not logged in" in (stdout + stderr).lower()
            elif name in ("pi_missing_auth", "claude_missing_auth"):
                try:
                    auth = json.loads(stdout)
                except (ValueError, UnicodeDecodeError):
                    auth = {}
                if name == "pi_missing_auth":
                    passed = code == 1 and auth.get("status") == "not_ready"
                else:
                    passed = code in (0, 1) and auth.get("loggedIn") is False
            results.append({"probe": name, "exit": code, "passed": passed})
            suffix = ""
            if passed and name.endswith("_version"):
                version = re.search(r"\b\d+\.\d+\.\d+\b", stdout.decode(errors="replace"))
                if version:
                    suffix = f" version={version.group()}"
            print(f"{'PASS' if passed else 'FAIL'} {name} exit={code}{suffix}")
        # Check the boundary still denies the synthetic unrelated file after
        # granting installation roots. No real credential file is inspected.
        code, stdout, stderr = run_bounded(
            ["/usr/bin/sandbox-exec", "-f", str(profile), "/bin/cat", str(root / "protected/sentinel")],
            root / "work", env,
        )
        passed = code != 0 and code != 124 and not stdout
        results.append({"probe": "protected_read", "exit": code, "passed": passed})
        print(f"{'PASS' if passed else 'FAIL'} protected_read")
        if args.real_auth:
            # The base synthetic probes have no account credentials. Add a
            # runtime-specific grant only for this explicit readiness check.
            # Raw authenticated output is never saved or printed.
            extra_rules = []
            auth_env = dict(env)
            with tempfile.TemporaryDirectory(prefix="radian-auth-readiness.", dir="/tmp") as private_dir:
                private = Path(private_dir).resolve()
                auth_profile = private / "auth.sb"
                if args.real_auth == "pi":
                    source_dir = Path(os.environ.get("PI_CODING_AGENT_DIR", str(Path.home() / ".pi/agent")))
                    stored = json.loads((source_dir / "auth.json").read_text())
                    if args.provider not in stored:
                        raise ValueError("Selected provider has no stored credential; no fallback attempted")
                    if stored[args.provider].get("type") != "oauth":
                        raise ValueError("Subscription OAuth is required; API-key billing is not authorized")
                    agent_dir = private / "pi"
                    agent_dir.mkdir(mode=0o700)
                    fd = os.open(agent_dir / "auth.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, "w") as handle:
                        json.dump({args.provider: stored[args.provider]}, handle)
                    del stored
                    auth_env["PI_CODING_AGENT_DIR"] = str(agent_dir)
                    extra_rules += [f"(allow file-read* (subpath {sb_string(agent_dir)}))", f"(allow file-write* (subpath {sb_string(agent_dir)}))"]
                    command = [str(binaries["pi"]), "auth", "check", "--provider", args.provider, "--no-refresh", "--json"]
                elif args.real_auth == "claude":
                    # The host queries one explicit service. The worker receives
                    # only a private file projection, not securityd/Keychain access.
                    # Never accept a Keychain prompt or try alternate services.
                    secret = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", args.keychain_service, "-w"], capture_output=True, timeout=20)
                    if secret.returncode:
                        raise ValueError("Selected Keychain credential unavailable; no fallback attempted")
                    stored = json.loads(secret.stdout)
                    del secret
                    if not isinstance(stored.get("claudeAiOauth"), dict):
                        raise ValueError("Selected Keychain item is not the expected Claude OAuth shape")
                    config_dir = private / "claude"
                    config_dir.mkdir(mode=0o700)
                    fd = os.open(config_dir / ".credentials.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, "w") as handle:
                        json.dump({"claudeAiOauth": stored["claudeAiOauth"]}, handle)
                    del stored
                    auth_env["CLAUDE_CONFIG_DIR"] = str(config_dir)
                    auth_env["CLAUDE_CODE_TMPDIR"] = str(root / "tmp")
                    extra_rules += [f"(allow file-read* (subpath {sb_string(config_dir)}))", f"(allow file-write* (subpath {sb_string(config_dir)}))"]
                    command = [str(binaries["claude"]), "--restricted", "--setting-sources", "", "auth", "status", "--json"]
                else:
                    source_dir = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
                    source = (source_dir / "auth.json").resolve(strict=True)
                    stored = json.loads(source.read_text())
                    if stored.get("auth_mode") != "chatgpt" or stored.get("OPENAI_API_KEY"):
                        raise ValueError("ChatGPT subscription authentication is required; no API-key fallback")
                    del stored
                    # A symlink grants access to one auth file, not the home or
                    # personal Codex config; host credential writes stay denied.
                    (root / "home/codex/auth.json").symlink_to(source)
                    extra_rules += [f"(allow file-read* (literal {sb_string(source)}))"]
                    command = [str(binaries["codex"]), "--no-daemon", "login", "status"]
                auth_profile.write_text("\n".join(rules + extra_rules) + "\n")
                code, stdout, stderr = run_bounded(["/usr/bin/sandbox-exec", "-f", str(auth_profile), *command], root / "work", auth_env)
                if args.real_auth in ("pi", "claude"):
                    try:
                        status = json.loads(stdout)
                    except (ValueError, UnicodeDecodeError):
                        status = {}
                    if args.real_auth == "pi":
                        passed = code == 0 and status.get("status") == "ready"
                    else:
                        passed = code == 0 and status.get("loggedIn") is True and status.get("authMethod") == "claude.ai"
                else:
                    passed = code == 0 and b"logged in using chatgpt" in (stdout + stderr).lower()
                # Do not retain account metadata, auth output, or the projection.
                del stdout, stderr
                results.append({"probe": args.real_auth + "_real_auth_ready_no_refresh", "exit": code, "passed": passed})
                print(f"{'PASS' if passed else 'FAIL'} {args.real_auth}_real_auth_ready_no_refresh exit={code}")
            if args.real_auth == "codex":
                (root / "home/codex/auth.json").unlink(missing_ok=True)
        (root / "evidence/results.json").write_text(json.dumps(results, indent=2) + "\n")
        success = all(row["passed"] for row in results)
        return 0 if success else 1
    finally:
        # Remove any real-auth symlink even when a check fails; never preserve
        # account access in retained synthetic diagnostic fixtures.
        (root / "home/codex/auth.json").unlink(missing_ok=True)
        if success and os.environ.get("RADIAN_KEEP_FIXTURE") != "1":
            shutil.rmtree(root)
        else:
            # Raw diagnostic paths/content stay outside public project artifacts.
            Path("/tmp/radian-last-runtime-fixture").write_text(str(root) + "\n")
            print("Fixture retained outside repository; raw diagnostics not printed.")


if __name__ == "__main__":
    raise SystemExit(main())
