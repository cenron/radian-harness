# Project structure

## Repository

```text
radian-harness/
├── extensions/radian.ts        Pi package entry: wires the real Herdr runner and this checkout
├── src/
│   ├── core/                   Radian's definitions and rules; imports nothing else from src/
│   │   ├── constants.ts        Runtimes, roles, efforts, Anthropic markers, file-list limit
│   │   ├── types.ts            Mode, Profile, and the config types
│   │   ├── errors.ts           RadianError(code, message)
│   │   ├── config.ts           Loads and validates config/*.json plus workspace overrides
│   │   ├── roles.ts            Role and mode parsing, which roles each mode allows
│   │   ├── profiles.ts         Profile selection, the Anthropic-on-Claude rule
│   │   ├── worker.ts           Worker record and states, names, branches, pane labels
│   │   ├── brief.ts            The brief text and the first prompt typed into a worker
│   │   ├── status.ts           Loose parsing of `working|question|blocked|done|failed:` lines
│   │   ├── layout.ts           Where each worker pane goes in the grid beside the coordinator
│   │   ├── runtime-args.ts     Command-line flags per runtime; blanked API-key/proxy variables
│   │   └── utils/              Portable helpers that would work in any program
│   │       ├── json.ts         JSON read with fallback; write through a temporary file
│   │       ├── errors.ts       errorMessage(), isNodeError()
│   │       ├── text.ts         listSome(): "a, b, and 2 more"
│   │       └── tool-guard.ts   createToolGuard(): refuses listed tools, each with a reason
│   ├── io/                     Files, git, and Herdr; imports core only
│   │   ├── git.ts              Worktrees, branches, merge with abort on conflict, read-only git
│   │   ├── herdr.ts            Pane split/rename/get/close, agent start/prompt, HerdrRunner
│   │   ├── workspace.ts        Workspace marker, project registry, project paths, mode file
│   │   ├── worker-store.ts     Reads and writes workers.json
│   │   ├── status-files.ts     Brief, status, and report files of one worker
│   │   └── worker-tools.ts     MCP tools the user approved for a project's workers
│   ├── workers/                Worker lifecycle; imports core and io
│   │   ├── worker-env.ts       WorkerEnv: the project, config, Herdr runner, and Pi's pane
│   │   ├── dispatch.ts         Cap check, profile, worktree, brief, grid pane, agent start
│   │   ├── delivery.ts         Types the task in once the agent's input is on screen
│   │   ├── poll.ts             New status lines, pane state, task delivery, commit at done
│   │   └── finish.ts           Describe, merge, discard, stop, send, close if nothing to merge
│   ├── pi/                     Pi integration; may import everything above
│   │   ├── register.ts         RegisterRadian: builds the parts below and connects them to Pi
│   │   ├── state.ts            State: per-session state, the current view, WorkerEnv construction
│   │   ├── session/
│   │   │   ├── project-session.ts  ProjectSession: which project a session belongs to; switching
│   │   │   ├── handoff.ts      The first prompt of a fresh build session: the plan
│   │   │   ├── model-carry.ts  ModelCarry: keeps the model and thinking level across a switch
│   │   │   ├── session-lifecycle.ts  SessionLifecycle: session start (tools, editor, watcher,
│   │   │   │                   footer) and end
│   │   │   └── system-prompt.ts  SystemPrompt: Radian's section of Pi's system prompt
│   │   ├── commands/           Slash commands, one file per command
│   │   │   ├── index.ts        registerCommands(): registers each command; errors become notices
│   │   │   ├── types.ts        CommandDefinition and CommandDependencies
│   │   │   ├── projects.ts     /projects list|select|create|add|delete
│   │   │   ├── workspace.ts    /workspace
│   │   │   ├── radian.ts       /radian status|mode|calm|workers|merge|stop|discard|tools; Shift+Tab
│   │   │   └── calm.ts         /calm
│   │   ├── tools/              Coordinator tools, one file per tool or close-knit group
│   │   │   ├── index.ts        registerTools() and RADIAN_TOOL_NAMES
│   │   │   ├── types.ts        ToolDependencies
│   │   │   ├── tool.ts         tool(): plain-text results; errors become failed tool results
│   │   │   ├── read-tools.ts   registerReadTools(): read/ls/grep/find confined to the project
│   │   │   ├── status.ts       radian_status
│   │   │   ├── write-doc.ts    radian_write_doc
│   │   │   ├── git.ts          radian_git
│   │   │   ├── dispatch.ts     radian_dispatch
│   │   │   ├── workers.ts      radian_workers, _send, _stop, _merge, _discard
│   │   │   └── allow-tool.ts   radian_allow_tool
│   │   ├── guard.ts            Radian's guard policy: blocks Pi's bash, write, and edit
│   │   ├── dialogs.ts          Project picker, delete dialog, merge and discard approvals
│   │   ├── watcher/
│   │   │   ├── watcher.ts      Watcher: the poll loop; sends worker updates to Pi as follow-ups
│   │   │   └── worker-messages.ts  describeChange(): what Pi is told about a worker's change
│   │   ├── status/
│   │   │   ├── status-view.ts  StatusView: refreshes the footer and widget; status and workers
│   │   │   │                   reports
│   │   │   ├── project-status.ts   A project's mode and workers, read from disk
│   │   │   ├── footer.ts       Footer line and worker widget lines (pure)
│   │   │   └── reports.ts      Project, dashboard, and workers text reports (pure)
│   │   ├── mode/
│   │   │   ├── project-mode.ts ProjectMode: sets (/radian mode) and toggles (Shift+Tab) Plan/Build
│   │   │   └── mode-editor.ts  Pi's editor with Shift+Tab claimed for the toggle
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

- `core` imports nothing else from `src/`. It holds Radian's definitions and rules, and may read
  and write files. `core/utils/` holds portable helpers: code that would work unchanged in any
  other program, with no Radian rules and nothing from Pi.
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
└── <project>/                    From /projects create; /projects add can point anywhere
    └── .radian/                  Excluded in .git/info/exclude
        ├── planning/             radian_write_doc output
        └── worker-tools.json     MCP tools approved for this project's workers
```

## Where to add things

- **A command.**
  1. For a new subcommand, add a `case` to the command that owns it, such as `/projects` in
     `src/pi/commands/projects.ts`. For a new top-level command, add a file in
     `src/pi/commands/` exporting a function that takes `CommandDependencies` and returns a
     `CommandDefinition` (`name`, `description`, `action`), and add it to `createCommands` in
     `src/pi/commands/index.ts`.
  2. Keep the logic in `io/` or `workers/`, and throw `RadianError` for anything the user should
     see. `runCommand` in `index.ts` shows the returned text or the error message.
  3. Give the command a doc comment with its usage, and list it in the README's command table and
     in `skills/radian-coordinator/SKILL.md`.
- **A coordinator tool.**
  1. Add a file in `src/pi/tools/` (or a factory to the file of its group) exporting a function
     that takes `ToolDependencies` and returns `tool({...})` with a TypeBox schema. Give it a doc
     comment saying what it does.
  2. Add it to `createTools` and its name to `RADIAN_TOOL_NAMES` in `src/pi/tools/index.ts`, so
     `register.ts` activates it for projects. A test checks that the two lists match.
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
