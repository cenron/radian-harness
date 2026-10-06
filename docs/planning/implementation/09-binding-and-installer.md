# Milestone 09 — Workspace binding, installer, and operational documentation

**Status: complete** · Depends on: 01–08

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

- Completed: 2026-10-06. Installer (`src/workspace/installer.ts`), command surface (`src/workspace/cli.ts`, `scripts/radian-workspace.ts`, `npm run workspace`), workspace layout (`src/workspace/layout.ts`, milestone 08), user and operations guide (`docs/user/README.md`), release acceptance checklist (`docs/user/release-acceptance.md`), coordinator workflow skill (`skills/radian-coordinator/SKILL.md`), package metadata and content boundary updates, README links, and disposable-fixture tests in `tests/unit/workspace/`.
- Implementation decisions:
  - Commands: `install`, `update`, `remove`, `status`, `recover`, each with an explicit `--workspace`. Mutating commands preview by default; `--apply <plan-hash>` applies only if the recomputed plan hashes identically to the one reviewed, so scripts can apply a reviewed plan without implying target authorization. Workspace and project identifiers are derived from canonical paths so plans recompute deterministically.
  - Every operation is a plan of whole-file replacements with compare-and-swap preconditions (expected absent or content hash). A stale plan fails without writing. A journal records the plan and progress; an interrupted apply blocks new operations until `recover` completes steps still at their prior state or already at their planned result and reports anything else as a conflict — nothing is rolled back over user changes.
  - Ownership is minimal: `<workspace>/.radian/workspace.json`, the project registry, the manifest, and one `{ "source": … }` entry in each explicitly registered project's `.pi/settings.json`. Other settings and package entries, `AGENTS.md`, personal Pi configuration, keybindings, and credentials are never modified. Projects must be repository roots inside the workspace with an explicit, existing `refs/heads/<branch>` target; subdirectories, outside repositories, the harness checkout, nested workspaces, symlinked `.pi` paths, unparseable settings, unowned Radian-like entries, and re-registration with a different target are refused or reported.
  - Bindings: local development (`--local`, a path relative to the project's `.pi/` that Pi resolves in place, with recorded source revision and local-modification state) or pinned release (`git:…@<40-hex>` or `npm:…@x.y.z`); unpinned sources are refused. Project trust is never granted by the installer.
  - Update and remove are refused while any registered project has an active or paused run, a live or unverifiable coordinator lease, or workspace capacity reservations exist. Update replaces only unchanged owned entries and records the new source; locally modified entries are preserved and reported. Remove deletes only unchanged owned material (and a settings file only if Radian created it and it is now empty), retaining runs, evidence, metrics, worktrees, overrides, the harness checkout, projects, and credentials.
  - Status reports source and availability, projects (including moved/missing paths), owned-entry and owned-file states, active runs, and interrupted operations.
  - Documentation describes the implemented behavior and explicitly states that no runtime is verified, that every launch is capability-gated, and that no command records capability evidence. One coordinator skill was added as workflow guidance; no prompt templates were added because none improved on the skill and commands.
- Checks before publication: private denylist **not supplied** (private-term coverage absent); bounded publication check, package-manifest check, and exact staged-diff review before commit. Milestone-local sanity run: `tsc --noEmit` clean; 114 unit tests passed, including seven installer fixture tests (not the milestone 10 run). No real workspace or project binding was applied and nothing was installed host-globally.
- Deferred verification / limitations: disposable installer verification in milestone 10; real target installation is not authorized. An empty `.pi/` directory created by the installer is left in place on removal because its ownership cannot be proven once empty.

## Requirements

[Workspace binding](../../proposals/0010-workspace-binding.md) · [Installer/release gates](../../proposals/0011-installer-and-release-acceptance.md) · [Layout](../../proposals/0013-repository-layout.md)
