# Milestone 02 — Configuration, roles, and task/result contracts

**Status: complete** · Depends on: 01

## Objective

Make resolved profiles and assignment authority explicit, validated, runtime-neutral, and durable. Model choice must never imply broader authority.

## Deliverables

- `config/harness.json`: default workspace concurrency three, assignment execution limit 30 minutes, three total candidate rounds, one automatic infrastructure recovery, and fail-closed execution policy.
- `config/dispatch.json`: named runtime/model/effort profiles and auditable task-routing rules. Pi is the default runtime for eligible non-Anthropic subscription profiles; Anthropic models require Claude Code. Codex CLI and Claude Code are also represented. Do not invent runnable model IDs for unconfigured runtimes.
- Versioned schemas/validators and TypeScript types for configuration, workspace/project identity, run/task/assignment/attempt identity, task authority, approvals, candidate/check evidence, results, blockers, and owned resources.
- Runtime-neutral `workers/developer.md`, `tester.md`, `reviewer.md`, and `scout.md` with scope, inputs, deliverables, and escalation/refusal conditions.
- Deterministic config resolution: shipped defaults → workspace overrides → project overrides → explicit authorized assignment profile; snapshot effective configuration and provenance per run.
- Canonical path handling, explicit permitted read/write roots and output directories, role operation limits, protected Git/state paths, and permitted network/service policy in the resolved authority.

## Implementation tasks

1. Separate provider/model/effort, runtime, role, authority, and transport types. Native aliases must resolve to observable exact requested values; unsupported effort blocks rather than clamps silently.
2. Validate resolved provider/model provenance and runtime compatibility after all overrides/aliases: Anthropic requires `claude-code`; reject Pi/Codex/custom-provider disguises and unknown provenance with a structured blocker, never silent rerouting. Treat profile arrays as candidate sets, not fallback chains. Record a selected profile/rule/rationale; no automatic switching on auth/quota/launch failures.
3. Represent unconfigured profiles as unavailable and return a structured blocker. Keep implementation-session Opus/high selection separate from shipped target-workspace worker defaults.
4. Bind briefs to approved revisions, exact starting candidate/base, authority, round, remaining execution/recovery budget, and generation identity. Results cannot grant authority or approvals.
5. Define completed/blocked/failed/cancelled results and passed/failed/not-run/inconclusive check outcomes. Unknown usage/model attestation stays unknown.
6. Add fixtures/tests for Anthropic/runtime rejection, aliases/custom-provider disguises, unknown provenance, overrides, no silent rerouting, schema rejection, precedence, profile provenance, unsupported values, traversal/symlink escapes, scope intersections, stale identities, and malformed/spoofed result envelopes.

## Completion criteria

- All later services consume validated contracts; no unvalidated model-generated launch strings or raw JSON cast as authority.
- Role guidance is clearly separate from mechanical enforcement.
- Required schemas/defaults and tests exist, with choices documented; no worker is launched.
- Publication checks run before push; full behavioral/schema test execution is deferred to 10.

## Commit boundary

Mark this milestone and the index complete; commit/push `feat: milestone 02 — configuration and worker contracts` after publication checks.

## Completion record

- Completed: 2026-10-06. Shipped `config/harness.json` and `config/dispatch.json`; strict validators and inferred types (`src/contracts/schema.ts`); identity, authority, brief, result, approval, check-evidence, owned-resource, and blocker contracts (`src/contracts/`); provider/runtime policy, runtime facts, dispatch selection, and layered resolution with per-run snapshots (`src/config/`); runtime-neutral `workers/developer.md`, `tester.md`, `reviewer.md`, `scout.md`; unit tests under `tests/unit/config/` and `tests/unit/contracts/`.
- Implementation decisions:
  - Validators are hand-written strict combinators (unknown fields rejected) rather than a schema dependency; the TypeScript validators are the authoritative schemas, so no duplicate JSON Schema files were added to `config/schemas/`.
  - Shipped profiles name runtimes and providers but leave `model: null`. They resolve to `PROFILE_UNCONFIGURED` until a workspace/project override sets an exact model, so no runnable model ID is invented. The shipped default is the Pi profile, with provider also unset until an eligible non-Anthropic subscription provider is configured.
  - The provider table is code-owned, not user-configurable: `anthropic` (Claude Code only, claude.ai subscription route) and `openai` (Pi ChatGPT OAuth, Codex ChatGPT login). Any other provider is unknown provenance and blocks. Adding providers is a future explicit decision.
  - Anthropic detection inspects the provider, requested model, resolved model, and every alias name in the chain (`claude|anthropic|opus|sonnet|haiku|fable`, and `anthropic|claude|bedrock|vertex` providers). Pi/Codex pairings return `ANTHROPIC_REQUIRES_CLAUDE_CODE`; Anthropic models through other providers on Claude Code return `PROVIDER_PROVENANCE_UNKNOWN`. Endpoint/key/proxy/billing fields return `CUSTOM_ENDPOINT_PROHIBITED`. `recheckResolvedProfile` repeats the check at later boundaries.
  - Native aliases (for example Claude Code `opus`), Pi globs, `provider/model` prefixes, and `:thinking` suffixes are not exact IDs and block. Effort values are checked against documented per-runtime lists; Codex's list is marked unverified for adapter preflight. Effort is never clamped.
  - Rule `use` arrays are candidate sets; `selection.onUnavailable` accepts only `block`. A rejected selection returns its blocker; no other candidate is tried.
  - Resolution order: shipped → workspace `.radian/config/` → project `.radian/config/`; objects merge by key, arrays/scalars replace; validation runs after each layer; snapshots are frozen with layer hashes, leaf provenance, and a content hash. The explicit authorized assignment profile is applied at selection (`userOverride`/`planAssignment`).
  - Overrides cannot raise candidate rounds above 3 or automatic recoveries above 1, nor change fail-closed capability policy, required containment, or the blanket-bypass prohibition.
  - Authority = role limits ∩ task request ∩ project policy. Operations outside role limits are refused rather than silently dropped. Reviewers have read/Git-inspect/report only and model-only network; dependency changes require explicit approved scope; writable roots may not lie inside protected Git/state/policy paths; output/scratch are separate from the worktree.
- Checks before publication: private denylist **not supplied** (private-term coverage absent); bounded publication check and exact staged-diff review before commit. Milestone-local sanity run: `tsc --noEmit` clean, 22 configuration/contract tests passed (not the milestone 10 run).
- Deferred verification / limitations: full behavioral verification in milestone 10. Effort lists are documentation-derived, not runtime-verified. Vendor-side model identity remains unverified unless a runtime reports it.

## Requirements

[Dispatch](../../proposals/0002-worker-dispatch.md) · [Roles](../../proposals/0004-subagent-design.md) · [Contracts](../../proposals/0005-task-contract.md) · [Local limits](../../proposals/0008-local-isolation.md)
