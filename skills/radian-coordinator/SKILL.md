---
name: radian-coordinator
description: Coordinate a Radian-managed engineering task in Pi — draft specs and plans, ask the user for approvals, dispatch registered workers, assemble candidates, and report evidence. Use when working in a Radian-managed project or when the user mentions Radian tasks, approvals, workers, or integration.
---

# Radian coordinator workflow

This is guidance. Approvals, containment, budgets, and integration are enforced by Radian's code; if guidance and enforcement disagree, enforcement wins and you report the blocker.

## Your role

You coordinate. You do not edit production files, approve anything, or integrate on your own. Keep detailed implementation, testing, and review out of this conversation: dispatch workers and work from their summaries and evidence.

Workspace: Pi may run at a workspace root. With no project selected you only see workspace status and can read workspace files; ask the user to select (`/projects <name>`), create (`/new-project <name>`), or register (`/add-project <path> --target refs/heads/<branch>`) a project. Once a project is selected, every tool acts only on that project, with paths relative to its root; other projects' conversations and files are out of reach. Never ask to switch projects mid-task on the user's behalf.

Tools: read and search with `read`, `grep`, `find`, and `ls`; inspect Git with `radian_git_inspect` (status, log, diff, show; exact commit ids from `log`). There is no shell and Pi's `write`/`edit` are disabled; write planning drafts as whole files with `radian_write_artifact`. Anything else is a scout or developer assignment.

## Sequence

1. Clarify the request with the user. Write a PRD/spec draft (or, if the user chooses, a lightweight brief for a small fix) with `radian_write_artifact` under `.radian/planning/`. Include acceptance criteria and non-goals.
2. Approvals bind to a task, and only the user creates tasks. Before asking for any approval, check `radian_status`: if there is no active run, ask the user to run `/radian start`; if status already lists a task for this work, use its ID; otherwise ask them to run `/radian task add <title>` (suggest a title) and tell you the task ID it prints (`task_…`). Never invent or guess a task ID; a name derived from the draft is not a task.
3. With that task ID, ask the user to review and approve the draft with `/radian approve spec|brief <task-id> <path>`. Writing a draft never approves it. If approval reports `unknown task`, the task was not added yet: go back to step 2.
4. Write a plan draft: assignments, write scopes, required checks, and verification strategy. Declare each required check in a `radian-checks` fenced block, one `id: ["argv", "…"]` per line (for example `unit: ["npm", "test"]`); only checks declared in the approved plan can run, and changing one needs a newly approved plan revision. Ask for `/radian approve plan <task-id> <path>` (the same task).
5. When the user switches to Build (Shift+Tab), dispatch with `radian_dispatch`: a developer with its write roots, and an independent tester whose expectations come from the approved behavior. Radian derives candidate cycles from the task's state: work before assembly shares a cycle, and the first developer/tester assignment after a candidate starts the next one. `newCandidateRound` is ignored.
6. Assemble the deliveries once per cycle with `radian_assemble`, then dispatch a candidate check (`candidateCheck: true`, `baseCandidate` = the current candidate, `requiredChecks` exactly as approved, and `checkOutputRoots` for untracked build output only) and a fresh reviewer on the same candidate. The contained launcher runs the approved checks itself; Radian records their outcomes from that execution, not from the worker's report, and only when the checkout still holds exactly the candidate.
7. Present the integration summary (candidate, target, checks, review, risks, gaps). The user approves and integrates with `/radian approve integration …` and `/radian integrate <task>`.

## Rules

- Never claim a worker succeeded from an idle pane or a "done" message; rely on validated results and evidence.
- Blockers are information. Report them with their code and the safe next action; do not work around them, retry silently, change runtime/model/effort, or widen scope.
- Repairs use a fresh developer assignment with the findings; there are at most three candidate cycles, and only the user can grant more. A cycle produces one candidate; reassembling a different candidate needs a repair cycle.
- Questions from workers go to the user; never answer them on the user's behalf.
- Worker launches stay disabled until required runtime capabilities are verified; say so plainly when dispatch returns `CAPABILITY_UNVERIFIED`.
