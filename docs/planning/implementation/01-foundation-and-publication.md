# Milestone 01 — Package foundation and publication safety

**Status: complete** · Depends on: approved implementation plan

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

- Completed: 2026-10-06. Package foundation (`package.json` marked private, pinned `package-lock.json`, `.npmrc` with lifecycle scripts disabled, `tsconfig.json`), shared argument-vector process and controlled-Git helpers (`src/util/proc.ts`, `src/git/exec.ts`), the publication scanner (`src/publication/`), thin entry points (`scripts/publication-check.ts`, `scripts/publication-hooks.ts`), generic-check CI (`.github/workflows/ci.yml`), scanner unit tests with runtime-assembled planted values, `.gitignore` entries, and the [development guide](../../development.md) covering toolchain, package boundaries, publication safety, and license/attribution policy.
- Implementation decisions:
  - TypeScript with erasable syntax only, executed by Node's built-in type stripping (Node `>=22.18.0`); `typescript` 7.0.2 for `--noEmit` checks and `node:test` for tests. No runtime dependencies; dev dependencies exact-pinned.
  - `package.json` declares `"private": true` and `UNLICENSED`: choosing a license is left to the owner, and accidental package publication is prevented. The `pi` key declares empty resource lists until real resources exist.
  - Scanner exit codes `0` clean / `1` findings / `2` incomplete-or-error. Findings print rule, kind, location, and (locally only) a 16-hex fingerprint; matched values and private terms are never printed.
  - Allowances require one rule, one exact path, one value fingerprint, and a reason; the allowance file is read from the same content source being scanned. Private-term matches cannot be allowed.
  - The private denylist is an explicit file outside the repository (`--denylist` or `RADIAN_PUBLICATION_DENYLIST`); absence is reported as missing coverage, never as a clean private scan.
  - On macOS the check re-executes under a sandbox profile that denies writes to the repository and Git directory, with private scratch; Git runs with a cleared environment and neutralized hooks/fsmonitor/pager/credential/external-diff channels.
  - The optional pre-push hook refuses to overwrite personal hooks or a configured `core.hooksPath`. It was implemented but **not installed** in this checkout.
  - The CI workflow runs generic publication checks only; behavioral jobs are added in milestone 10.
- Checks before publication: private denylist **not supplied** (private-term coverage absent). Bounded `npm run publication-check` over staged content, working tree, committed tree, unpushed commit metadata, package manifest, and whitespace before commit; exact staged diff reviewed. Milestone-local sanity run: `tsc --noEmit` clean and 18 scanner unit tests passed; this is not the milestone 10 verification run.
- Deferred verification / limitations: full behavioral verification in milestone 10. Pattern coverage is text-only (binary/ignored files, images, letter-only secrets, and history outside the scanned range are not covered). CI has not yet been observed running remotely.

## Requirements

[Publication safety](../../proposals/0003-safety-and-publication.md) · [Layout](../../proposals/0013-repository-layout.md) · [Execution contract](README.md)
