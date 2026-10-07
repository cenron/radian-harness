# Working on Radian

Radian is a Pi extension that coordinates Claude Code, Codex, and Pi workers in Herdr panes and
git worktrees. Read [docs/Architecture.md](docs/Architecture.md) first.

## Standards

- Follow [docs/Principles.md](docs/Principles.md): intent-revealing names, short functions, one
  `RadianError` mechanism, dependencies pointing inward (`core` ← `io` ← `workers` ← `pi`).
- Prettier formats and ESLint owns quality. No `eslint-disable` comments.
- [docs/ProjectStructure.md](docs/ProjectStructure.md) says where things live and how to add a
  command, tool, runtime, or role.

## Changes

- Fix a defect with a failing regression test first, then the fix.
- Before you finish, run:
  `npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:integration && npm run publication-check`.
- Commit only when asked. Push only when asked. Never force-push, tag, or publish a release.
- Keep the repository free of personal data, secrets, and machine-specific paths;
  `npm run publication-check` scans for them.

## Model and billing rules

- Anthropic models run only through Claude Code. Never route them through Pi or Codex, and never
  silently switch a worker to another runtime, model, or effort; ask the user.
- Workers use the user's subscription logins. Do not add API-key, custom-endpoint, or proxy
  paths, and do not run live provider or model probes in tests.
