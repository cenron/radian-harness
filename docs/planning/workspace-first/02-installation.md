# W02 — Empty-workspace installer

**Status: pending.** Dependency: W01.

## Work

1. Decouple workspace bootstrap from project registration. An existing empty non-Git directory with zero projects is valid. Install exactly one owned Radian entry into workspace `.pi/settings.json`; retain explicit project-local entries for direct access.
2. Add a thin `install.sh` delegating to the canonical installer. Resolve source assets relative to the script and the target from the displayed/confirmed caller directory or `--workspace`. Quote paths; keep harness source separate from workspace.
3. Preserve preview-first exact-plan confirmation/hash apply, source pinning, transactional ownership, status/update/remove/recover, active/unresolved-run guards, and edited/unrelated settings. Check local Node/Git/Pi prerequisites; no global installation, trust/login acceptance, or unpinned acquisition.
4. Support legacy manifests and workspace-only repeated installation/update/remove. Do not migrate active policy or automatically modify old installations.
5. Cover directory creation as well as file opens: final no-follow open does not protect missing-parent mkdir (F01). Use a safe creation design or conservative refusal; do not introduce another escape while deferring final F01 revalidation to W06.
6. Include necessary installer assets in package contents while excluding private state/evidence. Preserve the external source and user projects on removal.

## Acceptance/tests

Disposable fixtures cover zero-project CLI, empty non-Git target, spaces, invocation from another directory, repeated install, malformed/unrelated settings, stale plans, missing prerequisites/source, moved/nested/linked paths, substitution before parent creation, legacy manifests, interruption, and update/remove with no projects.

Preview writes nothing. Apply loads Radian from the workspace root without making the workspace a Git repository. Refused operations cannot mutate outside paths; edited owned material and private artifacts are retained.

## Completion record

Not started.
