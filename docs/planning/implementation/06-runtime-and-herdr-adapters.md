# Milestone 06 — Pi, Codex, Claude, and Herdr adapters

**Status: pending** · Depends on: 05

## Objective

Implement all three runtime adapters behind one contract and an owned Herdr transport. Implemented does not mean verified/supported.

## Deliverables

- Runtime adapter contract for version/capability preflight, exact profile, authority/policy loading, assignment binding, structured events/results, activity/blockers, interruption, termination, and recovery.
- Pi, Codex CLI, and Claude Code adapters using current documented APIs/CLI argument vectors and native role/tool restrictions composed with the outer OS boundary.
- Herdr transport for fresh pane creation, explicit owned IDs, no-focus launch, bounded command/event operations, and safe owned-pane retirement.
- Provider-safe error classification: quota, authentication, trust/permission, infrastructure, unknown; no fallback or profile changes.
- Requested/resolved profile, effective effort, runtime/native session identity, policy/config provenance, and honest unavailable vendor attestation.

## Implementation tasks

1. Read installed runtime docs/help before selecting flags. Avoid blanket native permission/sandbox bypass, undocumented auth fallbacks, and assuming Codex supports Claude hook shapes.
2. Recheck resolved runtime/provider/model policy before credential access and launch: Anthropic models require Claude Code's supported claude.ai subscription path. Reject forbidden or unresolved profiles before projecting credentials or creating panes; never silently reroute. Subscription OAuth alone does not prove plan-limit billing; do not enable paid extra usage or fall back to API keys/custom endpoints. Preflight all required runtime/tool/credential/containment capabilities before starting an assignment. Unsupported/unknown role capabilities reject the assignment.
3. Choose and document the Pi SDK/CLI boundary. A SDK bridge must use public interfaces, preserve runtime semantics, and explicitly report any missing interactive/Herdr detection parity.
4. Enforce reviewer read/report-only behavior without arbitrary shell/network/install tools; tester/developer/scout authorities intersect task scope. Disable unknown extension/MCP/nested/delegation channels unless controlled and registered.
5. Create fresh conversations/panes for every assignment/repair/recovery. Never auto-accept trust/onboarding/login prompts. Record a blocker instead.
6. Use returned Herdr pane IDs; do not derive them from layout or act on the UI-focused pane. Do not manipulate existing user panes during implementation.
7. Establish semantic assignment binding, not merely idle/detection. Persist structured results before notification, correlate identities/generations, and wait for genuine runtime settlement rather than rendered text or one transient event.
8. Preserve unknown/blocked/interrupted outcomes; bound startup/waits; avoid duplicate prompt delivery after uncertain transport timeouts. Scope interrupt/cancel to registered execution and verify postconditions through 05.
9. Author fake-runtime/socket/JSONL fixtures for all three adapters: flag/profile translation, Anthropic rejection outside Claude Code, unknown/aliased provider provenance, credential non-exposure and no silent rerouting, broken policy, unknown tools, startup/trust/auth blockers, quota, malformed/stale results, duplicate/missed events, cancellation, and fresh-context recovery.

## Completion criteria

- All three adapters and transport paths exist with genuine enforcement/refusal logic, not simulated success.
- Runtime support/capability status is explicit and defaults unverified paths to unavailable.
- No actual worker/model launch, personal credential use, or unrelated Herdr operations during this milestone.
- Publication checks now; contract/fixture verification runs in 10. Live provider tests are not authorized by this plan.

## Commit boundary

Mark this milestone/index complete; commit/push `feat: milestone 06 — runtime and Herdr adapters`.

## Completion record

- Completed: not yet
- Implementation decisions: not yet
- Checks before publication: not yet
- Deferred verification / limitations: separate SDK/CLI, transport, auth, and actual-runtime capability gaps

## Requirements

[Dispatch](../../proposals/0002-worker-dispatch.md) · [Lifecycle](../../proposals/0006-lifecycle-and-improvement.md) · [Feasibility gaps](../../research/feasibility-results.md)
