# 0011 — Installer operations and first-release acceptance

**Status: direction confirmed. The user has finalized the plan and authorized the first feasibility milestone; see proposal 0012 for the current checkpoint.**

## 1. Confirmed installer direction

- Provide install, status, update, and remove operations.
- Require an explicit workspace target and preview changes before applying them.
- Track owned files/settings and installed hashes.
- Explicitly register projects; do not silently bind every nested repository.
- Preserve local modifications and report conflicts.
- Block updates/removal while affected runs are active.
- Recover safely from interrupted operations.

Precise command syntax, manifest schema, transaction/rollback mechanics, and configuration locations remain detailed design work. Existing non-destructive workspace-binding requirements remain in force.

## 2. Confirmed first-release gates

Before advertising the harness as usable or a runtime as supported, demonstrate:

- Complete developer → tester → reviewer → human-approved integration flow.
- Verified role restrictions and native containment for each supported runtime.
- Fresh-context repairs, three-round exhaustion, crash and quota recovery.
- Workspace-wide concurrency enforcement and timeout accounting.
- Safe cancellation, stale-result rejection, and preservation of unfinished work.
- Non-destructive installation, update, and removal.
- Calm and Tab mode switching without approval bypass.
- Metrics with accurate running harness-version provenance.
- Publication scanning and release-artifact review.

All three worker runtimes remain in product scope; sequencing validation does not reduce scope. CLI/documentation inspection is not an enforcement test.

## 3. Planning checkpoint

The main product decisions and release direction are agreed. The pre-implementation review is complete and the user has finalized the plan and authorized the first feasibility milestone, after committing and pushing the planning baseline. Earlier planning-only restrictions are historical; the current bounded implementation scope is in proposal 0012.

Concrete macOS containment is still unresolved: select a mechanism and verify coverage rather than treating deprecated sandbox-exec availability or runtime permission flags as proven support. Remaining technical details include auth/refresh compatibility, shared Git metadata restrictions, network enforcement, cross-coordinator reservations, and precise timer boundaries. Surface any incompatible requirement before implementation relies on it; ask before weakening policy or changing product scope.

## Related proposals

- [Workspace installation/removal](0010-workspace-binding.md)
- [Local execution and limits](0008-local-isolation.md)
- [Interface and finalization](0007-interface-and-finalization.md)
