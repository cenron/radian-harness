#!/usr/bin/env python3
"""Synthetic loopback network probes; no providers, credentials, or public calls."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.request_count += 1
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"fixture-response")

    def log_message(self, *args):
        pass


def main():
    if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists():
        print("SKIP: requires macOS and sandbox-exec")
        return 77
    root = Path(tempfile.mkdtemp(prefix="radian-network-feasibility.", dir="/tmp")).resolve()
    for directory in ("home", "work", "evidence"):
        (root / directory).mkdir()
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(root / "home")}
    servers = [ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler) for _ in range(2)]
    threads = []
    for server in servers:
        server.request_count = 0
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        threads.append(thread)
    results = []
    success = False
    try:
        common = [
            "(version 1)", "(deny default)", "(allow process-exec)",
            "(allow process-fork)", "(allow sysctl-read)", "(allow file-read-metadata)",
            '(allow file-read* (literal "/") (literal "/private") (literal "/private/tmp"))',
            '(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library"))',
            '(allow file-read* (literal "/private/etc/ssl/openssl.cnf") (literal "/private/etc/ssl/cert.pem") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
            '(allow file-write* (literal "/dev/null"))',
            f'(allow file-read* (subpath {json.dumps(str(root))}))',
            f'(allow file-write* (subpath {json.dumps(str(root / "home"))}))',
        ]
        denied = root / "denied.sb"
        denied.write_text("\n".join(common) + "\n")
        allowed = root / "local-port.sb"
        port = servers[0].server_port
        allowed.write_text("\n".join(common + [f'(allow network-outbound (remote ip "localhost:{port}"))']) + "\n")

        def fetch(server, profile=None):
            command = ["/usr/bin/curl", "--noproxy", "*", "--silent", "--show-error", "--connect-timeout", "2", "--max-time", "3", f"http://127.0.0.1:{server.server_port}/fixture"]
            if profile:
                command = ["/usr/bin/sandbox-exec", "-f", str(profile), *command]
            return subprocess.run(command, cwd=root / "work", env=env, capture_output=True, timeout=10)

        for index, server in enumerate(servers):
            result = fetch(server)
            passed = result.returncode == 0 and result.stdout == b"fixture-response"
            results.append({"probe": f"host_control_{index}", "passed": passed})
            print(f"{'PASS' if passed else 'FAIL'} host_control_{index}")
        if not all(row["passed"] for row in results):
            return 1

        before = servers[0].request_count
        result = fetch(servers[0], denied)
        passed = result.returncode != 0 and not result.stdout and servers[0].request_count == before
        results.append({"probe": "deny_network", "passed": passed, "exit": result.returncode})
        print(f"{'PASS' if passed else 'FAIL'} deny_network")
        (root / "evidence/deny.stderr").write_bytes(result.stderr)

        result = fetch(servers[0], allowed)
        passed = result.returncode == 0 and result.stdout == b"fixture-response"
        results.append({"probe": "allow_owned_local_port", "passed": passed, "exit": result.returncode})
        print(f"{'PASS' if passed else 'FAIL'} allow_owned_local_port")
        (root / "evidence/allow.stderr").write_bytes(result.stderr)

        before = servers[1].request_count
        result = fetch(servers[1], allowed)
        passed = result.returncode != 0 and not result.stdout and servers[1].request_count == before
        results.append({"probe": "deny_other_local_port", "passed": passed, "exit": result.returncode})
        print(f"{'PASS' if passed else 'FAIL'} deny_other_local_port")
        (root / "evidence/other-port.stderr").write_bytes(result.stderr)
        # Compile only: no public endpoint is contacted. This documents a
        # native policy limitation rather than claiming hostname enforcement.
        named = root / "named-provider.sb"
        named.write_text("\n".join(common + ['(allow network-outbound (remote ip "provider.example.com:443"))']) + "\n")
        result = subprocess.run(["/usr/bin/sandbox-exec", "-f", str(named), "/usr/bin/true"], cwd=root / "work", env=env, capture_output=True, timeout=10)
        rejected = result.returncode != 0 and b"host must be * or localhost" in result.stderr
        results.append({"probe": "hostname_filter_limitation_observed", "passed": rejected, "hostname_allowlist_supported": False if rejected else None})
        print(f"{'OBSERVED' if rejected else 'UNEXPECTED'} hostname_allowlist_not_supported")
        (root / "evidence/hostname.stderr").write_bytes(result.stderr)
        (root / "evidence/results.json").write_text(json.dumps(results, indent=2) + "\n")
        success = all(row["passed"] for row in results)
        return 0 if success else 1
    finally:
        for server, thread in zip(servers, threads):
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
        if success and os.environ.get("RADIAN_KEEP_FIXTURE") != "1":
            shutil.rmtree(root)
        else:
            Path("/tmp/radian-last-network-fixture").write_text(str(root) + "\n")
            print("Fixture retained outside repository; raw diagnostics not printed.")


if __name__ == "__main__":
    raise SystemExit(main())
