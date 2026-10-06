# Milestone 05 — Native containment, credential ownership, and supervision

**Status: complete** · Depends on: 02–04

## Objective

Implement the fail-closed boundary and independent safety services without treating unfinished feasibility as proven runtime support.

## Deliverables

- Native macOS boundary provider with canonical task read/write/scratch scopes, protected policy/state/Git roots, dependency access declarations, assigned-terminal permissions, and ordinary outbound IP networking plus narrowly needed OS DNS access.
- Explicit capability records bound to OS/runtime/toolchain/policy versions and verification provenance. Required unknown/unverified capabilities deny launch.
- Selected-provider subscription credential projections constrained by [proposal 0015](../../proposals/0015-anthropic-runtime-policy.md): never project Anthropic credentials into Pi or Codex workers; validate the permitted runtime and subscription/billing path before exposure. Implement private storage/destruction, explicit refresh ownership/leases, and non-refreshing worker credential access or structured unsupported blockers.
- Independent safety watcher/lease, owned process/resource registry, cancellation/escalation, loss-of-supervision handling, and reconciled termination postconditions.
- Safe preflight results/denied-action diagnostics; no credentials or raw auth logs in repository/public output.

## Implementation tasks

1. Translate validated task authority into deny-default profiles. No broad personal-home read grants or writable shared Git/policy roots. Preserve approved ordinary outbound networking; no proxy/destination isolation requirement.
2. Resolve executable/interpreter/library dependencies narrowly and explicitly. Missing tool, cache, socket, trust, terminal, or policy permissions block rather than widen automatically.
3. Keep enforcement resources outside worker-writable scope and snapshot/attest policy identity. Cover tools, child processes, symlinks, alternate launch paths, and unsupported delegation channels.
4. Implement a credential lifecycle with one explicit refresh owner and serialized ownership. Do not refresh independent worker copies or overwrite personal stores. Workers receive only the selected provider, not multi-provider stores or general Keychain access.
5. For Pi, use the public injectable credential-store contract for a deliberate read-only bridge if needed. CLI auth-lock denial blocks reads; enabling the lock is not a no-refresh solution. For other runtimes, require documented non-refreshing/owned behavior or return unavailable. Never fabricate safe parity.
6. Credential expiry and owner loss revoke/retire affected execution with preserved work. Actual subscription refresh is an explicitly gated operation; no refresh/auth/model network activity is performed in this implementation pass.
7. Design registration before assignment binding; monotonic supervision leases; process identity validation; independent watcher health; TERM/KILL escalation; child/session/resource reconciliation; and watcher-loss response. A live process-group/pane status is not sufficient proof of stopped work.
8. Prevent accidental signalling of unrelated/reused PIDs. Document native limitations/races and block replacement/reuse on uncertain ownership. Do not claim exhaustive ownership from sampled `ps` descendants.
9. Write fixtures/fakes for native profile generation, scoped denials, missing capabilities, policy tampering, credential expiry/rotation/owner loss, registration interruption, detached children, coordinator/watchdog loss, and unfinished-work preservation.

## Completion criteria

- Real execution defaults to blocked until required capability evidence exists; no hidden bypass path.
- Credential and supervision service contracts are implemented, not a TODO around unrestricted launch.
- Unimplementable native guarantees are explicitly surfaced as unavailable capabilities/release blockers; stronger/weaker architecture remains unapproved.
- No renewed feasibility or live credential/model probes. Publication checks now; final offline/disposable verification in 10.

## Commit boundary

Mark this milestone/index complete only when deliverables/refusal paths exist; commit/push `feat: milestone 05 — containment and independent supervision`.

## Completion record

- Completed: 2026-10-06. `src/isolation/`: deny-default Seatbelt profile generation and access diagnostics (`profile.ts`), narrow executable/interpreter/dynamic-library dependency resolution (`dependencies.ts`), version-bound capability records with human-only evidence recording (`capabilities.ts`), credential sources, policy-gated projection, rotation checks, and destruction (`credentials.ts`), process observation (`processes.ts`), owned-process registry with registration intents (`registry.ts`), verified termination (`terminate.ts`), the independent watcher and its process entry point (`watcher.ts`, `watcher-main.ts`), the coordinator supervision client (`supervision.ts`), and the contained launcher (`launcher.ts`, `launcher-main.ts`); tests in `tests/unit/isolation/`.
- Implementation decisions:
  - The boundary is a generated `sandbox-exec` profile: deny default; process exec/fork; signals only within the same sandbox; path metadata readable (contents are not); explicit system, task, dependency, output, scratch, and projection read roots; writes only to task write roots, output, and scratch; the assigned terminal device only when the launcher can identify it; approved ordinary outbound IP networking plus the OS DNS socket; owned localhost ports. Protected Git/state/policy paths, the worktree Git pointer, credential projections (write), and personal credential stores (read and write) are denied after the allows. No Mach services (including Keychain) are granted. Paths that cannot be expressed safely are refused.
  - Dependencies resolve the executable's real path, script interpreters, and Mach-O libraries (`otool`, including `@rpath`/`@loader_path`); anything unresolved is reported missing so the caller blocks instead of widening access.
  - Capabilities (`containment.*`, `supervision.*`, `runtime.<runtime>.*`, `credential.<runtime>.non-refreshing-access`, `billing.<runtime>.subscription-path`, `transport.herdr.owned-panes`) are unverified until evidence bound to OS major version, runtime version, toolchain, and policy template is recorded through explicit human input. Every runtime capability is currently unverified, so actual worker launch is denied.
  - Credential projection rechecks the proposal 0015 pairing and requires verified credential/billing capabilities before any source is read; Anthropic credentials are never projected to Pi or Codex. Only the selected provider's subscription OAuth record is projected (Pi: single-provider `auth.json`; Codex: `CODEX_HOME/auth.json`; Claude Code: `CLAUDE_CONFIG_DIR/.credentials.json` from one named Keychain item read by a host helper), as a mode-0400 file in a private directory whose credential files are write-denied by the profile. API keys and unknown types are refused; unknown expiry or insufficient validity for the assignment blocks. Radian performs no refresh; personal stores are read-only; rotation of the personal store retires the projection. Launch environments containing API-key, endpoint, or proxy variables are refused.
  - The Pi CLI's auth-lock requirement means CLI credential reads remain blocked; a Pi SDK read-only store bridge is left to the Pi adapter and still requires `credential.pi.non-refreshing-access` evidence.
  - Supervision: the launcher records a registration intent before spawning and registers the runtime's PID + start time immediately after, before binding can be confirmed. Termination signals only registered processes and their sampled descendants (TERM, grace, identity re-check, KILL, re-observe), never PID ≤ 1, the coordinator, or the watcher. Processes found only because their working directory is in owned roots are never signalled but make the postcondition `unknown`, as do interrupted registrations or an unavailable process table. `unknown` blocks replacement and reuse.
  - The watcher is a separate detached process fed heartbeats over a pipe only the coordinator holds; EOF (crash) or monotonic lease expiry (stall) stops every watched assignment, destroys its credential projections, records termination evidence and `loss.json`, preserves worktree/output content, and never relaunches. The client reports watcher loss or stale status as unhealthy supervision.
- Checks before publication: private denylist **not supplied** (private-term coverage absent); bounded publication check and exact staged-diff review before commit. Milestone-local sanity run: `tsc --noEmit` clean; full unit suite passed, including real `sandbox-exec` denials on synthetic fixtures, a real detached TERM-ignoring child escalated and verified gone, a real watcher process stopping a registered process after heartbeat loss, and a contained synthetic launch (not the milestone 10 run). No leftover test processes were found afterwards.
- Deferred verification / limitations: actual runtime/authentication coverage remains unverified until separately evidenced. `sandbox-exec` is deprecated. Process identity is sampled, not an atomic handle; descendant discovery is not exhaustive (cwd discovery is heuristic and non-signalling). Watcher loss itself is detected by the coordinator but cannot be covered if both coordinator and watcher die. No live credentials were read and no refresh, model, or provider activity occurred.

## Requirements

[Native isolation](../../proposals/0008-local-isolation.md) · [Safety](../../proposals/0003-safety-and-publication.md) · [Known gaps](../../research/feasibility-results.md) · [Authorization](../../proposals/0014-unattended-implementation.md)
