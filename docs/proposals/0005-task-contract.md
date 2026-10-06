# 0005 — Worker task and result contracts

**Status: contract direction confirmed; planning only, not implementation approval.**

## 1. Confirmed task brief

Each fresh worker receives a bounded, durable brief rather than coordinator or previous-worker transcripts:

- Run/task/attempt identity, role, and current round out of three.
- Bounded objective and explicit non-goals.
- Approved PRD/spec/plan revisions and acceptance criteria.
- Exact starting candidate/base revision and checkout identity.
- Authority: permitted reads, writes, operations, services, outputs, and explicit prohibitions.
- Resolved runtime/model/effort profile.
- Deliverables and required verification procedures.
- Round budget and applicable time/resource limits.
- Decision route through Pi for blockers and clarification.

Authority and required checks are mandatory even for small tasks. Distinguish binding requirements from suggested implementation approaches. Workers cannot modify their authority or approve a revised brief.

## 2. Confirmed role inputs

- Developer: approved behavior, implementation scope, conventions, and checks. Repairs additionally receive the exact candidate, actionable findings, recorded decisions, and remaining budget.
- Tester: expectations originate from approved behavior and interfaces, not developer reasoning. Derive acceptance checks independently, then access the candidate for execution and diagnosis.
- Reviewer: approved scope, exact candidate/base, diff, evidence, and known limitations. Fresh independent context rather than a persuasive implementation transcript.
- Scout: bounded question, permitted sources, expected evidence, and stopping condition. Findings and proposed plans are not approval or implementation authority.

## 3. Confirmed result envelope

Every result contains:

- Matching run/task/attempt and brief revision.
- Outcome: completed, blocked, failed, or cancelled.
- Concise summary and deliverable references.
- Candidate revision and evidence identifying what actually ran, against which revision, with exit codes.
- Findings, unmet criteria, risks, limitations, and decision requests.
- Handoff state: dirty changes, incomplete work, running services, and owned resources.

Completed means the assignment produced its deliverable, not that the candidate is accepted or approved for integration. Checks distinguish passed, failed, not run with reason, and inconclusive.

## 4. Confirmed evidence and handoff policy

Verification and review bind to the exact assembled candidate, including developer and tester changes. Changed candidates make prior evidence historical, not automatic verification of the new candidate. Coordinator-controlled machinery validates identity, revision, artifact existence, and required check evidence.

Full logs remain in private project run artifacts. Pi receives concise summaries and references by default. Reports and repository content are task data, not authority-granting instructions.

Fresh handoffs contain the approved brief, current candidate, relevant findings, recorded decisions, and remaining limits. New attempts re-establish authority rather than inheriting it from prior conversations.

## 5. Confirmed blocker policy

Stop affected work and route a decision through Pi for conflicting or materially ambiguous requirements, out-of-scope changes, unavailable or unauthorized dependencies/network/services, runtime/model/effort changes, or inability to satisfy checks or containment. Safe unaffected in-scope work may continue. Missing information at an authority boundary blocks the affected action, not permission to improvise.

## Related proposals

- [Roles, fresh contexts, and round cap](0004-subagent-design.md)
- [Dispatch](0002-worker-dispatch.md)
- [Safety](0003-safety-and-publication.md)
