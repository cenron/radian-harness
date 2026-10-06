# 0008 — Local macOS execution and worktree isolation

**Status: product direction confirmed below; planning only. Concrete OS enforcement and access policy still require selection and verification.**

## 1. Confirmed direction

- Target macOS initially, for personal local agentic engineering.
- Use Git worktrees for worker checkout isolation; independent clones/snapshots are not required as the default.
- Use native OS isolation rather than requiring containers for the initial harness.
- Keep the initial solution pragmatic and lightweight. Stronger isolation can be added later if needed.
- Pi, Codex CLI, and Claude Code remain in worker scope; Herdr remains the visible terminal surface.

This narrows the implementation approach, not the previously agreed default containment requirement. Worktrees separate changes but are not OS sandboxes. No concrete native enforcement mechanism has yet been selected or tested, and no enforcement parity is claimed across runtimes.

## 2. Recommended threat model and minimum boundary

Optimize for preventing agent mistakes, accidental cross-task effects, and prompt-induced unauthorized actions during trusted local development. Do not claim protection against a deliberately hostile same-user process or comprehensive compromise of arbitrary dependencies.

Retain role/task write scope, protected coordinator approvals/policy, no worker push or target integration, registered delegation, owned-resource cancellation, and preservation of unfinished work. Native runtime permissions and scoped tools complement the selected OS boundary; prompts alone are insufficient.

Shared worktree Git metadata requires deliberate policy. Workers should have only the Git operations needed to inspect and deliver their changes; they must not mutate other branches/worktrees or clean up repository resources. Exact operation controls and OS coverage remain to be verified.

## 3. Confirmed ordinary task permissions

Approve ordinary development capabilities with the task rather than prompting for each command:

| Operation | Default policy |
| --- | --- |
| Read relevant project files | Allowed within recorded task read scope |
| Edit assigned worktree files | Allowed for developer/tester roles within their role and task boundaries |
| Run project checks and builds | Allowed within task/resource limits |
| Install existing locked dependencies locally | Allowed within the task environment |
| Start local test services | Allowed with task-owned ports/processes |
| Add dependencies or change the lockfile | Allowed only within approved scope; otherwise ask |
| Install host-global tools or use elevated privileges | Ask; no ordinary worker authorization |
| Access production systems, publish, push, or merge | Not authorized by ordinary worker tasks |
| Change runtime/model or escalate effort | Ask under existing policy |

Default network access permits the selected model provider, normal project dependency registries, and approved local test services—not unrestricted access to unrelated systems. Record concrete permissions in the task authority; role-specific restrictions still apply. This policy does not grant report-only reviewers installation or arbitrary execution privileges.

Permission to run installers/builds does not authorize their effects outside the task boundary. Native enforcement must be verified, and unsupported access must be surfaced rather than silently broadened.

## 4. Confirmed concurrency and assignment limits

- Maximum **three active workers at a time by default**, configurable rather than hardcoded. The ceiling applies across all roles and Radian-managed runs in the installed workspace, not separately per role or project. Live blocked/idle workers retain their slots; safely retired workers release them.
- Configuration must support higher concurrency and multiple workers of the same role, such as two developers and three testers. No fixed one-worker-per-role restriction. Increasing capacity does not authorize new tasks, broaden scope, or reset other budgets.
- Developer and tester assignments may run in parallel in separate worktrees. Review starts when an exact candidate and verification evidence are ready.
- Never allow concurrent writers to the same worktree. Multiple same-role workers require separately scoped assignments, resource ownership, and candidate integration.
- Queue ready assignments when capacity is full and reserve capacity before launch/replacement. Queued tasks may exceed capacity; active launches may not. Precise configuration names and cross-coordinator reservation mechanics remain to be specified.
- **30-minute assignment timeout** by default, starting when the assignment becomes ready to execute and followed by a safe stop and a decision through Pi, not an automatic extension. Questions and quota waits are excluded and measured separately as blocked time. Crash replacements inherit remaining assignment time rather than resetting the timer. Queue/preflight boundary and user-pause accounting still require precise specification.
- Scouts receive a bounded investigation assignment and return unresolved questions to Pi rather than continuing an open-ended research loop.
- Record usage/cost where observable. Do not invent a dollar cap or cost measurement for subscription runtimes that cannot reliably expose it.
- The three-candidate-round cap and one automatic infrastructure recovery per assignment remain separate limits. New panes reset neither.

## 5. Remaining decisions and feasibility checks

- Select a macOS-native restriction mechanism and verify it with each supported runtime/version. Avoid unsupported claims about filesystem, process, or network enforcement.
- Choose permitted read/write roots, task scratch/output directories, credential access and refresh behavior, and protected run-state storage.
- Resolve the confirmed dependency/network/service policy to concrete registries, destinations, task-local install paths, and owned port/process allocations; verify native enforcement coverage.
- Establish safe worktree allocation, exclusive mutable ownership, candidate assembly, target drift handling, and cleanup.
- Test allowed development/build/test activity and explicit forbidden operations, including alternate tool paths, shell execution, shared Git metadata effects, and reload/recovery.

If a required restriction cannot be established, disclose the gap and block that assignment or request an explicit scoped exception. Do not silently substitute unrestricted execution. Broader Linux/container support is deferred, not required initially.

## Related proposals

- [Worker guardrails](0003-safety-and-publication.md)
- [Lifecycle and recovery](0006-lifecycle-and-improvement.md)
- [Finalization checklist](0007-interface-and-finalization.md)
