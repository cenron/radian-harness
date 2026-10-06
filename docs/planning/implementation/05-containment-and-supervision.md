# Milestone 05 — Native containment, credential ownership, and supervision

**Status: pending** · Depends on: 02–04

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

- Completed: not yet
- Implementation decisions: not yet
- Checks before publication: not yet
- Deferred verification / limitations: actual runtime/authentication coverage remains unverified until separately evidenced

## Requirements

[Native isolation](../../proposals/0008-local-isolation.md) · [Safety](../../proposals/0003-safety-and-publication.md) · [Known gaps](../../research/feasibility-results.md) · [Authorization](../../proposals/0014-unattended-implementation.md)
