# Principles

These are the coding standards Radian follows. Each section quotes real code from this
repository. When two rules conflict, readability wins.

## Naming

Names say what something is for. There are no abbreviations or single-letter names, apart from
loop indices and well-known terms such as `id` and `url`. Booleans read as questions, and one
word is used for each concept everywhere: a "worker" is never also an "agent" or a "job".

`src/core/worker.ts`:

```ts
export function hasOpenPane(worker: Pick<WorkerRecord, "state" | "pane">): boolean {
  return worker.pane !== undefined && !CLOSED_STATES.includes(worker.state);
}
```

Other examples are `isClean(repo)` in `src/io/git.ts`, `countsTowardLimit(worker)` in
`src/core/worker.ts`, and the `shouldDeleteFiles` input of `deleteProject` in
`src/io/workspace.ts`.

## Functions

A function does one thing at one level of abstraction. It is short, takes 0–3 parameters, and
groups related values into an object. Guard clauses come first, and nesting stays at about two
levels. A `check`, `assert` or `require` function never changes state.

Related values are grouped into an object. `src/io/git.ts`:

```ts
export async function addWorktree(
  repo: string,
  worktree: { path: string; branch: string; from: string },
): Promise<void> {
```

Guard clauses use an early exit. `src/workers/dispatch.ts`:

```ts
function assertCapacity(workers: readonly WorkerRecord[], maxWorkers: number): void {
  const running = workers.filter(countsTowardLimit).length;
  if (running >= maxWorkers) {
    throw new RadianError(
      "worker_limit",
      `${running} of ${maxWorkers} workers are already running. Wait for one to finish, or stop one.`,
    );
  }
}
```

`dispatchWorker` in the same file reads top-down as the steps of a dispatch: check the mode and
capacity, select a profile, add the worktree, write the brief, save the record, then launch. The
details live in helpers below it, and public functions come before their helpers.

## Modules and dependency direction

Each module has one responsibility. I/O, logic, and presentation live in separate layers, and
dependencies point inward.

| Layer          | May import                             | Holds                                                |
| -------------- | -------------------------------------- | ---------------------------------------------------- |
| `src/core/`    | nothing in `src/`                      | pure rules: roles, profiles, status parsing, briefs  |
| `src/io/`      | `core`                                 | git, Herdr, config files, workspace and worker state |
| `src/workers/` | `core`, `io`                           | dispatch, poll, merge, stop, discard, send           |
| `src/install/` | `core`                                 | binding Radian into a workspace                      |
| `src/pi/`      | `core`, `io`, `workers`, the Pi SDK    | commands, tools, dialogs, status view, watcher       |
| `extensions/`  | `src/pi`, `src/io` (to build the deps) | the Pi package entry                                 |

Outside effects that tests replace are passed in as plain functions. `src/io/herdr.ts`:

```ts
/** Runs one herdr command. Injected so tests can stand in for Herdr. */
export type HerdrRunner = (args: readonly string[]) => Promise<HerdrResult>;
```

## Errors

There is one mechanism: throw `RadianError(code, message)` from `src/core/errors.ts`. There are
no result or outcome types. Messages tell the user what to do next.

`src/workers/finish.ts`:

```ts
if (!(await isClean(env.project.path))) {
  throw new RadianError(
    "dirty_checkout",
    `${env.project.path} has uncommitted changes; commit or stash them before merging.`,
  );
}
```

Errors are caught at the boundary that can show them:

- Slash commands run through `runCommand` in `src/pi/commands/index.ts`, which turns any error
  into a `ctx.ui.notify(..., "error")` message.
- Tools are built by `tool()` in `src/pi/tools/tool.ts`. They let errors propagate, and Pi
  turns them into failed tool results that the model reads.
- The installer CLI in `src/install/cli.ts` prints the message and exits 1.

An error is never swallowed. A `catch` either converts the error into a `RadianError` with a
clearer message, or it says why nothing is lost. `src/io/git.ts`:

```ts
} catch (_error) {
  // No merge in progress (for example an unknown branch): nothing to undo.
}
```

Invalid state is an error, not something silently replaced. `readJsonFile` in
`src/io/json-file.ts` returns the fallback only when the file is missing. Invalid JSON throws
`invalid_json`.

## Comments

Comments explain why: a non-obvious decision, a workaround, or a constraint. Comments that
restate the code, commented-out code, and stale TODOs are deleted.

`src/core/status.ts`:

```ts
// Agents write imperfect lines (bullets, capitals, dashes), so the format is
// matched loosely and anything else is kept as a note rather than rejected.
```

`src/io/workspace.ts`:

```ts
// Planning docs live in the project's .radian/ folder. Excluding it locally keeps
// the checkout clean for merges without changing the project's own .gitignore.
```

`src/pi/calm.ts`:

```ts
// Without a result renderer Pi uses its built-in one. Wrapping nothing would
// replace that fallback with an empty component and break the transcript.
```

## KISS and YAGNI

Radian uses the simplest solution that works, with no speculative options or layers.

- **State on disk.** All state is plain JSON or text, written by `writeJsonFile` in
  `src/io/json-file.ts` through a temporary file and a rename. A restart reads the same files,
  so it changes nothing.
- **Worker progress.** Workers report by appending lines to a `status` file, and
  `src/core/status.ts` parses those lines loosely. There is no result schema.
- **Composition.** When several functions need the same dependencies, they are held once instead
  of passed through every call, because a parameter repeated on every function is noise. A class
  holds them, one job each:
  - `State` (`src/pi/state.ts`) holds the session's view and settings.
  - `ProjectSession`, `ModelCarry`, `SessionLifecycle`, and `SystemPrompt` in `src/pi/session/`
    switch sessions, carry the model across a switch, start and end a session, and write
    Radian's part of the system prompt.
  - `StatusView` (`src/pi/status/status-view.ts`) shows the footer and reports, and `Watcher`
    (`src/pi/watcher/watcher.ts`) polls the workers.
  - `ProjectMode` (`src/pi/mode/project-mode.ts`) sets and toggles Plan/Build.

  The command and tool factories in `src/pi/commands/` and `src/pi/tools/` do the same with a
  closure over their dependencies. Objects are composed, not extended: `RegisterRadian`
  (`src/pi/register.ts`) builds each part once and hands it to the parts, commands, and tools
  that need it. The only subclasses are `RadianError` and `ModeEditor` in
  `src/pi/mode/mode-editor.ts`, which Pi's editor API requires. Pure rules in `core/`, stateless I/O
  in `io/`, and pure formatting such as `src/pi/status/footer.ts` stay plain functions.

- **Abstractions.** Knowledge is extracted once it is duplicated three or more times, or when
  copies must change together. One or two uses do not get an abstraction.

## Testing

- **Test-first fixes.** A defect gets a failing regression test first, then the fix.
- **Real git.** Git behaviour is tested against disposable repositories:
  - `tests/helpers/git-fixtures.ts` provides `makeRepository` and `commitFile`, and blanks the
    developer's git configuration and identity.
  - `tests/helpers/worker-fixtures.ts` builds a workspace with one project and the shipped
    config (`makeWorkerEnv`). It also plays a worker agent (`actAsWorker`) by committing in the
    worktree and appending status lines.
- **Fake Herdr.** `tests/helpers/fake-herdr.ts` records every herdr call and answers the ones
  Radian reads (`pane split`, `pane get`). Deleting a pane from its map simulates a closed
  pane.
- **Native Pi tests.** `tests/integration/` drives a real Pi over RPC with an offline faux
  provider. It covers workspace load, project switching, `/projects delete`, and a full
  dispatch.
- **Unit tests.** They mirror the source tree: `tests/unit/core/`, `io/`, `workers/`, `pi/`,
  `install/`, and `scripts/`. They use `node:test` and `node:assert/strict`, and Node runs the
  `.ts` files directly.

Run them with `npm test` (unit) and `npm run test:integration`.

## Formatting and linting

Prettier formats; ESLint owns quality. Never hand-format or fight the formatter.

- **Prettier** uses `.prettierrc` with `{ "printWidth": 100 }`. `.prettierignore` skips
  `node_modules`, `package-lock.json`, `coverage`, and `.radian`. Prettier formats Markdown and
  JSON too.
- **ESLint** uses `eslint.config.js`: `@eslint/js` recommended, `typescript-eslint`
  recommended, and `eslint-config-prettier`, plus these rules:
  - `eqeqeq`: error.
  - `max-depth`: error above 3.
  - `max-params`: warning above 4. The standard is 3, so group related parameters into an
    object.
  - `no-console`: error, except in `scripts/**` and `src/install/cli.ts`, which are command-line
    programs.
  - `@typescript-eslint/no-unused-vars`: error. Names starting with `_` are ignored, for example
    `catch (_error)`.
  - `@typescript-eslint/consistent-type-imports`: error, so type-only imports use
    `import type`.
- **TypeScript** runs from `tsconfig.json` with `strict`, `noUncheckedIndexedAccess`, and
  `erasableSyntaxOnly`, because Node strips types at run time. Import with `.ts` extensions, and
  don't use enums, namespaces, or parameter properties. Besides relative paths, `src/` may import
  through the `package.json` aliases `#core/*`, `#io/*`, `#workers/*`, and `#pi/*`.

Commands:

```sh
npm run format        # rewrite files with Prettier
npm run format:check  # fail if any file is not formatted
npm run lint          # ESLint
npm run lint:fix      # ESLint with automatic fixes
npm run typecheck     # tsc, no output files
```

There are no `eslint-disable` comments. If a rule gets in the way, change the code. If that
truly hurts readability, change the rule in `eslint.config.js` and note why.
