# macOS feasibility probes

Disposable experiments for the approved first milestone, not production runtime adapters. Default tests make no model calls, use no account credentials, and do not install into target workspaces or manipulate ordinary user panes.

```sh
bash tests/feasibility/macos-filesystem.sh
python3 tests/feasibility/macos-runtime-startup.py
python3 tests/feasibility/macos-network.py
python3 tests/feasibility/macos-processes.py
python3 tests/feasibility/macos-supervision.py
python3 tests/feasibility/macos-pi-auth-store.py
```

## What they test

- `macos-filesystem.sh`: scoped synthetic reads/writes, children and symlinks, protected shared Git metadata, read-only Git inspection, and controlled patch application/commit with hooks/fsmonitor disabled. Requires the selected Apple developer toolchain.
- `macos-runtime-startup.py`: offline version/help and missing-authentication behavior for installed Pi/Codex/Claude, with cleared environments and temporary homes. Grants resolved installed runtime/dylib dependencies and specific SSL configuration reads.
- `macos-network.py`: temporary loopback services, deny-default networking, permission for an owned local port, rejection of another local port, and observation that the tested address filter rejects a hostname. No public endpoint probes.
- `macos-processes.py`: denial of signals to another owned fixture process, inherited filesystem restrictions after child detachment, process-group cancellation limitations, and cleanup of a registered child after identity checks. Not exhaustive descendant discovery or a production watchdog.

- `macos-supervision.py`: three synthetic probes: refuse a mismatched process identity; independent watcher cleanup after heartbeat-producer crash; cleanup after a live producer stalls. Each loss case checks parent/registered detached-child disappearance, TERM-to-KILL escalation, inherited filesystem denial, and preservation of unfinished work. The watcher is outside the worker sandbox and uses EOF/monotonic heartbeat expiry. This is an experiment, not a production safety service.

The supervision probe registers a cooperative child's PID and checks `ps` identity before signals. It does not discover unregistered descendants, eliminate PID-check/signal races, authenticate registrations, or cover watcher failure/registration interruption. A fixed subsecond lease is solely a fixture parameter, not a recommended production timeout. Failed fixtures remain private; they do not authorize replacement workers or deleting unfinished artifacts.

- `macos-pi-auth-store.py`: offline synthetic proof of the public Pi SDK injected `CredentialStore` interface. Fresh OAuth resolves without writes; expired OAuth is refused before the refresh callback. Networking is denied, and no real credentials or model requests are used. Reuses installed-dependency resolution from the Pi task probe; currently recognizes the inspected Pi installation layout only.

## Opt-in live Pi task experiment — currently blocked

`macos-pi-task.py` requires macOS, a Herdr-managed caller, explicit `--live --provider openai --model gpt-6.1-sol --thinking medium`, and user authorization for that profile. Do not run it as part of default/offline tests or repeatedly probe model availability. It creates its own disposable Git worktree and named Herdr session, preserves artifacts outside this repository, and destroys its selected-provider credential projection on exit. No personal credential writes or API-key billing are permitted.

The first attempt passed seven filesystem/auth controls and local readiness but **failed during CLI credential reading**: denying the auth refresh lock also prevents the normal file-backed credential read. A separate Herdr socket-path-length startup issue was fixed using a short temporary server home, without weakening the worker profile. No assistant/tool events or completed model task were recorded. Do not relax the auth-lock denial and claim refresh is still prevented. The next recommended experiment uses the public SDK's read-only credential-store injection; it is not implemented as a live task adapter here.

The prototype controller watches driver identity and a fixed deadline and samples descendants. It is not a production independent heartbeat lease, exhaustive descendant ownership, or watcher-loss solution. JSON-mode Herdr Pi detection was not observed. Preserve these gaps when interpreting termination evidence.

## Optional subscription-authentication readiness checks

Explicitly opt in to one runtime at a time:

```sh
python3 tests/feasibility/macos-runtime-startup.py --real-auth pi --provider <oauth-provider>
python3 tests/feasibility/macos-runtime-startup.py --real-auth codex
python3 tests/feasibility/macos-runtime-startup.py --real-auth claude --keychain-service '<explicit-service>'
```

These check local subscription readiness only, with no model requests, refresh, API-key fallback, or paid inference. They do not prove remote provider acceptance, token rotation/renewal, or long-running concurrency safety.

Pi projects only the selected stored OAuth provider into a separate private short-lived directory. Codex grants read-only access to its exact ChatGPT auth file through a temporary symlink. Claude's host helper queries one explicit existing Keychain service and projects only its OAuth record into a separate private short-lived directory; the worker receives no general Keychain permission. No alternate service is attempted and no Keychain approval is automatically accepted.

Private projections are destroyed on success/failure and authenticated output is neither printed nor saved. Real credentials are never copied into the retained synthetic diagnostic fixtures or public repository. Do not run an opt-in check without authorization to access that runtime's subscription credential. API-key/pay-as-you-go billing is not supported by the current approved usage policy.

## Operation and evidence

Requires macOS, sandbox-exec, and Python 3. Runtime startup requires all three CLIs to be installed. Exit 77 means skipped because prerequisites are missing, not passed.

Tests allocate private disposable fixtures outside the repository. Successful fixtures are removed unless `RADIAN_KEEP_FIXTURE=1`; failed synthetic fixtures are retained for diagnosis. Raw stdout/stderr, resolved installation paths, and sandbox profiles stay outside public artifacts. Never publish credentials, personal configuration, or raw machine paths.

No test elevates privileges, modifies host configuration, or changes installed runtimes. System/install reads are still a trust surface, not proof of comprehensive containment. Process-group timeout handling does not guarantee termination of detached descendants.

Manual isolated Herdr startup results and known limitations are documented in [feasibility results](../../docs/research/feasibility-results.md). Actual model-task execution, expiry/refresh, runtime-native sandbox composition, and actual-runtime supervision-loss behavior remain support gates. Synthetic crash/stall supervision evidence does not close those gates.
