# Milestone 02 — Configuration, roles, and task/result contracts

**Status: pending** · Depends on: 01

## Objective

Make resolved profiles and assignment authority explicit, validated, runtime-neutral, and durable. Model choice must never imply broader authority.

## Deliverables

- `config/harness.json`: default workspace concurrency three, assignment execution limit 30 minutes, three total candidate rounds, one automatic infrastructure recovery, and fail-closed execution policy.
- `config/dispatch.json`: named runtime/model/effort profiles and auditable task-routing rules. Pi is the default runtime; Codex CLI and Claude Code are also represented. Do not invent runnable model IDs for unconfigured runtimes.
- Versioned schemas/validators and TypeScript types for configuration, workspace/project identity, run/task/assignment/attempt identity, task authority, approvals, candidate/check evidence, results, blockers, and owned resources.
- Runtime-neutral `workers/developer.md`, `tester.md`, `reviewer.md`, and `scout.md` with scope, inputs, deliverables, and escalation/refusal conditions.
- Deterministic config resolution: shipped defaults → workspace overrides → project overrides → explicit authorized assignment profile; snapshot effective configuration and provenance per run.
- Canonical path handling, explicit permitted read/write roots and output directories, role operation limits, protected Git/state paths, and permitted network/service policy in the resolved authority.

## Implementation tasks

1. Separate provider/model/effort, runtime, role, authority, and transport types. Native aliases must resolve to observable exact requested values; unsupported effort blocks rather than clamps silently.
2. Treat profile arrays as candidate sets, not fallback chains. Record a selected profile/rule/rationale; no automatic switching on auth/quota/launch failures.
3. Represent unconfigured profiles as unavailable and return a structured blocker. Keep implementation-session Opus/high selection separate from shipped target-workspace worker defaults.
4. Bind briefs to approved revisions, exact starting candidate/base, authority, round, remaining execution/recovery budget, and generation identity. Results cannot grant authority or approvals.
5. Define completed/blocked/failed/cancelled results and passed/failed/not-run/inconclusive check outcomes. Unknown usage/model attestation stays unknown.
6. Add fixtures/tests for schema rejection, precedence, profile provenance, unsupported values, traversal/symlink escapes, scope intersections, stale identities, and malformed/spoofed result envelopes.

## Completion criteria

- All later services consume validated contracts; no unvalidated model-generated launch strings or raw JSON cast as authority.
- Role guidance is clearly separate from mechanical enforcement.
- Required schemas/defaults and tests exist, with choices documented; no worker is launched.
- Publication checks run before push; full behavioral/schema test execution is deferred to 10.

## Commit boundary

Mark this milestone and the index complete; commit/push `feat: milestone 02 — configuration and worker contracts` after publication checks.

## Completion record

- Completed: not yet
- Implementation decisions: not yet
- Checks before publication: not yet
- Deferred verification / limitations: full behavioral verification in milestone 10

## Requirements

[Dispatch](../../proposals/0002-worker-dispatch.md) · [Roles](../../proposals/0004-subagent-design.md) · [Contracts](../../proposals/0005-task-contract.md) · [Local limits](../../proposals/0008-local-isolation.md)
