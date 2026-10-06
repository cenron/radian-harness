# 0010 — External source, workspace installation, and removal

**Status: direction confirmed below; planning only. No installer or runtime implementation approval.**

## 1. Confirmed user workflow

Maintain a separate Radian source checkout and explicitly install/bind it into a user-created workspace. Support removal from that workspace and installation into a different workspace without discarding project work or personal configuration.

Illustrative layout, not fixed required directory names:

```text
~/Documents/radian-harness/       external source checkout
~/Documents/engineering-workspace/
    project-a/
    project-b/
```

Radian is independent; product documents do not reference inspiration projects.

## 2. Confirmed execution and binding direction

- Run the Pi coordinator inside the selected project repository.
- One active engineering run per project initially.
- Workspace installation manages shared harness configuration and explicit project bindings, not a workspace-wide fleet manager.
- Use Pi's supported package mechanism; normal usage uses pinned releases, with an explicit local-development binding for harness development.
- Establish required resources explicitly in projects and worker worktrees. Do not assume a parent workspace's Pi configuration is inherited by nested repositories.
- Record source/version/config provenance for runs and metrics.
- Updates occur between runs only, never changing policy underneath active workers.

## 3. Confirmed installation/removal safety

- Explicit installation target; non-destructive changes.
- Preserve existing AGENTS.md, personal settings, and unrelated project configuration.
- Remove only unchanged, provably harness-owned configuration; retain local modifications and project work.
- Removing a binding does not delete the external harness checkout, projects, credentials, or deliverables.
- The workflow must support leaving one workspace and installing into another. Do not assume run/session state or credentials are automatically transferred.

## 4. Recommended installer contract — detailed mechanics pending

- Preview changes before applying install, update, or removal.
- Track workspace/project bindings and owned settings entries/files in an ownership manifest with original installed hashes.
- Merge only owned entries; do not replace shared settings wholesale.
- Explicitly register projects or confirm discovered projects; do not silently bind every nested repository.
- Refuse removal while associated workers/runs are active; offer a safe pause/cancel path separately, preserving work.
- For locally modified owned files, retain and report them; do not equate removal with destructive reset.
- Removal handles registered project bindings as well as workspace-level resources, and reports missing/moved projects or unresolved references.
- Validate canonical paths/symlinks and handle interrupted operations, missing source releases, and rollback.
- A new workspace starts with explicit registration/configuration; optional migration of private artifacts is separate and user-approved.

## 5. Open details

Command names, ownership/config directory names, project registration UI, release acquisition/offline behavior, removal handling of orphaned records, and whether to support multiple installed workspaces simultaneously remain to be specified. Shared pinned sources must not be deleted while still referenced.

## Related proposals

- [Overall package and installation direction](0001-direction.md)
- [Local macOS execution](0008-local-isolation.md)
- [Approval and preservation](0009-approval-and-integration.md)
