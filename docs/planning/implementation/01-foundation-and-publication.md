# Milestone 01 — Package foundation and publication safety

**Status: pending** · Depends on: approved implementation plan

## Objective

Create the smallest usable TypeScript/Pi package foundation and a publication gate before later milestones push executable code. No installer or worker launch yet.

## Deliverables

- `package.json`, pinned lockfile, TypeScript configuration, supported local runtime/toolchain requirements, and documented package resource declarations.
- An understandable `src/` layout and thin test/maintenance entry points. Add directories only when files need them; preserve `tests/feasibility/` as historical experiments, not production adapters.
- A public-safety scanner with redacted actionable findings and clean/finding/error exit semantics. Cover tracked and untracked non-ignored text, staged Git blobs, and the committed tree being published.
- Generic rules for user-home paths, email addresses with narrow neutral/GitHub allowances, private IPv4, private-key headers, common token formats, and hardcoded secret assignments.
- An explicit optional private-denylist input outside the repository. Report absent denylist, unreadable inputs, binary exclusions, and scan errors honestly. Never print matched secret/private-term values.
- Narrow reviewed allowances with stable rule IDs; no whole-rule disabling to make this repository pass.
- Local publication command and CI generic checks; optional owned hooks must not overwrite personal hooks. Check commit author metadata and export/package manifests separately from file scans.
- Basic license/attribution policy, package-content allowlist, and `.gitignore` entries for generated/cache/private artifacts without hiding legitimate deliverables.

## Implementation tasks

1. Establish package scripts for static checks, final verification, and publication scanning. Use a standard small test runner; avoid unnecessary dependency layers.
2. Ensure package declarations match actual resources. Do not declare an extension entry point that does not exist; extend metadata in milestone 08 when the entry point is added.
3. Implement scanner inputs through Git's null-delimited listing/blob interfaces and deterministic error handling. Partial staging must scan staged content, not substitute working-tree content.
4. Add fixtures for every generic rule, safe examples, private-denylist case-insensitive matching, staged-only findings, missing/unreadable data, symlinks, binary policy, narrow allowances, and redacted diagnostics.
5. Add CI configuration that does not require private credentials or launch models. Behavioral jobs may be held until milestone 10 enables the final suite; publication safety must be usable now.

## Completion criteria

- Package/toolchain choices and public/private artifact boundaries are documented.
- The scanner and its tests are implemented; the scanner is run successfully on the exact staged content before this milestone is pushed.
- Scanner execution itself uses a bounded environment with read-only repository inputs and private scratch, not arbitrary candidate shell execution.
- No private denylist is invented. Record whether it was supplied; missing coverage is disclosed and is not confused with a clean private scan.
- Behavioral scanner fixtures and the full build/test suite are queued for milestone 10. No support claims are added.

## Commit boundary

Update this file and the index, review staged content/metadata, run whitespace and publication checks, then commit/push `feat: milestone 01 — package foundation and publication safety`. Verify the upstream contains the commit before starting 02.

## Completion record

- Completed: not yet
- Implementation decisions: not yet
- Checks before publication: not yet
- Deferred verification / limitations: full behavioral verification in milestone 10

## Requirements

[Publication safety](../../proposals/0003-safety-and-publication.md) · [Layout](../../proposals/0013-repository-layout.md) · [Execution contract](README.md)
