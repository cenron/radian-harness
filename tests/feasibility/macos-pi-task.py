#!/usr/bin/env python3
"""Opt-in single Pi subscription task in a disposable worktree/Herdr session.

Feasibility only. No installation, fallback, refresh, or personal auth writes.
Sampled descendants are NOT exhaustive process ownership or a production lease.
Known blocker: this CLI locks its credential store during reads; the deliberate
refresh-lock denial currently prevents task startup. Do not relax it to rerun.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid


class Blocked(Exception):
    pass


def identity(pid):
    result = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "pid=,lstart=,command="],
                            capture_output=True, text=True, timeout=3)
    return result.stdout.strip() if result.returncode == 0 else ""


def owned_stop(records):
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid, observed in records.items():
            if observed and identity(pid) == observed:
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass
        time.sleep(0.2)


def sample_descendants(records):
    table = subprocess.run(["/bin/ps", "-axo", "pid=,ppid="], capture_output=True,
                           text=True, timeout=3)
    if table.returncode:
        raise Blocked("process_sampling_failed")
    pairs = [tuple(map(int, line.split())) for line in table.stdout.splitlines() if line.strip()]
    changed = True
    while changed:
        changed = False
        for pid, parent in pairs:
            if parent in records and pid not in records:
                observed = identity(pid)
                if observed:
                    records[pid] = observed
                    changed = True


def controller(root):
    """Outside-boundary fixture controller; no credentials are read here."""
    plan = json.loads((root / "plan.json").read_text())
    records = {}
    child = None
    outcome = {"exit": None, "stop": "unknown", "sampled_processes_absent": False}
    try:
        with (root / "evidence/events.jsonl").open("wb") as out, (root / "evidence/pi.stderr").open("wb") as err:
            child = subprocess.Popen(plan["argv"], cwd=root / "worker", env=plan["env"],
                                     stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                     start_new_session=True)
        records[child.pid] = identity(child.pid)
        (root / "evidence/processes.json").write_text(json.dumps(records))
        start = time.monotonic()
        while child.poll() is None:
            sample_descendants(records)
            (root / "evidence/processes.json").write_text(json.dumps(records))
            if identity(plan["driver_pid"]) != plan["driver_identity"]:
                outcome["stop"] = "driver_lost"
                break
            if time.monotonic() - start > 180:
                outcome["stop"] = "deadline"
                break
            time.sleep(0.1)
        else:
            outcome["stop"] = "exited"
        owned_stop(records)
        child.wait(timeout=5)
        outcome["exit"] = child.returncode
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and any(identity(pid) == observed for pid, observed in records.items() if observed):
            time.sleep(0.1)
        outcome["sampled_processes_absent"] = all(identity(pid) != observed for pid, observed in records.items() if observed)
        return 0 if outcome["sampled_processes_absent"] else 1
    finally:
        owned_stop(records)
        if child is not None:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
        (root / "evidence/controller-result.json").write_text(json.dumps(outcome))
        print("RADIAN_FIXTURE_CONTROLLER_STOPPED", flush=True)


def dependency_reads(pi):
    roots = {pi.parent.parent if pi.parent.name == "bin" else pi.parent}
    queue = [pi]
    launcher = pi.parent.parent / "libexec/bin/pi"
    if launcher.exists():
        with launcher.open() as handle:
            shebang = handle.readline().strip()
        if shebang.startswith("#!/") and " " not in shebang[2:]:
            interpreter = Path(shebang[2:]).resolve()
            roots.add(interpreter.parent.parent)
            queue.append(interpreter)
    files = set()
    inspected = set()
    while queue:
        binary = queue.pop()
        if binary in inspected or not binary.is_file():
            continue
        inspected.add(binary)
        result = subprocess.run(["/usr/bin/otool", "-L", str(binary)], capture_output=True, text=True, timeout=10)
        if result.returncode:
            continue
        commands = subprocess.run(["/usr/bin/otool", "-l", str(binary)], capture_output=True, text=True, timeout=10)
        rpaths = re.findall(r"cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset", commands.stdout)
        for line in result.stdout.splitlines()[1:]:
            library = line.strip().split(" (", 1)[0]
            candidates = []
            if library.startswith("/"):
                candidates = [Path(library)]
            elif library.startswith("@loader_path/"):
                candidates = [binary.parent / library.removeprefix("@loader_path/")]
            elif library.startswith("@rpath/"):
                for rpath in rpaths:
                    base = binary.parent / rpath.removeprefix("@loader_path/") if rpath.startswith("@loader_path/") else Path(rpath)
                    if base.is_absolute():
                        p = base / library.removeprefix("@rpath/")
                        if p.exists():
                            candidates.append(p)
            for p in candidates:
                files.update((p, p.resolve()))
                if p.exists() and not str(p).startswith(("/usr/", "/System/")):
                    queue.append(p.resolve())
    for p in list(files):
        if "Cellar" in p.parts and "openssl@3" in p.parts:
            config = Path(*p.parts[:p.parts.index("Cellar")]) / "etc/openssl@3/openssl.cnf"
            if config.is_file():
                files.update((config, config.resolve()))
    return roots, files


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--controller":
        return controller(Path(sys.argv[2]))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Explicit opt-in to one subscription model task")
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--thinking", required=True, choices=("low", "medium", "high"))
    args = parser.parse_args()
    if not args.live:
        parser.error("Requires --live and user authorization for the stated profile")
    if sys.platform != "darwin" or os.environ.get("HERDR_ENV") != "1":
        print("SKIP: requires macOS and a Herdr-managed caller")
        return 77
    found = {name: shutil.which(name) for name in ("pi", "herdr")}
    if not all(found.values()) or not Path("/usr/bin/sandbox-exec").exists():
        print("SKIP: prerequisites unavailable")
        return 77
    # This first probe intentionally supports only the inspected subscription path.
    if args.provider != "openai" or args.model != "gpt-6.1-sol" or args.thinking != "medium":
        raise Blocked("unvalidated_profile_no_fallback")
    pi = Path(found["pi"]).resolve()
    roots, files = dependency_reads(pi)
    developer = Path(subprocess.check_output(["/usr/bin/xcode-select", "-p"], text=True).strip())
    git = developer / "usr/bin/git"
    if not git.is_file():
        raise Blocked("toolchain_unavailable")
    root = Path(tempfile.mkdtemp(prefix="radian-pi-task-feasibility.", dir="/tmp")).resolve()
    private = Path(tempfile.mkdtemp(prefix="radian-pi-task-auth.", dir="/tmp")).resolve()
    # Darwin Unix-socket paths have a small fixed maximum; keep server HOME short.
    server_home = Path(tempfile.mkdtemp(prefix="rh.", dir="/tmp")).resolve()
    source = Path(os.environ.get("PI_CODING_AGENT_DIR", str(Path.home() / ".pi/agent"))) / "auth.json"
    server = None
    pane = None
    session = "radian-probe-" + uuid.uuid4().hex[:12]
    results = []
    success = False
    source_selected = None
    try:
        for name in ("home", "tmp", "evidence", "resources", "protected", "repo", "server-home"):
            (root / name).mkdir()
        agent = private / "agent"
        agent.mkdir(mode=0o700)
        stored = json.loads(source.read_text())
        selected = stored.get(args.provider)
        if not isinstance(selected, dict) or selected.get("type") != "oauth":
            raise Blocked("subscription_oauth_missing")
        if not isinstance(selected.get("expires"), (int, float)) or selected["expires"] < time.time() * 1000 + 600_000:
            raise Blocked("refresh_required_ownership_unresolved")
        source_selected = selected
        auth = agent / "auth.json"
        fd = os.open(auth, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump({args.provider: selected}, handle)
        del stored
        original_projection = digest(auth)
        (agent / "settings.json").write_text(json.dumps({
            "retry": {"enabled": False, "provider": {"maxRetries": 0, "timeoutMs": 120000}},
            "compaction": {"enabled": False}, "cacheWarming": "off",
            "defaultProjectTrust": "never", "shellPath": "/bin/bash",
        }))
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(root / "home"),
               "TMPDIR": str(root / "tmp"), "PI_CODING_AGENT_DIR": str(agent),
               "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0",
               "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "TERM": "dumb"}

        def fixture_git(*argv):
            return subprocess.run([str(git), "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", *argv],
                                  env=env, capture_output=True, check=True, timeout=10)

        fixture_git("-C", str(root / "repo"), "init", "-q", "-b", "main")
        fixture_git("-C", str(root / "repo"), "config", "user.name", "Fixture")
        fixture_git("-C", str(root / "repo"), "config", "user.email", "fixture@example.com")
        (root / "repo/input.txt").write_text("native-subscription-fixture\n")
        fixture_git("-C", str(root / "repo"), "add", "input.txt")
        fixture_git("-C", str(root / "repo"), "commit", "-q", "-m", "synthetic fixture")
        fixture_git("-C", str(root / "repo"), "worktree", "add", "-q", "-b", "worker", str(root / "worker"))
        policy = root / "resources/policy.txt"
        policy.write_text("Only output.txt may be added. No Git writes or background processes.\n")
        check = root / "resources/check.sh"
        check.write_text('#!/bin/sh\nset -eu\ntest "$(/bin/cat output.txt)" = "NATIVE-SUBSCRIPTION-FIXTURE"\nprintf "CHECK_OK\\n"\n')
        (root / "protected/sentinel").write_text("synthetic protected input\n")
        shared = root / "repo/.git"
        snapshots = {str(p): digest(p) for p in (shared / "config", shared / "refs/heads/main", root / "worker/.git", policy, check)}
        read_roots = roots | {Path(p) for p in ("/System", "/usr", "/bin", "/sbin", "/Library")}
        read_roots |= {developer, root / "worker", root / "home", root / "tmp", root / "resources", shared, agent}
        q = lambda p: json.dumps(str(p))
        rules = ["(version 1)", "(deny default)", "(allow process-exec)", "(allow process-fork)",
                 "(allow sysctl-read)", "(allow file-read-metadata)",
                 '(allow file-read* (literal "/") (literal "/private") (literal "/private/tmp"))',
                 '(allow file-read* (literal "/private/etc/ssl/openssl.cnf") (literal "/private/etc/ssl/cert.pem"))',
                 '(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
                 '(allow file-write* (literal "/dev/null"))',
                 '(allow network-outbound (remote ip "*:*"))',
                 '(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")))']
        rules += [f"(allow file-read* (subpath {q(p)}))" for p in sorted(read_roots)]
        rules += [f"(allow file-read* (literal {q(p)}))" for p in sorted(files)]
        rules += [f"(allow file-write* (subpath {q(root / p)}))" for p in ("worker", "home", "tmp")]
        rules += [f"(allow file-write* (subpath {q(agent)}))",
                  f"(deny file-write* (literal {q(root / 'worker/.git')}))",
                  f"(deny file-write* (literal {q(auth)}))",
                  f"(deny file-write* (subpath {q(str(auth) + '.lock')}))"]
        profile = root / "probe.sb"
        profile.write_text("\n".join(rules) + "\n")

        def contained(command):
            return subprocess.run(["/usr/bin/sandbox-exec", "-f", str(profile), *command],
                                  cwd=root / "worker", env=env, capture_output=True, timeout=15)

        controls = [
            ("task_input_read", ["/bin/cat", "input.txt"], True),
            ("protected_read_denied", ["/bin/cat", str(root / "protected/sentinel")], False),
            ("policy_write_denied", ["/bin/sh", "-c", 'printf forbidden > "$1"', "sh", str(policy)], False),
            ("shared_git_write_denied", ["/bin/sh", "-c", 'printf forbidden > "$1"', "sh", str(shared / "config")], False),
            ("git_pointer_write_denied", ["/bin/sh", "-c", 'printf forbidden > "$1"', "sh", str(root / "worker/.git")], False),
            ("auth_write_denied", ["/bin/sh", "-c", 'printf forbidden > "$1"', "sh", str(auth)], False),
            ("refresh_lock_denied", ["/bin/mkdir", str(auth) + ".lock"], False),
        ]
        for name, command, allowed in controls:
            result = contained(command)
            passed = (result.returncode == 0) == allowed
            if not allowed:
                passed = passed and not result.stdout
            results.append({"probe": name, "passed": passed})
            print(f'{"PASS" if passed else "FAIL"} {name}', flush=True)
        if not all(row["passed"] for row in results):
            raise Blocked("containment_control_failed")
        ready = contained([str(pi), "auth", "check", "--provider", args.provider, "--no-refresh", "--json"])
        if ready.returncode != 0 or json.loads(ready.stdout).get("status") != "ready":
            raise Blocked("local_subscription_not_ready")
        if selected["expires"] < time.time() * 1000 + 600_000:
            raise Blocked("refresh_margin_lost")
        print(f"LIVE profile={args.provider}/{args.model} effort={args.thinking} deadline=180s retries=0", flush=True)
        prompt = ("This is a disposable feasibility task. Read input.txt and the supplied policy. "
                  "Write output.txt containing the uppercase version of input.txt, with one trailing newline. "
                  f"Run /bin/sh {check} using bash. Do not modify other files, use Git mutations, "
                  "launch background processes or additional agents, inspect credentials, or contact services yourself. "
                  "If blocked, report the blocker and stop. Finish with CHECK_OK only if the check passed.")
        argv = ["/usr/bin/sandbox-exec", "-f", str(profile), str(pi), "--offline", "--no-extensions",
                "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-approve",
                "--no-session", "--mode", "json", "--tools", "read,write,bash", "--provider", args.provider,
                "--model", args.model, "--thinking", args.thinking, "--append-system-prompt", str(policy), prompt]
        (root / "plan.json").write_text(json.dumps({"argv": argv, "env": env,
            "driver_pid": os.getpid(), "driver_identity": identity(os.getpid())}))
        server_env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(server_home),
                      "TMPDIR": str(root / "tmp"), "SHELL": "/bin/bash", "TERM": "xterm-256color"}
        with (root / "evidence/herdr-server.stdout").open("wb") as out, (root / "evidence/herdr-server.stderr").open("wb") as err:
            server = subprocess.Popen([found["herdr"], "--session", session, "server"], env=server_env,
                                      cwd=root / "worker", stdout=out, stderr=err, start_new_session=True)

        def herdr(*argv, check=True):
            result = subprocess.run([found["herdr"], "--session", session, *argv], env=server_env,
                                    capture_output=True, timeout=15)
            if check and result.returncode:
                raise Blocked("isolated_herdr_command_failed")
            return result

        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise Blocked("isolated_herdr_server_failed")
            if herdr("workspace", "list", check=False).returncode == 0:
                break
            time.sleep(0.1)
        else:
            raise Blocked("isolated_herdr_readiness_failed")
        created = json.loads(herdr("workspace", "create", "--cwd", str(root / "worker"),
                                   "--label", "Disposable Pi feasibility", "--no-focus").stdout)
        pane = created["result"]["root_pane"]["pane_id"]
        import shlex
        command = shlex.join([sys.executable, str(Path(__file__).resolve()), "--controller", str(root)])
        herdr("pane", "run", pane, command)
        observed_pi = False
        deadline = time.monotonic() + 195
        while time.monotonic() < deadline and not (root / "evidence/controller-result.json").exists():
            state = herdr("pane", "get", pane, check=False)
            if state.returncode == 0:
                (root / "evidence/herdr-pane.json").write_bytes(state.stdout)
                parsed = json.loads(state.stdout)
                # Detection is evidence only, never authentication or task success.
                def has_pi(value):
                    if isinstance(value, dict):
                        return any((k in ("agent", "agent_kind", "kind") and v == "pi") or has_pi(v) for k, v in value.items())
                    if isinstance(value, list):
                        return any(has_pi(v) for v in value)
                    return False
                observed_pi |= has_pi(parsed)
            time.sleep(0.2)
        outcome_file = root / "evidence/controller-result.json"
        if not outcome_file.exists():
            raise Blocked("controller_result_missing")
        outcome = json.loads(outcome_file.read_text())
        events = [json.loads(line) for line in (root / "evidence/events.jsonl").read_text().split("\n") if line.strip()]
        messages = [event["message"] for event in events if event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant"]
        settled = any(e.get("type") == "agent_settled" for e in events)
        tools = [e for e in events if e.get("type") == "tool_execution_end"]
        model_ok = bool(messages) and all(m.get("provider") == args.provider and m.get("model") == args.model for m in messages)
        successful = bool(messages) and all(m.get("stopReason") not in ("error", "aborted") for m in messages)
        check_ok = any(e.get("toolName") == "bash" and not e.get("isError") and
                       any(c.get("type") == "text" and "CHECK_OK" in c.get("text", "") for c in e.get("result", {}).get("content", [])) for e in tools)
        output = root / "worker/output.txt"
        verified = output.exists() and output.read_bytes() == b"NATIVE-SUBSCRIPTION-FIXTURE\n"
        unchanged = all(digest(Path(p)) == before for p, before in snapshots.items())
        credentials_unchanged = digest(auth) == original_projection and json.loads(source.read_text()).get(args.provider) == source_selected
        passed = (outcome["exit"] == 0 and outcome["stop"] == "exited" and outcome["sampled_processes_absent"]
                  and settled and model_ok and successful and check_ok and verified and unchanged and credentials_unchanged)
        results.append({"probe": "live_pi_task", "passed": passed, "settled": settled,
                        "runtime_reported_profile": model_ok, "check_tool_success": check_ok,
                        "exact_output": verified, "protected_snapshots_unchanged": unchanged,
                        "credentials_unchanged": credentials_unchanged,
                        "sampled_processes_absent": outcome["sampled_processes_absent"],
                        "herdr_pi_detection_observed": observed_pi})
        print(f'{"PASS" if passed else "FAIL"} live_pi_task; Herdr Pi detection observed={observed_pi}', flush=True)
        if not successful:
            # Provider text may contain account identifiers; never print it.
            category = "runtime reported an error/abort" if messages else "runtime startup failed before assistant events"
            print(f"BLOCK: {category}; raw diagnostic retained privately", flush=True)
        success = passed
        return 0 if success else 1
    finally:
        # Preserve all task artifacts, including success; auth projections are always destroyed.
        try:
            registry = root / "evidence/processes.json"
            if registry.exists():
                records = {int(pid): value for pid, value in json.loads(registry.read_text()).items()}
                owned_stop(records)
                if any(observed and identity(pid) == observed for pid, observed in records.items()):
                    raise Blocked("sampled_process_cleanup_incomplete")
        finally:
            try:
                if server is not None:
                    # Only this freshly generated named session is targeted.
                    try:
                        subprocess.run([found["herdr"], "--session", session, "session", "stop", session, "--json"],
                                       env=server_env, capture_output=True, timeout=15)
                    finally:
                        try:
                            server.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            server.terminate()
                            try:
                                server.wait(timeout=5)
                            except subprocess.TimeoutExpired:
                                server.kill()
                                server.wait(timeout=5)
            finally:
                # Credential destruction must not depend on Herdr/cleanup success.
                shutil.rmtree(private)
                (root / "plan.json").unlink(missing_ok=True)
                (root / "evidence/results.json").write_text(json.dumps(results, indent=2) + "\n")
                Path("/tmp/radian-last-pi-task-fixture").write_text(str(root) + "\n")
                print("Fixture/evidence retained outside repository; auth projection destroyed; no raw diagnostics printed.", flush=True)
        shutil.copytree(server_home, root / "server-home", dirs_exist_ok=True)
        shutil.rmtree(server_home)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Blocked as error:
        print(f"BLOCK: {error}", flush=True)
        raise SystemExit(1)
    except Exception:
        print("BLOCK: unexpected fixture error; no raw diagnostic printed", flush=True)
        raise SystemExit(1)
