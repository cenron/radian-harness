# Milestone 09 — Workspace binding, installer, and operational documentation

**Status: pending** · Depends on: 01–08

## Objective

Implement explicit non-destructive binding to an external harness package and document the actual operational/support boundaries. Do not install into the user's workspaces.

## Deliverables

- Install/preview/status/update/remove command surface with explicit workspace/project targets.
- Pi-supported package binding: pinned normal release identity and explicit local-development binding; deliberate project/worktree resource loading, not assumed parent inheritance.
- Ownership manifest for files/settings entries, original hashes/source identity, project registration, and safe transactional/interrupted-operation recovery.
- Active-run guards, duplicate/canonical binding detection, symlink safety, local-edit preservation, and non-destructive remove/update.
- User/developer docs for configuration, profiles, roles, approvals, budgets, lifecycle/recovery, capability blockers, evidence storage, diagnostics, and maintenance.
- Public-safe package/export manifest and documented release acceptance checklist.

## Implementation tasks

1. Require an explicit target and preview before an owned mutation. Commands used in scripts can take an explicit reviewed operation plan; lack of interaction is not implied target authorization.
2. Do not overwrite `AGENTS.md`, personal settings, credentials, or unrelated `.pi` entries. Prefer namespaced resources and minimal owned settings.
3. Register projects explicitly; reject duplicate/moved/ambiguous canonical bindings. Do not recursively bind all repositories in a workspace.
4. Only update/remove provably owned unchanged material. Preserve local modifications and unrelated settings; report conflicts. Remove binding, not project deliverables, external sources, or credentials.
5. Refuse update/remove during active or unresolved runs. Preserve version/config policy for paused work and require explicit migration.
6. Handle interrupted write/manifest/config operations safely through journaled or equivalent bounded transactions. Never rollback by discarding unrelated user changes.
7. Document installation as available tooling but do not imply an installed target or verified worker support. Expose implemented/verified/unavailable capabilities distinctly.
8. Add genuinely useful workflow skills/prompts only where they improve user guidance. They cannot own approval/containment enforcement.
9. Author disposable-fixture tests for install preview, merge with existing configuration, local edits, update/remove, active runs, source drift/missing files, moved targets/symlinks, duplicate binding, and interruption recovery.
10. Review package inclusion boundaries: no run artifacts, auth, raw logs, private configuration/denylist, snapshots, or target project content.

## Completion criteria

- All installer operations and preservation/refusal paths are implemented and documented.
- No real workspace/project binding has been applied and no host-global installation performed.
- Documentation reflects unverified native/runtime coverage and contains no “fully supported” claims without evidence.
- Full installer/package behavior verification is deferred to 10; publication checks run now.

## Commit boundary

Mark this milestone/index complete; commit/push `feat: milestone 09 — workspace binding and installer`.

## Completion record

- Completed: not yet
- Implementation decisions: not yet
- Checks before publication: not yet
- Deferred verification / limitations: disposable installer verification in milestone 10; real target installation not authorized

## Requirements

[Workspace binding](../../proposals/0010-workspace-binding.md) · [Installer/release gates](../../proposals/0011-installer-and-release-acceptance.md) · [Layout](../../proposals/0013-repository-layout.md)
