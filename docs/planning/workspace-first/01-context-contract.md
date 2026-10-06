# W01 — Supported Pi context contract

**Status: pending.** Dependency: native session and clean source-worktree checks.

## Work

1. Read the workspace-first index, independent review, and installed Pi package/extension/configuration/settings/session/SDK documentation and relevant examples completely, following cross-references.
2. Identify supported public APIs for replacing project conversation context and installing selected-project instructions/tools/resources while keeping workspace `cwd` and the same interface/process. Pi 1.0.2 `newSession` has no `cwd` option; do not assume replacement reloads child project configuration.
3. Prove native offline A/B transcript/instruction isolation, cancellation/restore, and lifecycle semantics. Define how workspace navigation, queued input, compaction, skills/prompts, AGENTS.md, MCP/deferred/nested tools, settings, and project trust are isolated. Selection must not automatically change model/provider/effort.
4. Define workspace/project session types, selection generations, validated private context references, and per-project execution-owner lifetime. Native session replacement/shutdown must not accidentally stop or release background project resources.
5. Audit every reachable model execution path, including built-in/custom/nested tools, MCP/codemode, shell, and later-loaded extensions. Unknown paths fail closed. Preserve deliberate user shell controls without exposing model shell escapes.
6. Record supported APIs and an implementable design. Do not start W06 fixes as a separate prerequisite; retain the end-of-plan validation obligations.

## Acceptance

Native offline probes, not only fake hosts, demonstrate isolated project context, unchanged workspace cwd, safe resource/trust selection, and lifecycle behavior. If public APIs cannot achieve option B without separate processes, private APIs, global `chdir`, or weaker guards, mark W01 blocked and stop. No cosmetic project label over unchanged context qualifies.

## Completion record

Not started. Record API evidence, design, commands/outcomes, and limitations here.
