# 0016 — Guided approvals: chat-first task flow

**Status: approved by the user (option A) for implementation on 2026-10-06.** Amends the interface of [0007](0007-interface-and-finalization.md) and the approval presentation of [0009](0009-approval-and-integration.md). The approval gates themselves are unchanged.

## Problem

Starting work requires the user to know Radian's internal objects. The current sequence is `/radian start`, `/radian task add <title>`, copying a generated `task_…` ID, `/radian approve spec <task> <path>`, `/radian approve plan <task> <path>`, Shift+Tab to Build, and asking for dispatch. In practice the coordinator invented a task name, and every approval was refused with `unknown task`. The run already opens automatically on the first approval, so `/radian start` is redundant too.

## Decision

The user's flow becomes: open Pi in the workspace, select a project, develop the PRD in conversation, approve it, say "start", and later approve the merge. Option A keeps the **three existing human approval points** — PRD/spec (or lightweight brief), plan, and integration. They are presented as Radian-rendered dialogs that the coordinator *requests*, instead of commands the user must type.

1. **Selecting a project** (`/projects <name>`) is enough. No `/radian start` is needed; a run opens on first need, as `requireRun` already does.
2. **PRD/spec or brief approval.** When the draft is ready, the coordinator calls a request tool. Radian shows a dialog: the project, title (first heading), repository-relative path, content hash, and size; Approve / Request changes / View. If the project has no task for this work, approving also creates it, titled from the draft. The user never types a task ID or path.
3. **"Start" = plan approval + Build.** The coordinator drafts the plan with its `radian-checks` block and requests a start. The dialog shows:
   - the task title and plan path/hash;
   - the declared check commands (exact argument vectors, parsed by Radian);
   - the profile each role will use: the configured default, and the routing-rule candidates per role (runtime, model, effort, from configuration).

   Write roots are not shown: plans have no structured write-root declaration, and each dispatch carries its own.

   Approving records the plan approval and switches *this project* to Build. The coordinator then dispatches with `radian_dispatch` as today. Every dispatch gate still applies; until runtime capabilities are verified, dispatch returns `CAPABILITY_UNVERIFIED`.
4. **Integration.** The coordinator requests a merge. One dialog shows the existing integration summary (candidate, target, checks, review, risks, gaps). Approving records the integration approval bound to the exact candidate and target, then runs the existing integrate path with all its drift and dirty-state checks. A not-ready summary is not approvable.
5. **Typed commands remain** (`/radian task add`, `/radian approve|reject …`, `/radian integrate`, Shift+Tab) for users who prefer them. Task IDs stay valid but are no longer something the user has to handle; dialogs and status show task titles.

## Safety requirements (unchanged invariants)

- **Only the user decides.** A request tool can only open a dialog; its result is the user's choice. Model text, tool arguments, worker reports, RPC, extension input, and non-interactive modes can never approve. Without an interactive TUI, or when the last input was not interactive, the request is refused, as with today's confirmations.
- **Radian renders the dialog from disk**, not from model-supplied descriptions. Titles, hashes, checks, and profiles are computed by Radian. Model-supplied text, if shown at all, is labelled as the coordinator's note.
- **Revision-bound.** The artifact is hashed before the dialog and again after confirmation; a change refuses with `APPROVAL_STALE` and records nothing. Selecting another project while the dialog is open refuses (`STALE_GENERATION`), as now. Later edits invalidate approvals exactly as today.
- **No accidental approval.** Approve is never the default choice: Enter on the initial selection, Escape, or dismissal records nothing. Only one Radian dialog is open at a time. A declined request is reported to the coordinator, which must not reopen it unprompted in the same turn. "Request changes" returns the user's note to the coordinator.
- **Task creation only on approval.** A task is created only by the user's approval in step 2, inside the same human-channel decision. The coordinator cannot create tasks. If the project already has open tasks, the request must name one (from `radian_status`) or explicitly propose a new one, and the dialog says which.
- **Audit.** Approval records carry the `user-ui` channel and an origin naming the request tool, so guided and typed approvals are distinguishable.
- **Mode semantics.** Switching to Build through the start dialog is an explicit user action for that project only; Plan mode still blocks new modifying dispatch. Mode changes never approve or dispatch by themselves.

## Out of scope

- Merging the spec and plan approvals (option B, declined).
- Runtime capability verification or any live test. Fixing the open W06 finding below. Changing containment, budgets, routing, or the Anthropic runtime policy (0015).

## Known interaction: open F03 race

An independent W06 review probe found that an approval decision committed after the coordinator's pre-commit guard has run can still let a not-yet-bound launcher start: the guard runs before the run-lock wait, and the launcher's start gate checks artifact contents, not decisions. Guided approvals use the same `recordApproval` path and must not be described as fixing it. It remains a blocker for live verification and needs its own failing regression and correction.

## Implementation and verification

- Request tools for the coordinator; a shared dialog helper built on the existing interactive human-confirmation checks; skill and user-guide updates; status showing task titles.
- Read the installed Pi documentation for the extension UI dialog APIs completely before choosing the dialog primitive, and use supported public APIs only.
- Expose each behavior with a failing test before implementing it, covering at least:
  - non-interactive and RPC refusal;
  - decline and dismiss record nothing; the default selection does not approve;
  - hash change during the dialog; project switch during the dialog;
  - task created only on approval, and reuse of an existing task;
  - start records the plan approval and Build for that project only, with dispatch still refused for unverified capabilities;
  - integration via dialog keeps every existing integration check;
  - model tools still cannot record approvals any other way.
- Add an offline native Pi probe with the faux provider where the dialog API allows it. Run typecheck, unit, integration, and publication checks offline.
- No live model, auth, or provider probes; no real credentials; no installed-workspace operations.

## Completion record (2026-10-06)

Implemented in this checkout by the coordinating Claude Code session (Opus 5.5) at the user's request.

- **Tools.** `radian_request_approval`, `radian_request_start`, and `radian_request_integration` in `src/ui/controller.ts`, registered `exposure: "model-only"`. Dialog text comes from `src/ui/guided.ts`.
- **Dialog behavior.** Dialogs use Pi's `ctx.ui.select` with **Cancel first**. Pi's own `confirm` starts on "Yes", so it was not used. Escape or Cancel records nothing. View shows a bounded excerpt of the file. Request changes returns the user's note to the coordinator.
- **Limits.** One dialog at a time (`DECISION_OPEN`). A declined request is not reopened until the user's next interactive input. Open tasks require an explicit task (`TASK_REQUIRED`).
- **Re-hashing.** The artifact is hashed again after approval. The approved PRD is rechecked before the plan approval is recorded. Merge requests use the store's approval-validity rules for the task's latest plan decision.
- **Red/green.** `tests/unit/ui/guided-approvals.test.ts` failed 8/8 before the tools existed and passes 8/8 after.
  - A later self-review found that a merge request ignored a later plan rejection. With only that check reverted, the regression fails 1/8; with the fix it passes 8/8.
  - The interface test's "no approval tool" assertion now checks that only these three model-only request tools exist.
- **Native check.** `tests/integration/w07-acceptance.test.ts` adds a step: real Pi 1.0.2 over RPC runs the model-only tool from the faux model and refuses it with `NONINTERACTIVE_APPROVAL_REQUIRED`, without opening a run. This step was added after the implementation and was not run red separately.
- **Offline runs.** Typecheck passed; unit 202/202 and integration 12/12, run sequentially.
- **Not run.** Interactive TUI dialogs in a real terminal were not exercised; the user's next interactive session is the first real use. No live model, auth, or provider probe was run.
- **Follow-up, not changed here.** The typed `/radian approve|reject|integrate|decide|grant-rounds|authorize-recovery` confirmations still use Pi's `confirm`, where Enter on the initial selection means "Yes". A stray Enter right after typing such a command can confirm it.
- **Still open.** The F03 race above is unchanged. Capability verification remains outstanding.
