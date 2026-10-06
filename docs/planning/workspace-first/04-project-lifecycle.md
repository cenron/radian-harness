# W04 — Project creation and registration

**Status: pending.** Dependency: W03.

## Work

1. Add user-initiated `/new-project <name>` and `/add-project <path>` over shared previewed/journaled services. Minimal bootstrap: independent Git repo, confirmed branch, narrow ignore rules, planning location, and direct-entry Pi binding. No framework/dependencies/hooks/remotes/product spec generation.
2. Confirm exact path/files/branch/bootstrap commit/registration. Check configured Git identity before writing; do not invent an identity or change global Git settings. These explicit setup commands work from the dashboard without granting product approvals or BUILD dispatch.
3. Create only a new destination strictly inside the workspace, outside protected state/source/other repositories/ambiguous nested workspaces. Existing destinations use explicit registration, not overwrite. Protect each mkdir/open against links and substitution, including F01's pre-mkdir window.
4. Use controlled Git with hooks/filters/signing/helper execution disabled. Initial commit contains only reviewed bootstrap files, never private state or unrelated material. Register the explicit commit-backed protected branch; offer `main` only as a confirmed new-project default.
5. Journal creation/commit/registration with ownership/generation identities. Serialize concurrent operations; reject stale plans. Recover provable owned steps, preserve edits/partial repositories, and never recursively delete a destination as rollback.
6. Existing registration validates repository root/target and preserves dirty work/history/settings. Unborn repositories require a blocker or a separately reviewed bootstrap, never an implicit commit of user files.
7. Request W05 activation only after successful registration. Failed activation preserves the project and reports honestly. Establish explicit project trust before executable project resources load.

## Acceptance/tests

Fixtures cover normal bootstrap/commit/registration, missing identity, reserved/invalid names, collision, traversal/links/pre-mkdir substitution, unwanted Git helpers/hooks/signing, exact commit contents, existing dirty repos, absent targets, repeated/concurrent/stale requests, and interruption at each durable step. Outside paths remain unchanged, even on refusal. No remote, model, dependency, or worker launch occurs.

## Completion record

Not started.
