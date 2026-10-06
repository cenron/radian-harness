# Session handoff — approved feasibility milestone

## Current authorization

The user has explicitly finalized the plan and authorized the first feasibility milestone. **First commit and push the planning baseline, then begin bounded feasibility work.** Subsequent pushes and installation into target workspaces are not implicitly authorized.

The user declined an effort-command alias: use Pi's native `/thinking`. Shift+Tab toggles plan/build in managed sessions; Tab stays autocomplete.

Proposal 0012 is the latest decision checkpoint and supersedes historical planning-only status notes. No harness or installer has been implemented yet. Native containment has not been verified.

## Read these documents

- [0001 — Overall direction](../proposals/0001-direction.md)
- [0002 — Runtime-neutral dispatch](../proposals/0002-worker-dispatch.md)
- [0003 — Guardrails and publication safety](../proposals/0003-safety-and-publication.md)
- [0004 — Roles, fresh contexts, and round cap](../proposals/0004-subagent-design.md)
- [0005 — Task/result contracts](../proposals/0005-task-contract.md)
- [0006 — Lifecycle, quota recovery, and improvement](../proposals/0006-lifecycle-and-improvement.md)
- [0007 — Coordinator interface](../proposals/0007-interface-and-finalization.md)
- [0008 — macOS worktrees, permissions, and budgets](../proposals/0008-local-isolation.md)
- [0009 — Approval validity and integration](../proposals/0009-approval-and-integration.md)
- [0010 — Workspace installation/removal](../proposals/0010-workspace-binding.md)
- [0011 — Installer operations and release gates](../proposals/0011-installer-and-release-acceptance.md)
- [0012 — Review resolution and authorized milestone](../proposals/0012-review-resolution.md)
- [Technical evidence and limitations](../research/reference-notes.md)
- [Adversarial review](../research/adversarial-plan-review.md)

## Confirmed product direction

- Independent external harness, explicitly bound to selected workspaces/projects through Pi's supported package mechanism. Project-local Pi coordinator; one active run per project initially.
- Pi default workers, with Codex CLI and Claude Code in scope; visible Herdr panes, fresh contexts and bounded artifact handoffs.
- Developer, tester, reviewer, and optional scout. Design work belongs in PRD development when needed. Pi delegates production edits and semantic conflicts.
- PRD/spec, plan, and integration approval gates, with human-approved lightweight briefs for small fixes. User-initiated controls write revision/hash-bound approvals; worker reports cannot approve.
- Three total candidate cycles per task. Default configurable workspace-wide ceiling of three active workers, supporting multiple workers of each role. Reserve slots before launch; live blocked workers retain slots.
- Thirty-minute assignment execution limit. Start at confirmed assignment binding; exclude queue/preflight and question/quota waits. Recovery inherits remaining execution time.
- One automatic infrastructure recovery per assignment; additional attempts need explicit human authorization. Quota recovery preserves work and supports scoped approval to wait for a reliably reported reset and retry once with the same profile. No silent runtime/model fallback or effort escalation.
- macOS initially, Git worktrees, native OS containment; no container requirement. Fail closed if required restrictions cannot be established.
- Ordinary scoped checks/builds, locked local dependency installation, and task-owned local services are allowed. New dependencies must fit approved scope or ask. Host-global/elevated operations ask. Network policy permits selected providers/registries/approved local services, with enforcement still to verify.
- Protect shared Git metadata and coordinator policy/state. Prefer worker change delivery with controlled commits. Candidate checks execute inside contained assignments; exact-candidate review and controlled fast-forward integration, with target drift/dirty-state protection.
- `/calm` changes presentation only. Shift+Tab switches modes without approval; Plan blocks new modifying dispatch and asks before pausing live workers. Native `/thinking` remains available with no alias.
- Local durable metrics include actual harness version/revision/config provenance. On-demand improvement proposals require human approval; no autonomous rule changes or private-data export.
- Non-destructive install/status/update/remove, explicit targets/projects, owned configuration/hash tracking, preserved local edits, active-run guards, and safe interrupted-operation recovery. Pinned normal releases and explicit local-development bindings.

## First milestone and checkpoint

Use disposable fixtures and isolated Herdr test sessions to validate:

1. macOS containment mechanism and actual filesystem/process/network coverage.
2. Runtime authentication/refresh without broad credential exposure.
3. Allowed versus denied worktree/Git metadata operations.
4. Contained candidate execution and policy loading outside worker-writable scope.
5. Herdr launch/detection with selected runtime/native sandbox composition.
6. Termination, subprocess ownership, and supervision loss, including coordinator crashes.

Do not claim full parity from CLI help, read-only tools, or sandbox availability. `sandbox-exec` is available but deprecated; destination-level network enforcement is unresolved. Report capability gaps and obtain decisions before weakening containment or adding architecture such as a proxy.

The adversarial reviewer originally judged the plan NOT READY. Resolution direction is now accepted; current assessment is READY WITH CONDITIONS for this feasibility-first sequence, not production support. A read-only Opus 5.5/high review pane was explicitly authorized, then exited and closed; no review worker remains intentionally running.

## Publication and repository safety

Keep raw prompts, credentials, personal paths, private denylist values, and raw runtime logs outside public material. Sanitize fixtures and evidence. Required publication scanning covers generic patterns; private-denylist coverage must be disclosed, not assumed. Review staged content, commit metadata, and release artifacts separately. No scanner/hooks/CI integration exists yet.

The repository has an origin on the public hosting service and the user authorized its initial commit/push. Check live Git status/history rather than relying on a handoff snapshot.
