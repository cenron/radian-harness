# W03 — Dashboard and project-scoped routing

**Status: pending.** Dependency: W02.

## Work

1. Discover managed workspaces before Git repositories. Support dashboard/project-selected/blocked states and direct registered-project startup. Invalid recognized workspace identity/configuration/registry must not become unrestricted Pi.
2. Register `/projects`, `/workspace`, and workspace status. List explicitly registered projects with readable names/paths, missing/moved status, runs, and blockers; never silently bind discovered repositories.
3. Display workspace, selected project or none, PLAN/BUILD, and workspace capacity. Without selection, disable engineering dispatch, approvals, candidate assembly/integration, and project planning writes. Mode changes affect only the selected project.
4. Capture immutable project identity/generation for every command/tool. Validate project-relative and absolute paths against that project; do not reinterpret an A path in B. Constrain actual read/search implementations and returned data, not just read/grep/find/ls names. Cross-project/private-state reads fail closed.
5. Keep the no-shell policy and dedicated `radian_git_inspect`; restrict unknown/deferred/nested/MCP/codemode execution routes. Planning writes use the verified scoped path, not Pi write/edit.
6. Preserve project config snapshots, approvals, immutable candidate checks/output roots, launcher evidence, launch authorization, owned resources, and durable cycles. Routing must not weaken them or change another project's settings/capabilities.

## Acceptance/tests

Offline/fake-host tests cover empty roots, invalid managed bindings, direct entry, no-selection actions, display/modes, traversal/absolute/link paths, arbitrary read/search inputs, unknown/nested tools, and selection changing during an awaited A operation. No deferred A operation may read/write/approve B. Existing remediation tests remain green; W06 covers additional counterexamples.

Isolated activation is not complete until W05; a dashboard alone is not project switching.

## Completion record

Not started.
