#!/usr/bin/env python3
"""Synthetic independent-watchdog experiment, NOT a production launcher.

No credentials, runtimes, Herdr sessions, or unrelated processes are accessed.
A disposable heartbeat producer represents the coordinator. The watcher owns
one sandboxed parent and a cooperatively registered detached child. Registration
is not authenticated descendant discovery; watcher failure remains an open gate.
"""
import json
import os
from pathlib import Path
import select
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


def wait_absent(pid, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not identity(pid):
            return True
        time.sleep(0.05)
    return not identity(pid)


def signal_owned(record, sig):
    # ps identity narrows accidental PID reuse; it is not an atomic PID handle.
    if identity(record["pid"]) == record["identity"]:
        os.kill(record["pid"], sig)
        return True
    return False


def stop_owned(records):
    for record in records:
        signal_owned(record, signal.SIGTERM)
    time.sleep(0.2)
    escalated = 0
    for record in records:
        escalated += signal_owned(record, signal.SIGKILL)
    return escalated


def watcher(root):
    evidence = root / "evidence"
    program = r'''
use strict;
use POSIX qw(setsid);
$| = 1;
my $root = shift @ARGV;
print "$$\n";
my $pid = fork();
defined($pid) or die "fork failed";
if ($pid == 0) {
    setsid() >= 0 or die "setsid failed";
    $SIG{TERM} = 'IGNORE';
    print "$$\n";
    if (open(my $bad, ">", "$root/protected/escape")) {
        print $bad "unexpected\n";
        close($bad);
    } else {
        open(my $ok, ">", "$root/work/denied") or die "evidence failed";
        print $ok "denied\n";
        close($ok);
    }
    while (1) { sleep 1; }
}
while (1) { sleep 1; }
'''
    env = {"PATH": "/usr/bin:/bin", "HOME": str(root / "work")}
    records = []
    with (evidence / "worker.stderr").open("wb") as err:
        parent = subprocess.Popen(
            ["/usr/bin/sandbox-exec", "-f", str(root / "probe.sb"),
             "/usr/bin/perl", "-e", program, str(root)],
            env=env, cwd=root / "work", stdout=subprocess.PIPE, stderr=err,
            start_new_session=True,
        )
        try:
            # Read two registrations with a bounded deadline, not blocking readline.
            data = b""
            deadline = time.monotonic() + 5
            while data.count(b"\n") < 2:
                if time.monotonic() >= deadline:
                    raise RuntimeError("registration timeout")
                if select.select([parent.stdout], [], [], 0.1)[0]:
                    chunk = os.read(parent.stdout.fileno(), 4096)
                    if not chunk:
                        raise RuntimeError("registration closed")
                    data += chunk
            pids = [int(line) for line in data.splitlines()]
            if len(pids) != 2 or pids[0] != parent.pid or pids[0] == pids[1]:
                raise RuntimeError("invalid registration")
            for pid in pids:
                observed = identity(pid)
                if str(root) not in observed:
                    raise RuntimeError("identity mismatch")
                records.append({"pid": pid, "identity": observed})
            (evidence / "registry.json").write_text(json.dumps(records))
            (evidence / "ready").touch()
            # The pipe is held only by the heartbeat producer. EOF means loss;
            # a live but stopped producer expires the monotonic lease as well.
            last = time.monotonic()
            reason = ""
            while not reason:
                if select.select([sys.stdin.buffer], [], [], 0.05)[0]:
                    if not os.read(sys.stdin.fileno(), 4096):
                        reason = "heartbeat_eof"
                    else:
                        last = time.monotonic()
                if not reason and time.monotonic() - last > 0.75:
                    reason = "lease_expired"
            escalated = stop_owned(records)
            parent.wait(timeout=5)
            absent = all(wait_absent(record["pid"], 5) for record in records)
            (evidence / "result.json").write_text(json.dumps({
                "reason": reason, "absent": absent,
                "escalated": escalated,
                "preserved": (root / "work/unfinished.txt").read_text() == "unfinished\n",
                "boundary": (root / "work/denied").exists()
                and not (root / "protected/escape").exists(),
            }))
            return 0 if absent else 1
        finally:
            stop_owned(records)
            if parent.poll() is None:
                parent.kill()  # Direct Popen child, not an untrusted PID.
            parent.wait(timeout=5)
            parent.stdout.close()


def wait_file(path, process, seconds=7):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists():
            return
        if process.poll() is not None:
            break
        time.sleep(0.05)
    raise RuntimeError("watcher readiness failed")


def probe(root, mode):
    root.mkdir()
    for name in ("work", "protected", "evidence"):
        (root / name).mkdir()
    (root / "work/unfinished.txt").write_text("unfinished\n")
    (root / "probe.sb").write_text("\n".join([
        "(version 1)", "(deny default)", "(allow process-exec)",
        "(allow process-fork)", "(allow sysctl-read)", "(allow file-read-metadata)",
        '(allow file-read* (literal "/") (literal "/private") (literal "/private/tmp"))',
        '(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/Library"))',
        '(allow file-read* file-write* (literal "/dev/null"))',
        f'(allow file-read* file-write* (subpath {json.dumps(str(root / "work"))}))',
    ]) + "\n")
    heartbeat = subprocess.Popen(
        [sys.executable, "-I", "-c",
         'import os,time\nwhile True:\n os.write(1,b"alive\\n"); time.sleep(0.1)'],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True,
    )
    watch = None
    try:
        with (root / "evidence/watcher.stderr").open("wb") as err:
            watch = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "--watcher", str(root)],
                stdin=heartbeat.stdout, stdout=subprocess.DEVNULL, stderr=err,
                start_new_session=True,
            )
        heartbeat.stdout.close()  # No driver-held duplicate of the producer pipe.
        wait_file(root / "evidence/ready", watch)
        if mode == "crash":
            heartbeat.kill()
            heartbeat.wait(timeout=5)
        else:
            os.kill(heartbeat.pid, signal.SIGSTOP)
        watch.wait(timeout=10)
        result = json.loads((root / "evidence/result.json").read_text())
        expected = "heartbeat_eof" if mode == "crash" else "lease_expired"
        passed = (watch.returncode == 0 and result["reason"] == expected
                  and result["absent"] and result["preserved"]
                  and result["boundary"] and result["escalated"] >= 1)
        print(f'{"PASS" if passed else "FAIL"} {mode}: independent stop, detached-child escalation, boundary, preservation')
        return passed
    finally:
        if heartbeat.poll() is None:
            heartbeat.kill()
        heartbeat.wait(timeout=5)
        if watch is not None and watch.poll() is None:
            watch.kill()
            watch.wait(timeout=5)
        registry = root / "evidence/registry.json"
        if registry.exists():
            records = json.loads(registry.read_text())
            stop_owned(records)
            if not all(wait_absent(record["pid"], 5) for record in records):
                raise RuntimeError("owned process cleanup incomplete")


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--watcher":
        return watcher(Path(sys.argv[2]))
    if len(sys.argv) != 1:
        raise SystemExit("No public arguments supported")
    if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists():
        print("SKIP: requires macOS and sandbox-exec")
        return 77
    root = Path(tempfile.mkdtemp(prefix="radian-supervision-feasibility.", dir="/tmp")).resolve()
    success = False
    try:
        sentinel = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
        try:
            refused = not signal_owned(
                {"pid": sentinel.pid, "identity": "deliberately mismatched synthetic identity"},
                signal.SIGTERM,
            ) and sentinel.poll() is None
            print(f'{"PASS" if refused else "FAIL"} identity_mismatch: no signal sent')
        finally:
            sentinel.terminate()
            sentinel.wait(timeout=5)
        results = [probe(root / mode, mode) for mode in ("crash", "stall")]
        success = refused and all(results)
        return 0 if success else 1
    finally:
        if success and os.environ.get("RADIAN_KEEP_FIXTURE") != "1":
            shutil.rmtree(root)
        else:
            Path("/tmp/radian-last-supervision-fixture").write_text(str(root) + "\n")
            print("Fixture retained outside repository; raw diagnostics not printed.")


if __name__ == "__main__":
    raise SystemExit(main())
