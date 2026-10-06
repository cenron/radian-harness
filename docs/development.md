# Development guide

**Status: harness under implementation. Nothing here claims verified worker-runtime support or release readiness.**

## Toolchain

| Component | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript, erasable syntax only | Runs directly under Node's built-in type stripping and under Pi's extension loader without a build step. |
| Runtime | Node `>=22.18.0` (type stripping enabled by default) | Avoids a transpiler dependency. Local development used Node 25. |
| Type checking | `typescript` 7.0.2, pinned, `noEmit` | Static checks only; nothing is compiled or bundled. |
| Tests | Node's built-in `node:test` runner | Avoids an extra test-framework dependency layer. |
| Dependencies | `@types/node` 22.20.5 and `typescript`, both dev-only and exact-pinned in `package-lock.json` | No runtime dependencies yet. |

`.npmrc` sets `ignore-scripts=true`, `save-exact=true`, and `engine-strict=true`, so `npm install`/`npm ci` never execute dependency lifecycle scripts by default. Install dependencies only into this checkout's `node_modules/`; no host-global tool installation is required or performed.

```sh
npm ci --ignore-scripts      # local, pinned dev dependencies
npm run typecheck            # tsc --noEmit
npm test                     # unit tests (synthetic, disposable fixtures only)
npm run publication-check    # publication-safety gate (see below)
```

## Package resources

`package.json` is marked `private` so that it cannot be published accidentally. Package/release publication is not authorized. The `pi` key declares only resources that exist; the extension entry point is added with the Pi coordinator interface. Host-provided Pi packages are to be declared as `peerDependencies` (`"*"`) and never bundled, following Pi's package documentation.

The `files` list and the publication checker's package-content allowlist (`src/publication/package.ts`) define what a package or export may contain: `package.json`, `README.md`, `config/`, `src/` (without tests), and later `extensions/`, `workers/`, `skills/`, `prompts/`, and `docs/user/`. Tests, feasibility probes, planning/research records, environment files, credentials, run state, archives, and private denylists are always rejected.

## Public and private artifact boundary

This repository is public. It contains source, shipped non-secret defaults, neutral synthetic test fixtures, and public documentation. It never contains:

- credentials, auth stores or projections, raw runtime/auth logs, or account details;
- private project prompts, specs, transcripts, run artifacts, metrics, or evidence;
- private denylist values or personal/machine-specific paths;
- effective private configuration from bound workspaces.

Run state belongs in target workspace/project storage. `.gitignore` excludes `.radian/`, `.radian-scratch/`, `.env*`, `node_modules/`, and archives so local artifacts are not committed accidentally; ignored files are unpublished, not inaccessible.

## Publication safety

`npm run publication-check` (`node scripts/publication-check.ts`) runs, by default:

| Input | What is scanned |
| --- | --- |
| `--staged` | Exact Git index blobs (partial staging scans staged content, not the working tree) |
| `--worktree` | Tracked and untracked non-ignored working-tree files |
| `--tree <rev>` | Every blob in a committed tree (default `HEAD`) |
| `--metadata <range>` | Commit author/committer identities, names, and messages (default `@{upstream}..HEAD`) |
| `--package` | The `npm pack --dry-run --ignore-scripts` file list against the package-content allowlist, then file content |
| `--whitespace` | `git diff --check` for staged, unstaged, and unpushed changes (locations only) |

Generic rules have stable IDs: `RH-HOME-PATH`, `RH-MACOS-TEMP-PATH`, `RH-EMAIL`, `RH-PRIVATE-IPV4`, `RH-PRIVATE-KEY`, `RH-TOKEN`, `RH-SECRET-ASSIGNMENT`, plus `RH-PRIVATE-TERM` (denylist) and `RH-WHITESPACE`. Neutral built-in exceptions are narrow: example domains, `.example`/`.invalid`/`.test` addresses, GitHub noreply addresses, and neutral home names such as `/Users/example`.

Exit codes: `0` every selected input scanned with no findings; `1` findings; `2` incomplete scan or error. An incomplete scan is never reported as clean.

**Diagnostics are redacted.** Findings show rule, kind, and location. Locally they include a short fingerprint used for allowances; `--ci` omits fingerprints. Matched values and private terms are never printed.

**Private denylist.** Pass `--denylist <file>` or set `RADIAN_PUBLICATION_DENYLIST`. The file holds one literal term per line (case-insensitive, `#` comments) and must be outside the repository. Absent denylists are reported as `NOT SUPPLIED — private-term coverage is absent`; `--require-denylist` turns absence into an error. Never commit denylist values or configure them in public CI.

**Allowances.** `config/publication-allowances.json` (version 1) may list `{ rule, path, fingerprint, reason }` entries. Each names one generic rule, one exact path, and one matched value fingerprint. Wildcards, unknown rules, and private-term allowances are rejected; the scanner reads the allowance file from the same content source it scans.

**Bounded execution.** On macOS the command re-executes itself under a sandbox profile that denies writes to the repository and its Git directory, with a private scratch directory. Git runs with an argument vector, a cleared environment, no global/system configuration, and hooks, filesystem monitors, pagers, credential helpers, and external diff programs neutralized. Repository content is never executed. Elsewhere the report states that the scan was not OS-bounded.

**Hooks and CI.** `node scripts/publication-hooks.ts install|remove` manages an optional owned `pre-push` hook. It refuses to overwrite an existing hook or a configured `core.hooksPath`, and removes only an unchanged owned hook. Hooks are bypassable and CI runs after a push, so neither replaces the pre-push review. `.github/workflows/ci.yml` runs generic checks with no credentials or private denylist.

**Coverage limits.** Text patterns only. Binary content (reported as excluded), ignored files, images, every possible secret format, letter-only secrets in assignments, and history outside the selected range are not covered. Commit-history review beyond the scanned range and a human review of staged content remain required before publication.

## License and attribution policy

No open-source license has been selected for this repository yet; `package.json` declares `UNLICENSED` and choosing a license is the owner's decision. Until then:

- Do not copy third-party code into this repository without recording its license and attribution, and confirming that its license permits the use.
- Keep third-party notices with any reused code and list them in a `NOTICE` file when one is needed.
- Development dependencies (`typescript`, Apache-2.0; `@types/node`, MIT) are installed, not vendored.
- Platform documentation (Pi, Herdr, runtime CLIs) is referenced, not copied.

## Layout

See [proposal 0013](proposals/0013-repository-layout.md). Directories are added only when they hold real files:

- `src/` — implementation (`util/`, `git/`, `publication/`, and later coordinator, runtime, isolation, workspace, metrics, UI modules)
- `scripts/` — thin maintenance entry points
- `config/` — public, non-secret shipped defaults and allowances
- `tests/unit/`, `tests/integration/` — automated tests using disposable synthetic fixtures; `tests/feasibility/` — historical experiments, not production adapters
