# Project structure

## Repository

```text
radian-harness/
├── extensions/radian.ts        Pi package entry: wires the real Herdr runner and this checkout
├── src/
│   ├── core/                   Pure rules; imports nothing else from src/
│   │   ├── errors.ts           RadianError(code, message) and errorMessage()
│   │   ├── roles.ts            The four roles, Plan/Build modes, which roles each mode allows
│   │   ├── profiles.ts         Runtimes, efforts, profile selection, the Anthropic-on-Claude rule
│   │   ├── worker.ts           Worker record and states, names, branches, pane labels
│   │   ├── brief.ts            The brief text and the first prompt typed into a worker
│   │   ├── status.ts           Loose parsing of `working|question|blocked|done|failed:` lines
│   │   ├── layout.ts           Where each worker pane goes in the grid beside the coordinator
│   │   └── runtime-args.ts     Command-line flags per runtime; blanked API-key/proxy variables
│   ├── io/                     Files, git, and Herdr; imports core only
│   │   ├── git.ts              Worktrees, branches, merge with abort on conflict, read-only git
│   │   ├── herdr.ts            Pane split/rename/get/close, agent start/prompt, HerdrRunner
│   │   ├── config.ts           Loads and validates config/*.json plus workspace overrides
│   │   ├── workspace.ts        Workspace marker, project registry, project paths, mode file
│   │   ├── worker-store.ts     Reads and writes workers.json
│   │   ├── status-files.ts     Brief, status, and report files of one worker
│   │   └── json-file.ts        JSON read with fallback; write through a temporary file
│   ├── workers/                Worker lifecycle; imports core and io
│   │   ├── worker-env.ts       WorkerEnv: the project, config, Herdr runner, and Pi's pane
│   │   ├── dispatch.ts         Cap check, profile, worktree, brief, grid pane, agent start
│   │   ├── delivery.ts         Types the task in once the agent's input is on screen
│   │   ├── poll.ts             New status lines, pane state, task delivery, commit at done
│   │   └── finish.ts           Describe, merge, discard, stop, send, close finished readers
│   ├── pi/                     Pi integration; may import everything above
│   │   ├── register.ts         registerRadian(): tools, commands, events, system prompt section
│   │   ├── state.ts            Per-session state, the current view, WorkerEnv construction
│   │   ├── activation.ts       Workspace detection, per-project sessions, model carry-over
│   │   ├── commands.ts         /projects, /workspace, /new-project, /add-project,
│   │   │                       /delete-project, /calm, /radian …
│   │   ├── tools.ts            radian_status, _write_doc, _git, _dispatch, _workers, _send,
│   │   │                       _stop, _merge, _discard
│   │   ├── read-tools.ts       read/ls/grep/find confined to the selected project
│   │   ├── guard.ts            Blocks Pi's bash, write, and edit
│   │   ├── dialogs.ts          Project picker, delete dialog, merge and discard approvals
│   │   ├── watcher.ts          Poll loop; sends worker updates to Pi as follow-up messages
│   │   ├── status-view.ts      Footer status, worker widget, text reports
│   │   ├── mode-editor.ts      Shift+Tab toggles Plan/Build
│   │   └── calm.ts             Calm renderer and the ui.json preference
│   └── install/                Imports core only
│       ├── installer.ts        Plan/apply install, update, remove; read install status
│       └── cli.ts              `npm run workspace -- install|update|remove|status`
├── install.sh                  Checks for node, then runs the installer CLI's install
├── config/
│   ├── harness.json            maxWorkers, startMode, calm, pollSeconds
│   └── dispatch.json           Role → default profile; profiles (runtime, model, effort)
├── roles/                      First message typed into each worker, one file per role
│   └── developer.md, tester.md, reviewer.md, scout.md
├── skills/radian-coordinator/SKILL.md   How Pi coordinates: modes, tools, dispatch, merging
├── scripts/
│   ├── publication-check.ts    Scans tracked files and commit messages before publishing
│   └── publication-rules.ts    The scanner's pure rules (home paths, emails, tokens, keys)
├── tests/
│   ├── helpers/                git-fixtures.ts, fake-herdr.ts, fake-pi.ts, worker-fixtures.ts
│   ├── unit/                   Mirrors src/ (core, io, workers, pi, install) plus scripts
│   └── integration/            Native Pi over RPC with an offline faux provider, plus a
│       │                       check that installed runtime CLIs accept Radian's flags
│       ├── helpers/            pi-rpc.ts (drives Pi), workspace.ts (temporary workspaces)
│       └── fixtures/           faux-model.ts, fake-herdr.ts
├── docs/                       Architecture.md, Principles.md, ProjectStructure.md
├── .github/workflows/ci.yml    typecheck, lint, format:check, test, publication-check
└── package.json, tsconfig.json, eslint.config.js, .prettierrc, LICENSE
```

## Layering rule

Dependencies point inward:

- `core` imports nothing from `src/`.
- `io` imports `core`, and `install` imports `core`.
- `workers` imports `core` and `io`.
- `pi` imports any of these and is the only layer that touches Pi's API.

Nothing below `pi` knows about Pi. [Principles](Principles.md) has the full table.

## State in a workspace

A workspace is the folder where the user runs `pi`. Radian activates only where
`.radian/workspace.json` exists. Everything is plain JSON or text, so a restart rereads the same
files.

```text
<workspace>/
├── .pi/settings.json             Pi package entry pointing at the harness (written by install)
├── .radian/
│   ├── workspace.json            Marks the workspace; created by install, never removed
│   ├── install-manifest.json     What install owns, so update and remove touch only that
│   ├── projects.json             Registry: name, path, target branch of each project
│   ├── ui.json                   Calm on/off
│   ├── config/                   Optional overrides of the shipped config
│   │   ├── harness.json          Keys override config/harness.json
│   │   └── dispatch.json         Profiles override by name, roles by role
│   └── projects/<project>/
│       ├── mode.json             plan or build
│       ├── session.json          The project's Pi session file
│       ├── workers.json          Worker records (state, pane, branch, status lines seen)
│       ├── workers/<worker>/
│       │   ├── brief.md          The task and working rules the worker reads
│       │   ├── status            Lines the worker appends
│       │   └── report.md         Reviewer and scout findings
│       └── worktrees/<worker>/   Git worktree on branch radian/<worker>
└── <project>/                    From /new-project; /add-project can point anywhere
    └── .radian/planning/         radian_write_doc output, excluded in .git/info/exclude
```

## Where to add things

- **A command.**
  1. Add an entry to the `commands` map in `registerCommands` (`src/pi/commands.ts`).
  2. Keep the logic in `io/` or `workers/`, and throw `RadianError` for anything the user should
     see. `runCommand` shows the returned text or the error message.
  3. List the command in `skills/radian-coordinator/SKILL.md`.
- **A coordinator tool.**
  1. Add a `tool({...})` entry in `registerTools` (`src/pi/tools.ts`) with a TypeBox schema.
  2. Add its name to `RADIAN_TOOL_NAMES`, so `register.ts` activates it for projects.
  3. Describe it in the coordinator skill.
- **A runtime.**
  1. Add it to `RUNTIMES` and `RUNTIME_EFFORTS` in `src/core/profiles.ts`.
  2. Add its flags function to `src/core/runtime-args.ts`, with a test in
     `tests/unit/core/runtime-args.test.ts`. The prompt is never passed on the command line.
  3. Check that Herdr's `agent start --kind` knows the runtime's agent.
  4. Add profiles for it in `config/dispatch.json`. The config loader validates runtimes from
     `RUNTIMES`.
- **A role.**
  1. Add it to `ROLES` in `src/core/roles.ts`, and decide its rules in `assertRoleAllowedInMode`
     and `canEditCode`.
  2. Write `roles/<role>.md`.
  3. Give it a default profile under `roles` in `config/dispatch.json`. The loader requires one
     for every role.
  4. Describe the role in the coordinator skill.
