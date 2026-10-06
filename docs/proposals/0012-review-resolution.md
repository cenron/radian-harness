# 0012 — Adversarial-review resolution and readiness checkpoint

**Status: accepted product decision checkpoint. Its original feasibility-only authorization is superseded by [proposal 0014](0014-unattended-implementation.md): the user stopped testing and authorized unattended implementation with milestone commits/pushes. Full worker-runtime support remains gated on verification.**

This document supersedes conflicting early proposal text. The user accepted the coordinator's recommendations following the adversarial review and requested Shift+Tab instead of Tab.

## 1. Confirmed interface change

- Shift+Tab toggles plan/build, replacing Pi's default thinking-level cycle within Radian-managed sessions. Ordinary Tab remains autocomplete.
- Keep native `/thinking [level]` for coordinator thinking control. Do not add an alias. Validate model-supported levels and avoid silently changing worker profiles.
- Mode switching never grants approval or starts work automatically.
- Entering Plan immediately blocks new modifying dispatch. Ask for confirmation before pausing already-running modifying workers; show ongoing work explicitly so PLAN does not falsely imply quiescence.
- Changes to managed shortcuts must be explicit and reversible, without taking over unrelated personal keybindings. Verify the actual integration surface before implementation relies on it.

Pi 1.0.2 slash-command documentation lists `/thinking`, not built-in `/effort`.

## 2. Subscription authentication requirement

The user clarified that normal harness usage is subscription-backed OAuth through Pi, Codex CLI, and Claude Code, not API-key/pay-as-you-go billing. Do not switch to an API key, billing account, or a different authentication method silently. Use each runtime's supported subscription login path. Pi profiles must use an eligible non-Anthropic subscription provider; Codex uses ChatGPT authentication and Claude uses claude.ai authentication. [Proposal 0015](0015-anthropic-runtime-policy.md) amends this requirement: Anthropic workers must use Claude Code only, because subscription OAuth in Pi can still incur per-token extra-usage billing. OAuth alone is not evidence of plan-limit billing; no paid spillover or silent rerouting is authorized.

Direct provider connectivity probes made during initial feasibility were unauthenticated HTTPS HEAD requests, not inference calls. Following the clarification, stop direct endpoint probes and validate future connectivity through the runtime's subscription path. No API-key credential or paid inference was used in those probes.

## 3. Accepted boundary and integration direction

- Select and validate a macOS-native containment mechanism before runtime tooling relies on it. If it fails required checks, block and ask; no automatic weaker execution, alternate runtime, or scope expansion.
- Whole-worker sandbox-exec is a feasibility candidate, not proven support. Its deprecation and runtime/auth compatibility are explicit risks. The user has now explicitly accepted the simpler outbound policy after feasibility showed that the tested native address filter rejects hostnames: ordinary outbound networking is permitted for developer/tester/scout tasks. Do not claim enforced provider/registry destination allowlisting or introduce a proxy. Model-provider connectivity is necessary for all worker roles; reviewer tools remain read/report-only with no arbitrary shell or general network operations. Actual whole-process networking is not a per-destination credential boundary. Filesystem, role, Git, and coordinator-state restrictions remain mandatory.
- Retain worktrees, but protect shared Git hooks/configuration and other task/target refs. Prefer workers delivering file changes/patches with controlled harness operations owning commits and integration. Coordinator Git must not execute worker-influenced hooks/helpers. Exact permitted Git operations require feasibility validation.
- Execute candidate builds/tests/installers only inside contained assignments, consuming worker capacity; the coordinator validates evidence rather than running candidate code unrestricted.
- Approvals are written only through explicit user-initiated commands/UI, never a model-callable approval tool. Bind them to artifact hashes/revisions. Changed approved artifacts invalidate approval pending a recorded human decision; ordinary code choices within approved scope do not rewrite approved requirements.
- The human chooses/approves the lightweight-brief path. Coordinator tools deny routine production writes in both modes; narrowly approved controlled integration remains separate.
- Stop/pause workers on loss of healthy coordination. Cover crashes as well as orderly exit through a minimal independent safety mechanism if required. Quota scheduling runs only under healthy supervision; no unattended retry after coordinator loss. Exact watchdog/lease mechanics remain technical design.
- Prefer fast-forward integration to the exact verified commit. Refuse target drift or conflicting dirty state; no automatic squash/rebase/stash into an unverified candidate. Reassemble/reverify and seek renewed approval when candidate/target changes.

## 4. Accounting and simplification direction

Accepted follow-up direction, with exact mechanisms still to specify:

- Start assignment execution time at confirmed assignment binding, excluding queue/preflight and recorded question/quota blocking. Replacements inherit remaining time; insufficient time returns to a human decision, not a silent extension.
- The one automatic recovery cap does not grant human-approved retries. Additional relaunches require explicit recorded human authorization; neither resets candidate rounds or execution budgets.
- Conflict/test-defect corrections may not create a hidden fourth candidate cycle. Classify evidence/infrastructure failures separately and surface ambiguous accounting.
- Shared concurrency reservations require cross-coordinator locking and verified ownership/liveness before reclaim. Resolve duplicate workspace/project binding before relying on capacity guarantees.
- Preserve original version/config artifacts for paused runs; adopting newer policy requires explicit migration/authorization.
- Minimize installer-owned configuration and avoid AGENTS.md edits by default. Start metrics with provenance, durable events, and simple per-version summaries; sophisticated comparisons remain later evaluation work rather than a release prerequisite.
- All three worker runtimes remain in scope. Do not claim support before validation passes; any reduced initial advertised release scope requires explicit agreement.

## 5. Readiness and proposed first milestone

**READY WITH CONDITIONS for a feasibility-first implementation sequence**, not verified readiness for production workers.

The user has explicitly finalized the plan and authorized this first milestone, after committing and pushing the planning baseline. The milestone uses disposable fixtures to validate macOS containment, runtime authentication/refresh, read/write denials, shared Git metadata restrictions, candidate execution, Herdr launch/detection, and safe termination/supervision loss. Use isolated test sessions, not ordinary user panes. Preserve safe diagnostics, never credentials.

Checkpoint: report enforced capabilities and gaps for each runtime. Do not build unrestricted worker execution around an unproven boundary. Revisit incompatible requirements with the user. Binding/approval/durable-state work can follow once boundaries are credible.

## Related documents

- [Adversarial findings](../research/adversarial-plan-review.md)
- [Interface](0007-interface-and-finalization.md)
- [Local containment and budgets](0008-local-isolation.md)
- [Integration](0009-approval-and-integration.md)
- [Release gates](0011-installer-and-release-acceptance.md)
