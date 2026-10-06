#!/usr/bin/env python3
"""Synthetic process ownership probes; no agent sessions or user-process signals."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time


def identity(pid):
    result = subprocess.run(
        ["/bin/ps", "-p", str(pid), "-o", "pid=,lstart=,command="],
        capture_output=True, text=True, timeout=3,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def wait_for_file(path, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists():
            return True
        time.sleep(0.05)
    return False


def main():
    if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists():
        print("SKIP: requires macOS and sandbox-exec")
        return 77
    root = Path(tempfile.mkdtemp(prefix="radian-process-feasibility.", dir="/tmp")).resolve()
    for name in ("home", "work", "evidence", "protected"):
        (root / name).mkdir()
    profile = root / "probe.sb"
    rules = [
        "(version 1)", "(deny default)", "(allow process-exec)", "(allow process-fork)",
        "(allow sysctl-read)", "(allow file-read-metadata)",
        '(allow file-read* (literal "/") (literal "/private") (literal "/private/tmp"))',
        '(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library"))',
        '(allow file-read* file-write* (literal "/dev/null"))',
        f'(allow file-read* file-write* (subpath {json.dumps(str(root / "home"))}) (subpath {json.dumps(str(root / "work"))}) (subpath {json.dumps(str(root / "evidence"))}))',
    ]
    profile.write_text("\n".join(rules) + "\n")
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(root / "home")}
    sentinel = subprocess.Popen(["/bin/sleep", "60"], start_new_session=True)
    parent = None
    detached_pid = None
    detached_identity = ""
    results = []
    success = False
    try:
        sentinel_identity = identity(sentinel.pid)
        kill = subprocess.run(
            ["/usr/bin/sandbox-exec", "-f", str(profile), "/bin/kill", "-TERM", str(sentinel.pid)],
            cwd=root / "work", env=env, capture_output=True, timeout=5,
        )
        passed = kill.returncode != 0 and sentinel.poll() is None and identity(sentinel.pid) == sentinel_identity
        results.append({"probe": "worker_cannot_signal_other_process", "passed": passed})
        print(f"{'PASS' if passed else 'FAIL'} worker_cannot_signal_other_process")

        # Perl and POSIX are bundled OS resources. The child detaches its session
        # but retains the inherited filesystem sandbox. No real files are touched.
        program = r'''
use strict;
use POSIX qw(setsid);
my $root = shift @ARGV;
my $pid = fork();
defined($pid) or die "fork failed";
if ($pid == 0) {
    setsid() >= 0 or die "setsid failed";
    open(my $out, ">", "$root/evidence/detached-pid") or die "pid write failed";
    print $out "$$\n";
    close($out);
    if (open(my $blocked, ">", "$root/protected/escape")) {
        print $blocked "unexpected write\n";
        close($blocked);
    } else {
        open(my $ok, ">", "$root/evidence/child-denial") or die "evidence write failed";
        print $ok "denied\n";
        close($ok);
    }
    sleep 60;
    exit 0;
}
sleep 60;
'''
        stdout = (root / "evidence/process.stdout").open("wb")
        stderr = (root / "evidence/process.stderr").open("wb")
        try:
            parent = subprocess.Popen(
                ["/usr/bin/sandbox-exec", "-f", str(profile), "/usr/bin/perl", "-e", program, str(root)],
                cwd=root / "work", env=env, stdout=stdout, stderr=stderr, start_new_session=True,
            )
        finally:
            stdout.close()
            stderr.close()
        if not wait_for_file(root / "evidence/detached-pid"):
            print("FAIL detached child did not become observable; diagnostics retained")
            return 1
        detached_pid = int((root / "evidence/detached-pid").read_text())
        detached_identity = identity(detached_pid)
        if str(root) not in detached_identity or detached_pid == parent.pid:
            print("FAIL detached identity validation")
            return 1
        denied = wait_for_file(root / "evidence/child-denial") and not (root / "protected/escape").exists()
        results.append({"probe": "detached_child_inherits_filesystem_boundary", "passed": denied})
        print(f"{'PASS' if denied else 'FAIL'} detached_child_inherits_filesystem_boundary")

        os.killpg(parent.pid, signal.SIGTERM)
        parent.wait(timeout=5)
        survived = identity(detached_pid) == detached_identity
        results.append({"probe": "detached_child_survives_process_group_cancel", "passed": survived, "group_cancel_sufficient": False if survived else None})
        print(f"{'OBSERVED' if survived else 'UNEXPECTED'} process_group_cancel_misses_detached_child")

        # This verifies cleanup of a known registered child, NOT exhaustive
        # discovery of arbitrary descendants or a production watchdog guarantee.
        if survived:
            os.kill(detached_pid, signal.SIGTERM)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and identity(detached_pid):
            time.sleep(0.05)
        cleaned = not identity(detached_pid)
        results.append({"probe": "registered_detached_child_cleanup", "passed": cleaned})
        print(f"{'PASS' if cleaned else 'FAIL'} registered_detached_child_cleanup")
        success = all(row["passed"] for row in results)
        (root / "evidence/results.json").write_text(json.dumps(results, indent=2) + "\n")
        return 0 if success else 1
    finally:
        if parent is not None and parent.poll() is None:
            os.killpg(parent.pid, signal.SIGTERM)
            parent.wait(timeout=5)
        if detached_pid and detached_identity and identity(detached_pid) == detached_identity:
            os.kill(detached_pid, signal.SIGTERM)
        if sentinel.poll() is None:
            sentinel.terminate()
        sentinel.wait(timeout=5)
        if success and os.environ.get("RADIAN_KEEP_FIXTURE") != "1":
            shutil.rmtree(root)
        else:
            Path("/tmp/radian-last-process-fixture").write_text(str(root) + "\n")
            print("Fixture retained outside repository; raw diagnostics not printed.")


if __name__ == "__main__":
    raise SystemExit(main())
