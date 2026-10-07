# Radian

[![CI](https://github.com/cenron/radian-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/cenron/radian-harness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Plan with one agent, build with many.** Radian turns [Pi](https://pi.dev) into a coordinator
that hands work to real coding agents (Claude Code, Codex, or Pi), each in its own terminal pane
and git worktree, and merges their work only after you approve.

## Why Radian

Coding agents are good at focused work, but juggling several of them by hand means juggling
branches, terminals, prompts, and half-finished changes. Radian keeps the parts that need you
(planning, answering questions, approving merges) in one conversation, and gives every worker a
normal, visible session you can watch or type into at any time.

- **You stay in one chat.** Plan with Pi, then press Shift+Tab to start building.
- **Workers are ordinary agent sessions.** No hidden subprocesses: each worker is the usual
  interactive Claude Code, Codex, or Pi session in a [Herdr](https://herdr.dev) pane.
- **Nothing lands without you.** Workers only change files. Radian commits each worker's changes
  on its own branch, and nothing reaches your target branch until you choose **Merge**.
- **Your subscriptions, not API bills.** Workers use your existing logins; API-key, custom
  endpoint, and proxy variables are blanked for every worker.

## Features

- **Plan and Build modes.** In Plan mode Pi talks, reads the code, writes plans, and may send
  read-only scouts. Shift+Tab switches to Build mode, where it can dispatch any worker.
- **Four roles.** Developers and testers change code; reviewers and scouts read and report.
- **Parallel workers.** Up to 3 at once by default (configurable), arranged in a two-column grid
  beside Pi:

  ```text
  Pi | 1 | 3
     | 2 | 4
     | 5 | 6
  ```

- **Live status.** Workers report `working`, `question`, `blocked`, `done`, or `failed`, and Pi
  reacts: it answers questions it can, tells you about the rest, and offers the merge when a
  worker is done.
- **One-dialog merges.** Fast-forward when possible, a merge commit otherwise; a conflict is
  aborted and reported, leaving your branch untouched.
- **Projects.** One workspace holds many git repositories, each with its own conversation.
- **Calm.** `/calm` collapses routine tool output so the conversation stays readable.

## Requirements

- macOS with git
- Node.js 22.18 or newer
- [Pi](https://pi.dev) (tested with 1.0.2)
- [Herdr](https://herdr.dev) (tested with 0.9.1); Pi must run inside a Herdr pane
- At least one worker runtime, logged in with your subscription:
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (tested with 2.1.285),
  Codex CLI (tested with 0.160.1), or Pi itself

## Quick start

```sh
git clone https://github.com/cenron/radian-harness.git
cd radian-harness
npm install
mkdir -p ~/radian-workspace
./install.sh --workspace ~/radian-workspace
```

The installer shows the files it will change and asks before it changes anything. Then, inside a
Herdr pane:

```sh
cd ~/radian-workspace
pi
```

Radian is a project package, so Pi asks once whether to trust the workspace; trust it so Radian
loads. Then create a project and start talking:

```text
/new-project demo
```

## Using Radian

1. **Plan.** Describe what you want. Pi reads the project, asks questions, and can write a plan
   to `.radian/planning/`. A scout can explore the code for it.
2. **Build.** Press Shift+Tab. Ask Pi to start the work; it dispatches a developer, and a pane
   opens beside Pi with the agent working in its own worktree.
3. **Follow.** Pi tells you when a worker asks a question, is blocked, fails, or is done. Answer
   through Pi, or type into the worker's pane yourself. The first time an agent opens a new
   folder it may ask you to trust it; answer in its pane and Radian sends the task right after.
4. **Merge.** When a worker is done, Radian commits its changes on its branch and Pi offers the
   merge. You see the branch, commits, diff stat, and the worker's summary; choose **Merge** or
   **Cancel**. Afterwards the pane, worktree, and branch are removed.

### Roles

| Role      | Default model              | What it does                                                                   |
| --------- | -------------------------- | ------------------------------------------------------------------------------ |
| developer | Claude Sonnet 5.5 (medium) | Implements the task and its tests                                              |
| tester    | Claude Sonnet 5.5 (medium) | Writes and runs tests, in parallel with a developer or on its branch           |
| reviewer  | Claude Sonnet 5.5 (medium) | Reviews a developer's branch and writes a report; closes itself when done      |
| scout     | Claude Haiku 4.5 (low)     | Explores read-only and reports (allowed in Plan mode); closes itself when done |

Other shipped profiles: `deep-review` (Claude Opus 5.5, high effort), `developer-codex` (Codex),
and `developer-pi` (an OpenAI model through Pi). Pi uses them only when you ask.

### Commands

| Command                                       | What it does                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `/projects [name]`                            | List projects, or switch to one (each has its own conversation)          |
| `/workspace`                                  | Back to the workspace dashboard                                          |
| `/new-project <name> [--branch <b>]`          | Create a git repository in the workspace and select it                   |
| `/add-project <path> --target refs/heads/<b>` | Register an existing repository                                          |
| `/delete-project <name>`                      | Cancel, remove from the workspace (keep files), or delete with the files |
| `/radian status`                              | The project, its mode, and its workers                                   |
| `/radian mode plan\|build`, Shift+Tab         | Switch mode                                                              |
| `/calm [on\|off]`                             | Toggle Calm                                                              |
| `/radian workers`                             | List workers                                                             |
| `/radian merge\|stop\|discard <worker>`       | Merge or discard (each asks first), or close the pane and keep the work  |

### Coordinator tools

Pi works through these tools; it has no shell and cannot edit project files.

| Tool                              | Purpose                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `radian_status`, `radian_workers` | Project, mode, and worker overview                       |
| `read`, `ls`, `grep`, `find`      | Read the selected project (confined to it)               |
| `radian_git`                      | Read-only `status`, `log`, `diff`, `show`                |
| `radian_write_doc`                | Write plans to `.radian/planning/` (kept out of git)     |
| `radian_dispatch`                 | Start a worker                                           |
| `radian_send`, `radian_stop`      | Type into a worker's session; close its pane             |
| `radian_merge`, `radian_discard`  | Ask you to approve merging or discarding a worker's work |

## How it works

```text
you ─▶ Pi (coordinator) ── radian_dispatch ─▶ git worktree + brief.md
                                              │
                                              ▼
                                   Herdr pane: claude | codex | pi
                                   (model and effort flags; task typed in)
                                              │ edits files, never commits
                                              │ appends "done: …" to its status file
                                              ▼
Pi ◀── watcher reads status + pane; at done, ─┘
       Radian commits on radian/<worker>
 │
 └─ radian_merge ─▶ [Cancel] [Merge] ─▶ git merge ─▶ pane, worktree, branch removed
```

Everything Radian knows lives in plain JSON and text files under the workspace's `.radian/`
folder, so restarting Pi loses nothing. Details are in
[docs/Architecture.md](docs/Architecture.md).

## Safety and billing

- **Approvals.** Merging and discarding always ask you first, with Cancel as the default.
- **Coordinator limits.** Pi's `bash`, `write`, and `edit` tools are off in a Radian workspace,
  and its read tools only see the selected project.
- **Subscriptions only.** Anthropic models run only through Claude Code, and workers start with
  API-key, custom-endpoint, and proxy variables blanked. Radian never switches a worker to another
  runtime or model on its own.
- **No sandbox.** Workers run with your user's permissions, files, and logins, as the agents do
  when you start them yourself. Review what you merge.

## Configuration

`config/harness.json` sets the defaults:

```json
{ "version": 1, "maxWorkers": 3, "startMode": "plan", "calm": false, "pollSeconds": 3 }
```

`config/dispatch.json` maps each role to a default profile and defines the profiles:

```json
"developer": { "runtime": "claude", "model": "claude-sonnet-5-5", "effort": "medium" }
```

To change settings for one workspace, put partial files in
`<workspace>/.radian/config/harness.json` or `dispatch.json`; profiles and roles merge by name.
The installer can be run again at any time:

```sh
npm run workspace -- status --workspace ~/radian-workspace
npm run workspace -- update --workspace ~/radian-workspace
npm run workspace -- remove --workspace ~/radian-workspace
```

## Project structure

```text
extensions/radian.ts   Pi entry point
src/core/              pure rules: roles, profiles, layout, status lines, briefs, runtime flags
src/io/                git, Herdr, config, workspace registry, worker records
src/workers/           dispatch, task delivery, polling, merge, discard, stop
src/pi/                commands, tools, dialogs, sessions, watcher
src/install/           the installer
config/ roles/ skills/ shipped profiles, role prompts, coordinator skill
```

Every file is described in [docs/ProjectStructure.md](docs/ProjectStructure.md).

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

The integration tests drive a real Pi over RPC with an offline fake model and a fake Herdr; no
model provider is contacted. Coding standards are in [docs/Principles.md](docs/Principles.md).

## Contributing

`main` holds released, stable code. All changes go through a branch and a pull request:

1. Branch from `main` (`feature/<topic>` or `fix/<topic>`).
2. For a bug, write a failing test first, then the fix.
3. Run the development checks above; all must pass, with no `eslint-disable` comments.
4. Open a pull request into `main`. CI runs typecheck, lint, format, unit tests, and the
   publication scan.

[AGENTS.md](AGENTS.md) holds the same working agreement for coding agents.

## Known limits

- macOS and Herdr are required, and Pi must run inside a Herdr pane to dispatch workers.
- Workers merge only into the project's checked-out target branch, which must be clean.
- Pi follows the workers of the selected project; other projects' updates arrive when you switch
  back to them.
- Radian recognizes an agent's trust prompt and ready screen by their text, so a change in an
  agent's interface can leave a worker waiting (it is never typed into at the wrong moment).
- Codex workers run in Codex's `workspace-write` sandbox, which is one reason Radian, not the
  worker, makes the commits.
- Radian manages git branches and worktrees only; CI, deployment, and anything outside the
  repository are up to you.

## Versions

- **1.0.0** (stable): Plan → Build → merge with Claude Code, Codex, and Pi workers in Herdr panes.

## License

[MIT](LICENSE)
