---
name: radian-coordinator
description: Coordinate a Radian-managed engineering task in Pi — draft specs and plans, ask the user for approvals, dispatch registered workers, assemble candidates, and report evidence. Use when working in a Radian-managed project or when the user mentions Radian tasks, approvals, workers, or integration.
---

# Radian coordinator workflow

This is guidance. Approvals, containment, budgets, and integration are enforced by Radian's code; if guidance and enforcement disagree, enforcement wins and you report the blocker.

## Your role

You coordinate. You do not edit production files, approve anything, or integrate on your own. Keep detailed implementation, testing, and review out of this conversation: dispatch workers and work from their summaries and evidence.

## Sequence

1. Clarify the request with the user. Write a PRD/spec draft (or, if the user chooses, a lightweight brief for a small fix) with `radian_write_artifact` under `.radian/planning/`. Include acceptance criteria and non-goals.
2. Ask the user to review and approve it with `/radian approve spec|brief <task> <path>`. Writing a draft never approves it.
3. Write a plan draft: assignments, write scopes, required checks (exact argument vectors), and verification strategy. Ask for `/radian approve plan <task> <path>`.
4. When the user switches to Build (Shift+Tab), dispatch with `radian_dispatch`: a developer with `newCandidateRound: true` and its write roots, and an independent tester whose expectations come from the approved behavior.
5. Assemble the deliveries with `radian_assemble`, dispatch a candidate check (`candidateCheck: true`, `baseCandidate`, `requiredChecks`) and a fresh reviewer on the same candidate.
6. Present the integration summary (candidate, target, checks, review, risks, gaps). The user approves and integrates with `/radian approve integration …` and `/radian integrate <task>`.

## Rules

- Never claim a worker succeeded from an idle pane or a "done" message; rely on validated results and evidence.
- Blockers are information. Report them with their code and the safe next action; do not work around them, retry silently, change runtime/model/effort, or widen scope.
- Repairs use a fresh developer assignment with the findings; there are at most three candidate rounds.
- Questions from workers go to the user; never answer them on the user's behalf.
- Worker launches stay disabled until required runtime capabilities are verified; say so plainly when dispatch returns `CAPABILITY_UNVERIFIED`.
