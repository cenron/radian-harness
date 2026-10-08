# Architecture

Radian is a Pi extension. Pi is the coordinator you talk to; workers are ordinary interactive
Claude Code, Codex, or Pi sessions, each in its own Herdr pane and git worktree. Radian adds the
glue: projects, Plan/Build modes, dispatch, status, and one approval before a merge.

## The flow

```text
 you ──chat──▶ Pi (coordinator, workspace root)
                │  Plan mode: talk, read, radian_write_doc, scouts only
                │  Shift+Tab → Build mode
                ▼
          radian_dispatch {role, title, task, profile?, fromWorker?}
                │ 1. cap check, profile (Anthropic models only on Claude Code)
                │ 2. git worktree add -b radian/<worker>  (from target or fromWorker)
                │ 3. write workers/<worker>/brief.md
                │ 4. herdr pane split --cwd <worktree> --env ANTHROPIC_API_KEY= …
                │    herdr agent start <worker> --kind claude|codex|pi -- <model/effort flags>
                │    herdr agent prompt <worker> "<roles/<role>.md>\n\nRead and do the task in <brief>"
                ▼
       worker pane ── edits files (never commits), appends to its status file:
                │       working: … | question: … | blocked: … | done: … | failed: …
                ▼
       watcher (every pollSeconds) reads new status lines + `herdr pane get`
                │ done (developer/tester) → Radian commits on radian/<worker>
                │ question/blocked/done/failed/exit → message to Pi (starts a turn)
                ▼
       Pi summarizes and calls radian_merge ──▶ dialog [Cancel] [Merge]
                │ Merge: checkout clean and on target → git merge --ff-only, else --no-edit
                │        conflict → git merge --abort, report, keep everything
                ▼
       success: close pane, remove worktree, delete branch
```

## Layers

Dependencies point inward; see [ProjectStructure](ProjectStructure.md) for every file.

- `src/core/` — pure rules: roles and modes, profiles and the Anthropic rule, worker naming,
  status-line parsing, brief text, runtime flags.
- `src/io/` — git, Herdr (through an injectable `HerdrRunner`), config loading, the workspace
  registry, worker records, status files.
- `src/workers/` — the lifecycle: `dispatchWorker`, `pollWorker`, `mergeWorker`,
  `discardWorker`, `stopWorker`, `sendToWorker`.
- `src/pi/` — everything that touches Pi: session handling, commands, tools, guard, confined read
  tools, Calm, the mode editor, status view, and the watcher.
- `src/install/` — the installer behind `install.sh` and `npm run workspace`.

## Sessions and projects

Pi always runs at the workspace root. Each project has its own Pi session, tagged with a
`radian-project` custom entry; `.radian/projects/<project>/session.json` remembers the latest
one. `/projects select <name>` switches to it (`ctx.switchSession`) or starts it
(`ctx.newSession`); `/workspace` starts an untagged session, the dashboard. `ProjectSession` in
`src/pi/session/project-session.ts` does the switching. Pi rebuilds the extension on each switch,
so Radian keeps nothing important in memory: everything is re-read from disk on
`session_start` into a fresh `State` (`src/pi/state.ts`). The user's model and thinking level
are carried across a switch (`ModelCarry`, `src/pi/session/model-carry.ts`).

For a selected project, Radian points the system prompt at the project (`cwd`, the project's
context files such as `AGENTS.md`, and a `radian` section with the mode), activates only its own
tools plus `read`/`ls`/`grep`/`find`, and replaces those four with versions rooted at the
project that refuse paths outside it. They may also read the project's worker worktrees and
worker files (brief, status, report), so Pi can review a worker's work before offering a merge.

## Coordinator limits

Pi never edits project files or runs shell commands. `bash`, `write`, and `edit` are left out
of the active tools and blocked by the `tool_call` guard as well. Planning documents go through
`radian_write_doc` into `<project>/.radian/planning/`, which Radian adds to the repository's
`.git/info/exclude` so the checkout stays clean for merges. Git inspection goes through
`radian_git`, which allows only `status`, `log`, `diff`, and `show` and refuses options that
write files or run external programs.

## Workers

- **Launch.** Worker panes fill a two-column grid to the right of Pi's pane (`1|3`, `2|4`,
  `5|6`, …; `src/core/layout.ts`), with API-key, custom-endpoint, and proxy variables blanked,
  so each runtime uses the user's subscription login. The runtime starts with model, effort,
  and permission flags only (`src/core/runtime-args.ts`); the role prompt and brief are typed
  in afterwards and never passed on the command line. Pi workers get
  `--no-approve --no-extensions` so they never load Radian and become coordinators.
- **Tools.** Claude Code workers get their role's built-in tools only, with `dontAsk`
  permissions. MCP tools are added per project: when a worker needs one, Pi calls
  `radian_allow_tool`, the user approves it in a dialog, and it is saved in the project's
  `.radian/worker-tools.json` and added to `--allowedTools` for workers dispatched afterwards.
  `/radian tools` lists them and `/radian tools remove` takes one away.
- **Typing the task.** Claude Code and Codex may first ask to trust the new folder, and Herdr
  does not always report that. Radian types the task only when the pane shows the runtime's own
  input and no such prompt, because the Enter that submits the task would otherwise answer the
  prompt. Until then the watcher keeps checking, and Pi tells the user to answer the prompt.
- **Commits.** Commits and merges belong to the coordinator side. Workers of every runtime only
  change files; when a developer or tester reports `done`, Radian commits its changes on the
  worker branch (the `done` text goes into the message), and the merge waits for the user's
  approval. This also suits Codex, whose sandbox keeps git metadata read-only.
- **Status.** Workers append free-form lines. They are parsed loosely (bullets, capitals, and
  dashes are fine; anything else is a note), and `statusLinesSeen` in `workers.json` records how
  many were reported, so a restart neither repeats nor loses an update.
- **Limits.** `maxWorkers` (default 3) counts workers that are starting, working, asking a question,
  or blocked. Only a scout may be dispatched in Plan mode.
- **Ending.** Merge and discard (`radian_merge`, `radian_discard`, or `/radian merge|discard`)
  each ask the user first and then remove the pane, worktree, and branch.
  A worker that reports `done` with no commits of its own (a scout or reviewer, a developer that
  changed nothing, or one whose work already reached the target through another worker) is
  closed without asking, since there is nothing to merge or lose; Pi gets its report or summary.
  Stop closes the pane and keeps the worktree and branch, so the work can still be merged.
  `/projects delete` is refused while any worker pane is open.

## Configuration

`config/harness.json` and `config/dispatch.json` ship with Radian; a workspace can override them
in `.radian/config/`. Profiles name a runtime, model, effort, and (for Pi) a provider. The loader
rejects unknown keys, unsupported efforts, Anthropic models on anything but Claude Code, and
non-Anthropic models on Claude Code. Nothing falls back to another runtime or model on its own.

## What Radian does not do

There is no OS-level isolation of workers: they run with the user's permissions and logins. The
guard keeps the coordinator honest; it is not a security boundary. Radian targets macOS with
Herdr and git worktrees, and it does not manage export templates, CI, or anything outside the
project's git repository.
