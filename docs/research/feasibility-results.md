# Native macOS feasibility — initial filesystem probes

**Status: feasibility testing stopped by user instruction. Preserved preliminary evidence only; no worker runtime is yet validated for supported use. Implementation is now authorized separately by [proposal 0014](../proposals/0014-unattended-implementation.md).**

## Baseline and scope

The approved planning baseline was committed and pushed as `8a5aa5f` before these experiments. The first probes used a disposable Git repository/worktree and synthetic protected files outside the Radian repository. No target workspace was installed or modified; no model sessions or credentials were used.

The candidate mechanism was the locally available deprecated `sandbox-exec`. A deny-default profile allowed process execution/fork, broad file reads with an explicit protected-fixture read denial, and writes only to the fixture worktree/evidence directories plus the null device. The probe environment was cleared and supplied only a minimal path and fixture-local home.

**This is not the production profile:** broad read access is unsuitable for the required credential/read separation. These probes test write confinement and specific protected-read denial only. Network permissions, authentication, service compatibility, and process supervision were not exercised.

## Observed results

All **11 expected allow/deny checks passed**:

| Probe | Expected and observed |
| --- | --- |
| Read task input | Allowed |
| Write task output | Allowed |
| Write task evidence | Allowed |
| Read explicitly protected fixture | Denied |
| Write protected fixture | Denied |
| Write shared Git configuration | Denied |
| Create shared Git pre-commit hook | Denied |
| Child shell writes protected output | Denied |
| Read protected file through worktree symlink | Denied |
| Write protected file through worktree symlink | Denied |
| Write shared Git configuration through worktree symlink | Denied |

The checks used real commands and exit statuses, not agent willingness to avoid forbidden actions. Additional inspection confirmed the shared Git configuration remained readable as valid configuration, the denied hook was absent, and the denied child output was absent.

## Scoped-read and Git follow-up

A repeatable disposable test is now available at `tests/feasibility/macos-filesystem.sh`. Run it with `bash tests/feasibility/macos-filesystem.sh` on macOS with sandbox-exec and the selected Apple developer toolchain. It makes no target-workspace changes and runs no agents or model calls. Successful fixtures are removed; failed fixtures remain outside the repository for diagnosis. Set `RADIAN_KEEP_FIXTURE=1` to retain a successful fixture.

Observed: **32 scoped read/write/Git assertions passed**, plus controlled patch application/commit without invoking planted Git helpers. Allowed task/policy reads and task/evidence writes worked. Reads of synthetic unrelated, other-task, and credential files were denied directly and through symlinks. Policy writes, shared Git configuration/hooks/target refs, worktree Git-pointer writes, and child-process cross-task effects were denied. Controlled status/diff/log worked, while worker staging/commit/config/ref/branch writes were denied. Protected configuration/target-ref snapshots remained unchanged.

The restricted-read profile initially aborted in the macOS loader. Adding literal root/parent-directory read permissions enabled startup without restoring broad file-content reads. Broad metadata reads remain permitted for traversal, so directory/path metadata is not claimed private. System/toolchain read roots also remain broader than individual executable files and require later audit.

Apple's Git shim attempted additional Xcode/helper/cache activity under the restricted profile. The test instead runs the Git executable directly from the selected developer toolchain and grants that toolchain read access. No unrestricted temporary-write permission was added. Git operations clear inherited credentials/global configuration, neutralize hooks and filesystem-monitor helpers, and disable external diff/textconv during patch export. This is a tested fixture path, not exhaustive protection against every Git executable/configuration channel.

No arbitrary candidate code was executed by the coordinator: outside-boundary fixture operations only applied and committed a synthetic patch. Runtime auth, actual task execution, network access, and process lifecycle remain separate gates.

## Offline runtime startup and missing-auth behavior

`tests/feasibility/macos-runtime-startup.py` now passes **10 probes**:

- Version/help startup for Pi `1.0.2`, Codex CLI `0.160.0`, and Claude Code `2.1.285` inside the native profile.
- Each runtime semantically reports missing authentication in fixture-local config/homes. Pi refresh is explicitly disabled; no credentials are emitted or real accounts inspected.
- A synthetic protected-file read remains denied after adding runtime dependencies.

This establishes offline CLI compatibility, not interactive agent/tool execution, authenticated readiness, token refresh, native-sandbox composition, or vendor-side model identity. The fixture shares an empty synthetic home tree; real per-runtime credential separation has not yet been validated.

Initial runtime launches failed closed on missing startup permissions/dependencies. Scoped system metadata and SSL-config reads resolved Codex/Rust and Claude/Bun initialization failures. Pi additionally needed its pinned Node interpreter's transitive dynamic libraries and OpenSSL configuration. The test resolves actual absolute/loader/rpath library references and grants file-specific reads, not the whole host home or package-manager tree. Linked system/install roots remain part of the trusted startup surface and require audit before production support.

## Non-refreshing authentication projection checks

Opt-in local readiness probes passed for all three installed runtimes:

- Pi: project only the explicitly selected provider credential into a private short-lived agent directory, not the full multi-provider auth store. The source file is read only; the projection is destroyed even on failure.
- Codex: grant read-only access to its exact existing auth file through a temporary symlink. No personal config directory or host credential writes are granted; the link is removed after the check.
- Claude: a host helper queries one explicitly named existing Keychain service and projects only the Claude OAuth record into a private short-lived credentials file. The worker gets no general Keychain/securityd permission. The projection is destroyed even on failure; no alternate service or login is attempted.

No Keychain prompt was automatically accepted. Commands report local readiness only, never emit credential values, and save no authenticated account output. No model requests or token refreshes were performed. These checks do **not** prove provider-side authentication, refresh-token rotation/concurrency, expiry recovery, or long-running credential ownership. Those remain support gates.

## Network controls and policy resolution

`tests/feasibility/macos-network.py` passes **five loopback controls/allow-deny checks**, using two temporary synthetic HTTP services:

- Unsandboxed controls confirm both fixture endpoints are reachable.
- Deny-default networking prevents requests from reaching the first endpoint.
- A localhost/port permission permits the assigned service.
- The same profile denies the second local port.

A separate compile-only check observes that a named provider address is rejected by the tested `remote ip` filter with `host must be * or localhost`. No public endpoint was contacted. This is evidence that this tested filter cannot directly express provider hostname allowlists, not proof that every native macOS networking mechanism lacks that capability.

**Resolved by explicit user decision:** allow ordinary outbound networking for local developer/tester/scout work, without claiming provider/registry destination isolation or adding a proxy. Role/operation restrictions and filesystem/Git/state boundaries remain in force. All roles require model connectivity; read/report-only roles do not receive arbitrary shell/network tools.

An opt-in unauthenticated HTTPS HEAD probe against the selected provider endpoint passed under the approved IP-outbound rule. DNS required access to the specific OS mDNSResponder socket; broad system-socket and Mach-service permissions were tested during diagnosis and then removed. The tested final rule does not grant arbitrary host Unix sockets. No model/API credentials were supplied to the HEAD requests. The user subsequently clarified subscription-only usage, and direct provider endpoint probes were discontinued. Future checks use the runtime subscription paths; no API-key billing is authorized.

## Isolated Herdr terminal startup checks

Manual probes used a separately named headless Herdr `0.9.1` test session and fixture-local homes. Ordinary user panes were untouched. Explicit model/effort arguments were supplied; no model prompt, fallback, or effort escalation was attempted.

- Pi reached its editor, Herdr recognized it as Pi/idle, and `/quit` returned to the shell.
- Codex reached its sign-in UI, and Ctrl+C returned to the shell. Herdr reported idle at sign-in, proving that idle is not authentication/assignment readiness.
- Claude reached its onboarding UI after task-local scratch/DNS permissions were resolved. No onboarding, trust, or login prompt was accepted. This is UI startup, not a completed worker launch.
- Pi initially failed raw terminal mode; permission for ioctl on the specific assigned terminal enabled startup. Do not grant access to unrelated terminals.
- Claude initially attempted a shared host scratch path. Its documented `CLAUDE_CODE_TMPDIR` redirected that activity into the task fixture without permitting shared scratch writes.

The test pane was closed, its separate server stopped, and tracked foreground/shell PIDs verified absent. This does not prove exhaustive detached-descendant termination. No review/test workers remain intentionally running.

## Process ownership and cancellation probes

`tests/feasibility/macos-processes.py` passed synthetic checks that a sandboxed worker cannot signal another owned fixture process, a detached child retains the filesystem boundary, and a registered detached child can be cleaned up after identity verification.

It also **observed that a detached child survives process-group cancellation**. Therefore pane closure or killpg alone cannot establish the required termination postcondition. A production launcher/safety watcher must own and reconcile registered children/resources; supervision-loss behavior, descendant discovery, and actual runtime background-process behavior remain unverified. The test signals only its own disposable processes and cleans them up.

## Independent synthetic supervision-loss follow-up

`tests/feasibility/macos-supervision.py` passed **three probes**: identity-mismatch refusal, heartbeat-producer crash, and heartbeat-producer stall. The producer represents coordination; an independent unsandboxed fixture watcher owns a sandboxed Perl parent and cooperatively registered detached child. EOF detects producer death; a monotonic lease detects a live but stopped producer.

Both loss cases verified parent and registered-child disappearance, escalation to KILL for a child ignoring TERM, inherited protected-write denial, and unchanged unfinished work. No runtime/model, credentials, target workspace, or Herdr panes were used. The fixture's worker cannot write the watcher's evidence/registry directory. The full previous offline filesystem, runtime-startup, network, and process suites also passed again with unchanged observed runtime versions.

**Limits:** this demonstrates cleanup of known registered processes under a surviving watcher, not exhaustive descendant discovery or a production supervision guarantee. Registration is cooperative, and `ps` identity checking is not an atomic PID handle. Registration interruption, unregistered children, watcher failure, sleep/wake timing, actual runtime subprocesses, and resource/port reconciliation remain unverified. The short fixture lease is not a production timeout decision. A replacement must still block on uncertain ownership/termination; no automatic relaunch was tested or authorized.

## First opt-in Pi task attempt — blocked before assistant execution

The user approved proceeding with one contained subscription task. The announced profile was Pi `openai/gpt-6.1-sol`, medium effort, a three-minute deadline, no retries/fallback/refresh, and no personal credential writes. Installed provider code identifies this `openai` OAuth path as ChatGPT subscription authentication; a direct API hostname does not imply API-key/pay-as-you-go authentication. No custom endpoint or API-key override was supplied.

`tests/feasibility/macos-pi-task.py` is an opt-in experimental launcher, **currently blocked**, not a working adapter. It builds a disposable repository/worktree, projects only the selected OAuth record, uses a cleared environment, disables automatic retry/compaction/cache warming, and launches a fixture controller in a newly named isolated Herdr session. The controller owns the runtime and samples descendants; this is not exhaustive discovery or a production supervisor.

Observed:

- **Seven direct controls passed:** task-input read allowed; synthetic protected read, policy write, shared Git configuration write, worktree Git-pointer write, projected-auth write, and refresh-lock creation denied.
- Local non-refreshing subscription readiness passed, with more than ten minutes of credential validity before the bounded attempt.
- First Herdr preflight failed because the generated Unix-socket path exceeded the native path-length limit. Shortening only the disposable server home corrected that fixture issue; no containment permissions changed.
- Pi then exited during credential resolution: its CLI's file-backed store requires an auth lock even for normal reads. Denying refresh-lock creation therefore also blocks task startup. No assistant/tool events or successful model execution were recorded. Herdr Pi detection was not observed in this short JSON-mode launch.
- Protected snapshots and selected source/projected credentials remained unchanged. Sampled runtime processes and the isolated server exited; credential projections were destroyed. Failed fixtures/evidence were preserved outside the repository. No fallback, refreshed credentials, target installation, commit, or push followed.

**Stop decision:** do not allow that lock merely to get through startup while advertising a no-refresh guarantee. The same file-backed modification path owns refresh, and failing a credential write after a remote rotation could already have diverged credentials. Actual task execution and cancellation remain unverified.

## Offline read-only credential-store contract follow-up

`tests/feasibility/macos-pi-auth-store.py` passed **two synthetic probes** with networking denied and no real credentials or model prompt:

1. The public `ModelRuntime.create({ credentials })` SDK interface resolves fresh synthetic OAuth through an injected read-only `CredentialStore`, without store writes.
2. An expired synthetic OAuth record is refused at `modify` before invoking the provider refresh callback. No token/auth values are printed.

This confirms an available SDK contract for a follow-up experiment, not a supported CLI flag or completed worker adapter. The installed internal `ReadOnlyAuthStorage` used for non-refreshing CLI auth checks is not exported at the package root; do not rely on a private import for production. Recommendation: a minimal disposable Pi SDK probe using the public injected-store interface, with the same profile and outer sandbox, before another live attempt. Explicitly report that as SDK execution rather than claiming CLI/interactive Herdr parity. Shared refresh ownership, actual task execution, detection, and actual-runtime supervision loss remain open.

## Capability/gap checkpoint

| Boundary or runtime | Observed capability | Remaining support gate |
| --- | --- | --- |
| Native filesystem/Git | Scoped synthetic allow/deny checks; protected policy/shared metadata; controlled patch commit | Installed dependency/tool access audit and actual candidate execution |
| Networking | Owned loopback port controls; ordinary outbound policy explicitly approved | Actual subscription-runtime connectivity; no destination isolation claimed |
| Pi | Offline startup/readiness; first task attempt blocked on CLI auth-read locking; synthetic public SDK read-only-store contract passes | Actual task execution, no-refresh CLI/SDK launch choice, Herdr detection, native-policy composition, refresh ownership |
| Codex CLI and Claude Code (each) | Offline startup/missing-auth checks and prior opt-in local subscription readiness | Actual task execution with explicit profile, native-policy composition, expiry/refresh ownership |
| Herdr | Prior isolated terminal startup/detection | Authenticated assignment binding and actual-runtime lifecycle/control |
| Process lifecycle | Group cancellation gap reproduced; surviving independent watcher cleans registered actors after synthetic crash/stall | Unregistered descendants, watcher loss, actual runtime cancellation, services/resources |

**Historical decision checkpoint:** NO-GO for production worker support relying on this boundary. The user subsequently stopped feasibility experiments and authorized implementation, with required unverified capabilities kept fail-closed and full automated verification at the end. All three runtimes remain in scope, none is yet validated for supported use. Resolve shared credential refresh ownership before concurrent/long-running authenticated workers. No broader architecture or containment exception follows from synthetic success.

## Interpretation and remaining gates

The mechanism can launch a simple process and constrain these synthetic filesystem operations, including child and symlink paths. This does not establish complete Git integrity, unrestricted hostile-code resistance, or compatibility with Pi/Codex/Claude processes. Deprecation remains a maintenance risk.

Next validate scoped reads/system-library access without broad home access; required temporary/cache resources; Git read/patch delivery with protected metadata; native-runtime composition and authentication/refresh; network/service restrictions; Herdr launch; termination and supervision loss. No runtime fallback, widened network policy, or containment exception is authorized by these results.

The fixtures are disposable and retained outside the repository for follow-up. No publication of raw machine paths or credentials is necessary. The user subsequently authorized preserving these changes in the implementation-plan checkpoint commit/push. Consult Git history for its exact identity; this evidence is not a runtime-support attestation.
