# Implementation plan — table of contents and progress

**Status: authorized implementation plan. Feasibility testing is stopped.**

The user authorized a new **Claude Code / Opus 5.5 / high** session to implement Radian without routine interaction, mark milestones complete as they finish, and commit and push each milestone. This plan and the preserved feasibility checkpoint are authorized for commit/push now. [Proposal 0014](../../proposals/0014-unattended-implementation.md) records this authorization and supersedes the feasibility-only work restriction, not the product's safety requirements.

## Table of contents

| Order | Milestone | Status | Depends on |
| --- | --- | --- | --- |
| 01 | [Package foundation and publication safety](01-foundation-and-publication.md) | complete | This plan |
| 02 | [Configuration, roles, and task/result contracts](02-configuration-and-contracts.md) | complete | 01 |
| 03 | [Durable state, approvals, reservations, and budgets](03-state-and-authority.md) | complete | 02 |
| 04 | [Worktrees, candidate delivery, and controlled Git](04-worktrees-and-git.md) | complete | 03 |
| 05 | [Native containment, credential ownership, and supervision](05-containment-and-supervision.md) | complete | 02–04 |
| 06 | [Pi, Codex, Claude, and Herdr adapters](06-runtime-and-herdr-adapters.md) | complete | 05 |
| 07 | [Engineering orchestration, integration, and metrics](07-orchestration-and-metrics.md) | pending | 03–06 |
| 08 | [Pi coordinator interface](08-pi-interface.md) | pending | 07 |
| 09 | [Workspace binding, installer, and operational documentation](09-binding-and-installer.md) | pending | 01–08 |
| 10 | [Final automated verification and capability checkpoint](10-final-verification.md) | pending | 01–09 |

A milestone's `complete` means its implementation/deliverables are finished and its completion record has been committed. It does **not** mean a runtime is verified, a target project is installed, or a release is production-ready. Maintain separate implementation, verification, and release/support status.

The copy-ready [new-session prompt](new-session-prompt.md) starts this sequence. If interrupted, resume from the first incomplete milestone after reconciling status files with local/remote commits; never blindly repeat a completed push or discard unfinished changes.

## Execution contract

1. Read `AGENTS.md`, the [handoff](../session-handoff.md), proposals 0014–0015, this index, each milestone before starting it, and the linked product requirements/evidence. Earlier planning-only headings are historical.
2. Confirm the session is **Claude Code / Opus 5.5 at high effort**, through native runtime state rather than inference from this prompt. Use Claude Code's supported claude.ai subscription path, not Pi's Anthropic OAuth/extra-usage path. If unavailable, record a blocker and stop; no model/runtime/auth fallback or effort change.
3. Check branch, upstream, Git status, and recent history. The intended development branch is `main` tracking `origin/main`. Preserve unrelated changes. Never reset/clean/stash/rebase away work or force-push.
4. Work serially in milestone order. The authorized scope is developing this harness repository; this permits the implementation session to edit its source. It does not grant future Radian coordinators routine production-write authority in target projects.
5. Use the layout in [proposal 0013](../../proposals/0013-repository-layout.md). Create only useful files, not an empty scaffold. Prefer TypeScript, Pi's supported package mechanism, small explicit modules, validated JSON configuration, and a minimal pinned local toolchain.
6. Read the installed Pi/Herdr/runtime documentation and relevant examples completely before relying on APIs. Use the installed CLI help as the version-specific authority. Do not copy third-party code without license/attribution review.
7. Make ordinary reversible implementation decisions without asking. Record material choices and their rationale in the milestone file. Avoid invented infrastructure, cloud services, a network proxy, stronger isolation, or weakened containment.
8. Write the relevant automated tests with each milestone, but defer the full behavioral/build/runtime verification run to milestone 10. Do not resume feasibility probes or launch live model/authentication experiments during implementation. Minimal file/link/schema review and whitespace/publication checks still happen before every commit/push; never defer publication safety until after pushing.
9. Keep unsupported runtime execution **disabled/fail-closed** behind explicit capability/preflight results. Implement the adapters and safety mechanisms without claiming that previous synthetic tests validate real runtime execution. No blanket permission-bypass flags.
10. At each milestone boundary: finish deliverables; update its completion record and this table to `complete`; inspect the exact staged diff; run publication checks; commit; push the commit to the existing upstream; verify the remote contains it. Then continue automatically. Use `feat: milestone NN — ...` (or `test:` for milestone 10) as the commit subject. No release/tag/package publication is authorized.
11. Do not embed a milestone's own commit hash into that same commit. Store completion date, summary, and verification state in its file; Git history is the canonical commit record. Include the hash in the subsequent milestone record or final summary if useful. A failed push remains a local completed commit with publication pending: record the safe blocker and stop; do not rebuild/recommit it just to change its hash.
12. No routine progress questions or repeated approval requests. On a genuine safety/authorization/toolchain/Git-auth blocker, preserve work, mark the milestone `blocked` with a sanitized reason and safe next action, and stop. Do not guess approval, accept trust/login/elevation prompts, silently change scope, or mark unfinished work complete. Commit/push a safe blocker checkpoint when publication remains possible and authorized; otherwise leave it local and report it.

## Product invariants

- Pi remains coordinator; Pi default workers for eligible non-Anthropic subscription profiles; Anthropic models use Claude Code only under [proposal 0015](../../proposals/0015-anthropic-runtime-policy.md). Codex CLI and Claude Code remain in scope; Herdr is the terminal backend.
- Supported subscription paths only; OAuth alone is not proof of plan-limit billing. Anthropic through Pi/other workers and paid extra-usage spillover are prohibited. Unknown provider/billing-path evidence blocks credential projection and launch, with no silent rerouting. No API-key/pay-as-you-go use, direct provider endpoint probes, fallback, automatic spending/account changes, or effort escalation.
- Native macOS containment is required. Ordinary outbound networking was approved; do not require hostname isolation or add a proxy. Protect filesystem read/write scope, unrelated credentials, shared Git metadata, policy/approval state, and other processes.
- Fresh worker contexts; three total candidate rounds; one automatic infrastructure recovery per assignment; 30-minute execution budget with explicit blocked-time accounting; default configurable workspace-wide concurrency of three.
- Human-only, revision/hash-bound spec/brief, plan, and integration approvals. The authority to implement and push this repository is not authority to approve future target-project work. Noninteractive runtime workflows block when product approvals are missing.
- Candidate checks run inside contained assignments. Integrate only the exact verified candidate by controlled fast-forward with target/dirty-state checks. Preserve unfinished, dirty, unintegrated, or ambiguously owned work.
- Stop owned work on supervision loss. Pane closure and process-group cancellation alone are insufficient. Unknown termination blocks replacement and resource reuse.
- Native `/thinking`; Shift+Tab plan/build toggle with Tab autocomplete; `/calm` affects presentation only.
- No target-workspace installation, host-global tools, unrelated user panes, live provider/model tests, or releases in this unattended implementation run. Installer behavior is exercised only on disposable fixtures during final verification.

## Decisions delegated to the implementation session

Use conservative defaults rather than asking about every file or type name:

- TypeScript package with thin `extensions/` and implementation in `src/`; declarative public defaults in `config/`; runtime-neutral role documents in `workers/`; guidance in `skills/`/`prompts/` only when genuinely used.
- Validated, versioned JSON contracts; append-only durable events plus reconstructable snapshots; explicit transition functions; local atomic writes/locking and generation/lease identities. Avoid a database dependency unless necessary and documented.
- Workspace defaults followed by project overrides, then explicit authorized task profile; snapshot the effective configuration for each run. Profile arrays are candidate sets, never automatic fallback chains.
- Minimal public-safe dependencies, pinned locally; use install commands that do not execute dependency lifecycle scripts by default. No host-global installation. A dependency requiring unsupported access becomes a blocker.
- Missing runtime/model/effort/capability evidence returns a structured blocker, not an invented model identifier or uncontained execution.

## Final deliverables

A coherent implementation, automated tests, user/developer documentation, and a final [verification report](10-final-verification.md). Every milestone is committed/pushed, or explicitly blocked with preserved work. The final report lists commit identities, checks passed/failed/not run, runtime capability gaps, and release blockers. Credentials, raw host/runtime logs, prompts from private projects, and personal paths stay outside this public repository.
