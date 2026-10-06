# 0009 — Approval validity, candidate integration, and cleanup

**Status: direction confirmed; planning only. No implementation approval.**

## 1. Confirmed approval validity

Approvals bind to specific artifact revisions:

| Approval | Covers | Requires renewed approval when |
| --- | --- | --- |
| PRD/spec or lightweight brief | Behavior, acceptance criteria, scope | Requirements or scope materially change |
| Plan | Task breakdown, assignments, verification strategy | Work materially expands or the strategy changes |
| Integration/merge | Exact verified candidate and target revision | Candidate or target changes |

Ordinary implementation details within approved scope do not require repeated approval. Runtime/model fallback and effort escalation still require separate explicit approval. Worker reports cannot grant approval.

## 2. Confirmed candidate assembly and verification

- Developer and tester deliver changes from their separate worktrees.
- Assemble a candidate in a dedicated integration worktree through controlled harness operations.
- Route semantic conflicts to a fresh developer assignment, not production edits by Pi.
- Run tests against the assembled candidate; a fresh reviewer reviews that same exact revision.
- Repairs produce a new candidate and consume the next candidate round under the existing three-round cap. Task renaming or extra integration assignments must not evade the cap.
- No worker merges into the protected target.

Exact Git delivery/assembly mechanics and how conflict work is accounted within a round remain to be specified. Dedicated integration work does not imply unrestricted coordinator shell authority.

## 3. Confirmed approved integration

Pi presents a compact summary of changes, checks, review outcome, remaining risks, and exact candidate/target identity. Only after explicit human approval may a narrow controlled operation integrate the candidate.

If the target moves, stop, rebuild/revalidate the candidate as needed, and seek renewed approval. Candidate changes also invalidate integration approval. Previous evidence remains historical rather than automatically valid for a new candidate.

## 4. Confirmed preservation and cleanup

- Never overwrite or discard pre-existing user changes.
- Retiring panes does not delete worktrees.
- Automatic cleanup is allowed only for provably owned, clean, integrated work with preserved evidence.
- Retain and surface dirty, unintegrated, or ambiguously owned work.

Existing lifecycle checks still require verified termination/resource ownership before cleanup. Report-only or cancelled tasks without integrated commits need a separately specified safe cleanup policy; this decision does not authorize deleting their unfinished artifacts.

## Related proposals

- [Direction and approval workflow](0001-direction.md)
- [Task/result contracts](0005-task-contract.md)
- [Lifecycle and metrics](0006-lifecycle-and-improvement.md)
- [macOS execution and worktrees](0008-local-isolation.md)
