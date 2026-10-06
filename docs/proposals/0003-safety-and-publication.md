# 0003 — Worker guardrails and public-harness safety

**Status: planning only. Guardrails and public-safety checks are required; concrete enforcement design is not yet finalized.**

## 1. Confirmed requirements

- Workers must stay within their assigned area and authority, enforced by guardrails rather than role prompts alone.
- Worker sandboxing/resource containment is mandatory by default. Any weaker execution requires an explicit user-approved exception; never silently downgrade containment.
- Require public PII/secrets/machine-detail checks for this public harness.
- Keep Pi as coordinator with Pi, Codex CLI, and Claude Code workers.
- No implementation until the overall plan is finalized. Inspecting and running an existing reference scanner against planning documents does not install harness tooling.

## 2. Two separate safety surfaces

1. **Execution safety:** prevent accidental cross-role mutations, unapproved actions, lost work, uncontrolled delegation, and credential/data exposure while engineering runs execute.
2. **Publication safety:** prevent personal information, secrets, machine-specific details, and private project artifacts from entering this public harness's commits, packages, documentation, or exports.

A scanner does not constrain worker execution. A worker hook does not make a Git repository safe to publish.

## 3. Threat model and honest guarantees

Role/tool guards are an agent-mistake and prompt-injection mitigation layer, not proof of resistance to a hostile process with the same OS permissions. Worktrees, cwd, prompts, and Pi project trust do not create a sandbox.

Use defense in depth:

- Instructions explain the role, approved scope, and safe alternatives.
- Tool policy and native pre-execution controls block known unauthorized actions before effects occur.
- Runtime sandbox/OS/container restrictions provide mandatory worker resource containment by default, with explicitly scoped filesystem, process, credential, and network access.
- Verification and Git/forge protections catch or prevent unauthorized integration.

Mandatory containment is agreed. The initial direction is macOS-native OS isolation with Git worktrees, not mandatory containers or independent clones; see [local execution direction](0008-local-isolation.md). The concrete native mechanism and resource-access policy remain open for each runtime. Do not label an adapter as enforcing strict containment until its boundary has been selected and tested. A runtime without the required capability must be rejected for that role, not silently run in a weaker mode.

An exception must identify the task/attempt, relaxed restriction, reason, scope/duration, and explicit user approval. It must not become a blanket global bypass or authorize unrelated future tasks. Availability failures do not imply permission to weaken containment.

## 4. Central policy, runtime-specific enforcement

The coordinator resolves a task authority record before dispatch. It binds:

- Run/task/attempt identity, role, selected runtime/model, and approved artifact revisions.
- Canonical project/worktree identity and permitted read/write roots or file sets.
- Allowed operation classes, protected branches, report/output directory, and owned ports/processes.
- Provider/data restrictions, required checks, and retry limits.

Runtime adapters enforce the same policy using their supported surfaces:

| Runtime | Enforcement direction; version-specific verification required |
| --- | --- |
| Pi | Restricted tools plus `tool_call` interception; cover nested tools, extension/MCP tools, and user shell paths deliberately |
| Claude Code | Native permissions/tool restrictions and appropriate pre-tool hooks; confirm loaded hooks and actual deny behavior |
| Codex CLI | Supported native sandbox/approval/tool or hook controls for the selected version; verify rather than assuming Claude-compatible behavior |

A Pi extension cannot intercept a separate worker's tool calls. Herdr agent detection does not prove that permission controls loaded successfully. Preflight needs to establish enforcement before any task mutation.

Policy-loading, identity, or authorization failure blocks the controlled action and reports a blocker. Critical guardrails must not fail open to keep the worker productive.

## 5. Proposed role boundaries

| Role | Permitted writes | Forbidden by default |
| --- | --- | --- |
| Coordinator | Approved specs/plans and owned run state; narrow approved integration operations | Routine production implementation; unapproved publish/merge; bypassing dispatch |
| Developer | Assigned production/test files in its worktree and own output directory | Other worktrees, protected branch mutation, push/merge, harness policy edits |
| Tester | Assigned acceptance-test files and own evidence/output directory | Production changes, relaxing expected behavior, push/merge |
| Reviewer | Its report only | Source/test mutation, dependency installation, Git mutation, arbitrary executable commands |
| Scout | Its report and explicitly allowed investigation artifacts | Production mutation or publishing |

These are proposed defaults, not final role definitions. File scope alone cannot distinguish changing a test legitimately from weakening assertions; exact-candidate verification and independent review remain necessary.

### Containment details

- Resolve relative paths against the recorded task cwd; validate canonical containment, including traversal and symlink escapes. For new files validate the existing parent chain, with execution-time checks to reduce path races.
- Do not use substring matching such as “path contains the run-folder name.”
- Separate report inboxes from coordinator-owned approvals and state. Worker-editable reports cannot grant authority or overwrite policy.
- Keep enforcement configuration outside worker-writable scope; attest/snapshot the selected policy. Removing a project hook must not be an ordinary permitted worker edit.
- Include filesystem reads and network access in the design, not only writes. Do not expose the full home directory or unrelated project credentials merely because the CLI needs authentication.
- Shared Git worktree metadata permits cross-branch effects; branch guards and external protections remain necessary. Stronger separation may require independent clones or a constrained Git interface.
- Gitignored files are unpublished by default, not inaccessible. Tests/builds/installers execute code and may mutate files or access services.

## 6. Shell, tools, and delegation

A command-name allowlist cannot prove a shell command is read-only. Interpreters, substitutions, redirects, command wrappers, Git options, executable scripts, and tools such as awk/find can produce side effects. Prefer fixed scoped operations for read-only roles over unrestricted shell plus regex filtering.

Cover all exposed execution channels or disable unsupported ones: native file tools, shell, nested tools, MCP, extension tools, installers, background processes, and runtime-native delegation. Unknown tools do not inherit permission from a read-only role label.

Require work-producing delegation to pass through Radian's registered dispatch path. Workers cannot create an untracked agent tree, schedule, worktree, or alternate agent process by default. Any future delegated child must inherit or narrow authority and become a supervised task. Shell-capable workers require an OS/process boundary or explicit limits before claiming this prohibition is unbypassable.

Never launch workers with blanket permission/sandbox bypass flags as a normal operating mode. Missing trust, auth, or approvals are blockers, not prompts the coordinator automatically accepts. Fallback or runtime/model/effort escalation still requires the user's approval under the current agreed policy.

## 7. Git, lifecycle, and evidence

- Discover and configure protected branches rather than assuming every project uses `main`.
- Workers cannot push, merge into protected targets, remove worktrees/branches, or terminate unrelated processes.
- Coordinator integration binds human approval to the exact verified candidate and target; revalidate changed heads and required checks.
- Use external branch/forge protections where available; local hooks are not the only barrier.
- Reject stale worker generations/results; revoke old authority before replacement.
- Cleanup refuses dirty, unintegrated, ambiguously owned, or still-running work. Preserve evidence before removing owned resources.
- Logs of denied actions carry stable rule IDs, reason, and a safe alternative. Do not include secrets or private file content in diagnostics.

## 8. Public-safety scanning baseline

Radian's planned scanner must check tracked and untracked non-ignored text files for:

- Absolute user-home paths, including Windows user paths.
- Email addresses, with limited neutral-example/GitHub exceptions.
- Private IPv4 addresses.
- Private-key headers and common API-token formats.
- Patterns suggesting hardcoded secret assignments.
- Literal case-insensitive personal terms supplied through a local, uncommitted denylist.

Private denylist configuration must remain local and outside the repository; its path and configuration interface are not yet finalized. Do not put private denylist values in this repository, public CI configuration, or agent reports.

### Planned adoption

- Implement the scanning baseline with tests when implementation is authorized. Any third-party code reuse requires license and attribution review.
- Run it locally before commits/publication and in CI; no model call is needed.
- Provide private local denylist configuration without copying personal values into the harness.
- Public CI provides generic scanning; it cannot be described as checking a maintainer's private denylist unless explicitly configured to do so.
- Avoid machine-specific values in docs and examples; use home-relative paths, placeholders, and neutral sample data.
- Before release, inspect the actual staged/published content, not just the current working tree. Add Git-history/commit-metadata and package/archive review as separate coverage.
- A deliberate exception requires a narrow reviewed allowance, never disabling the scanner wholesale.
- Avoid echoing raw matched secrets/PII into CI logs; use redacted diagnostics while preserving local actionable file/rule locations.

### Limits to disclose

A text-pattern baseline alone does not cover ignored/binary content, Git history or commit author metadata, semantic inspection of screenshots/attachments, or every secret format. Distinguish incomplete or unreadable scans from clean scans. No findings means only that no covered pattern was found in successfully scanned content.

Local hooks are bypassable and CI is downstream of a push: neither can undo disclosure after a secret has been published. A personal denylist and a human pre-publication review remain important. Supplementary secret scanning/history review should be considered without claiming the baseline catches every credential format.

## 9. Protect project data from public harness material

- Specs, private task prompts, transcripts, auth/config files, raw logs, screenshots, and run artifacts stay in the target project's private/runtime area by default, not in the harness repository.
- Harness-improvement proposals use explicitly approved, anonymized summaries. Do not automatically aggregate private projects into public examples or test fixtures.
- Runtime metrics record provenance without raw prompts or credentials; exports are opt-in and reviewed.
- Provider dispatch must honor project data restrictions; switching runtime may change where data is sent even when filesystem permissions stay the same.
- Redaction is defense in depth, not permission to ingest secrets indiscriminately.

## 10. Verification before support claims

Test policies against each supported runtime/version in isolated fixtures:

- Allowed in-scope work and denied cross-role/out-of-tree reads/writes.
- Traversal, symlink escapes, shell redirection/interpreters, alternate tool paths, and policy tampering.
- Native delegation/alternate CLI launch attempts, protected Git operations, unsafe dependency/network/process actions.
- Missing/broken hooks, unknown identities/tools, trust dialogs, reload/resume, and stale results.
- Scanner safe examples and planted findings, denylist behavior, partial staging, scan errors, binary exclusions, and redacted diagnostics.

Portable tests and real runtime tests are both required. A test in which the model simply never attempts the forbidden action is not evidence that a hook denied it.

## 11. Decisions still needed

1. Concrete containment mechanisms for Pi/Codex CLI/Claude Code, and how scoped user-approved exceptions are recorded. Mandatory containment by default is already agreed.
2. How far role read access should extend beyond write scope, and which network/services each task may use.
3. Approval policy for dependency installation and other operational side effects during approved work.
4. Publication gates beyond the required text-pattern scanner: staged files, history, metadata, release artifacts, and additional secret scanning.

## References

- [Direction](0001-direction.md) and [worker adapters/dispatch](0002-worker-dispatch.md)
- [Research notes](../research/reference-notes.md)
- [Pi security](https://pi.dev/docs/latest/security)
