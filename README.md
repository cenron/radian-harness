# Radian

**Talk to Pi, plan together, press Shift+Tab, and let real coding agents do the work in their own
panes. Approve one merge when they are done.**

## Overview

Radian is a [Pi](https://pi.dev) extension that coordinates coding agents. Pi is the coordinator
you chat with. Workers are the normal interactive sessions of Claude Code, Codex, or Pi, each in
its own [Herdr](https://herdr.dev) pane and git worktree, so you can watch any of them and type to
them directly. Radian creates the worktree and brief, starts the agent with the right model and
effort, follows its status, and merges its branch after you approve.

## Current version

**1.0.0**: the first deliberately small release. It replaces an earlier, much heavier design
(approval gates, run store, sandboxing) with the bare workflow above.

## At a glance

- **Plan** mode: chat, read the code, write plans to `.radian/planning/`, send scouts.
- **Build** mode (Shift+Tab): dispatch developers, testers, reviewers, and scouts.
- Up to 3 workers at once by default, configurable.
- Workers report through a plain status file: `working`, `question`, `blocked`, `done`,
  `failed`.
- One dialog to merge, with Cancel as the default: fast-forward when possible, otherwise a merge
  commit. On a conflict the merge is aborted and nothing changes.
- Anthropic models run only through Claude Code. Workers use your subscription logins, never API
  keys.
- Each project has its own conversation, all in one Pi process.

## Quick start

You need macOS, Node.js 22.18 or newer, git, [Herdr](https://herdr.dev), Pi, and the CLIs you
want as workers (Claude Code, Codex, Pi), each logged in.

```sh
git clone https://github.com/cenron/radian-harness.git
cd radian-harness
npm install
mkdir -p ~/radian-workspace
./install.sh --workspace ~/radian-workspace
```

The installer shows what it will change and asks before applying it. Then start Herdr, and in a
Herdr pane:

```sh
cd ~/radian-workspace
pi
```

Radian is a project package, so Pi asks once whether to trust the workspace; trust it so Radian loads. Then, in Pi:

```text
/new-project demo
```

## Usage

1. **Plan.** Describe what you want. Pi reads the project, asks questions, and can write a plan
   with `radian_write_doc`. A scout can explore for it.
2. **Build.** Press Shift+Tab (or `/radian mode build`). Ask Pi to start the work; it dispatches
   a developer, and a pane opens beside Pi with Claude Code (by default) working in its own
   worktree.
3. **Follow.** Pi tells you when a worker asks a question, is blocked, fails, or is done. Answer
   through Pi, or type into the worker's pane yourself.
4. **Merge.** When a worker is done, Pi summarizes it and asks to merge. You see the branch,
   commit count, diff stat, and the worker's last status; choose **Merge**. The pane, worktree,
   and branch are removed afterwards.

| Command                                                | What it does                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `/projects [name]`                                     | List projects, or switch to one (its own conversation)                   |
| `/workspace`                                           | Back to the workspace dashboard                                          |
| `/new-project <name> [--branch <b>]`                   | Create a git repository in the workspace and select it                   |
| `/add-project <path> --target refs/heads/<b>`          | Register an existing repository                                          |
| `/delete-project <name>`                               | Cancel, remove from the workspace (keep files), or delete with the files |
| `/radian status`                                       | The project, its mode, and its workers                                   |
| `/radian mode plan\|build`, Shift+Tab                  | Switch mode                                                              |
| `/radian calm on\|off`                                 | Collapse successful tool output                                          |
| `/radian workers`                                      | List workers                                                             |
| `/radian merge\|stop\|discard <worker>`                | Merge (with approval), close the pane, or throw the work away            |
| `npm run workspace -- install\|update\|remove\|status` | Manage the binding (add `--workspace <dir>`)                             |

## How it works

```text
you ─▶ Pi (coordinator) ── radian_dispatch ─▶ git worktree + brief.md
                                              │
                                              ▼
                                   Herdr pane: claude | codex | pi
                                   (model and effort flags; prompt typed in)
                                              │ commits on radian/<worker>
                                              │ appends "done: …" to its status file
                                              ▼
Pi ◀── watcher reads status + pane ───────────┘
 │
 └─ radian_merge ─▶ [Cancel] [Merge] ─▶ git merge ─▶ pane, worktree, branch removed
```

Pi never edits files or runs shell commands itself; its `bash`, `write`, and `edit` tools are off
in a Radian workspace, and its read tools are confined to the selected project. More in
[docs/Architecture.md](docs/Architecture.md).

## Project structure

```text
extensions/radian.ts   Pi entry point
src/core/              pure rules: roles, profiles, status lines, briefs, runtime flags
src/io/                git, Herdr, config, workspace registry, worker records
src/workers/           dispatch, poll, merge, discard, stop
src/pi/                commands, tools, dialogs, sessions, watcher
src/install/           the installer
config/ roles/ skills/ shipped profiles, role prompts, coordinator skill
```

Every file is listed in [docs/ProjectStructure.md](docs/ProjectStructure.md).

## Configuration

`config/harness.json`:

```json
{ "version": 1, "maxWorkers": 3, "startMode": "plan", "calm": false, "pollSeconds": 3 }
```

`config/dispatch.json` maps each role to a default profile and defines profiles:

```json
"developer": { "runtime": "claude", "model": "claude-sonnet-5-5", "effort": "medium" }
```

Shipped profiles: `developer`, `tester`, `reviewer` (Claude Sonnet), `scout` (Claude Haiku),
`deep-review` (Claude Opus, high effort), `developer-codex`, and `developer-pi`. Pi picks a
non-default profile only when you ask for it. To change settings for one workspace, put partial
files in `<workspace>/.radian/config/harness.json` or `dispatch.json`; profiles and roles merge
by name.

## Development

```sh
npm install
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:integration
npm run publication-check
```

The integration tests run a real Pi over RPC with an offline fake model and a fake Herdr; no
provider is contacted. The coding standards are in [docs/Principles.md](docs/Principles.md), and
[AGENTS.md](AGENTS.md) is the working agreement for agents changing this repository.

## Known limits

- No OS-level isolation: workers run with your permissions, files, and logins. The coordinator
  guard keeps Pi in its role; it is not a security boundary.
- macOS and Herdr are required; Pi must run inside a Herdr pane to dispatch workers.
- Workers merge only into the project's checked-out target branch, which must be clean.
- Radian manages git branches and worktrees only. Export templates, CI, deployment, and anything
  else outside the repository are not managed.
- Codex workers run in Codex's `workspace-write` sandbox for every role, because they must write
  their status file outside the worktree.

## Versions

- **1.0.0**: rebuilt from scratch as the small Plan → Build → merge workflow.

## License

MIT. See [LICENSE](LICENSE).
