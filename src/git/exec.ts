// Controlled Git invocation. Every call uses an argument vector, a cleared
// environment, no global/system configuration, and configuration overrides that
// neutralize hooks, filesystem monitors, pagers, credential helpers, and external
// diff programs. Repository-local configuration is still read by Git; callers
// that mutate refs must use the narrower operations in src/git/controlled.ts.

import { resolveExecutable, run, succeeded, describeFailure, type RunResult } from "../util/proc.ts";

export interface GitContext {
  /** Absolute path of the Git executable used for every invocation. */
  gitPath: string;
  /** Repository working directory (or Git directory for bare inspections). */
  cwd: string;
  /** Object format of the repository; selects the matching empty tree. Defaults to sha1. */
  objectFormat?: "sha1" | "sha256";
}

export const NEUTRALIZING_CONFIG: readonly string[] = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.pager=cat",
  "core.askPass=",
  "credential.helper=",
  "diff.external=",
  "gc.auto=0",
  "maintenance.auto=false",
  "protocol.allow=never",
  "submodule.recurse=false",
  "commit.gpgSign=false",
  "tag.gpgSign=false",
  "core.editor=false",
  "sequence.editor=false",
  "merge.autoStash=false",
  "rebase.autoStash=false",
  "core.sshCommand=false",
  "core.gitProxy=",
  "fetch.recurseSubmodules=false",
  "uploadpack.packObjectsHook=",
];

export function controlledGitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: "/nonexistent-radian-home",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_PAGER: "cat",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    ...extra,
  };
}

export function locateGit(searchPath: string | undefined = process.env.PATH): string | undefined {
  const explicit = process.env.RADIAN_GIT;
  if (explicit) return resolveExecutable(explicit, undefined);
  return resolveExecutable("git", searchPath);
}

/** Git's well-known empty tree. Reading attributes from it disables attribute-driven
 * helpers (filter, diff, and merge drivers, textconv) for every controlled call. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

export function gitArgv(args: readonly string[], objectFormat: "sha1" | "sha256" = "sha1"): string[] {
  const argv: string[] = [`--attr-source=${objectFormat === "sha256" ? EMPTY_TREE_SHA256 : EMPTY_TREE}`];
  for (const setting of NEUTRALIZING_CONFIG) argv.push("-c", setting);
  argv.push(...args);
  return argv;
}

export interface GitCallOptions {
  input?: string | Buffer;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export async function git(ctx: GitContext, args: readonly string[], options: GitCallOptions = {}): Promise<RunResult> {
  return run(ctx.gitPath, gitArgv(args, ctx.objectFormat), {
    cwd: ctx.cwd,
    env: controlledGitEnv(options.env),
    input: options.input,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  });
}

export class GitError extends Error {
  readonly args: readonly string[];
  readonly result: RunResult;
  constructor(args: readonly string[], result: RunResult) {
    // stderr is intentionally excluded from the message: it can contain paths or
    // repository content. Callers may inspect `result` locally.
    super(`git ${args[0] ?? ""} failed: ${describeFailure(result)}`);
    this.args = args;
    this.result = result;
  }
}

export async function gitOk(ctx: GitContext, args: readonly string[], options: GitCallOptions = {}): Promise<Buffer> {
  const result = await git(ctx, args, options);
  if (!succeeded(result)) throw new GitError(args, result);
  return result.stdout;
}

export async function gitText(ctx: GitContext, args: readonly string[], options: GitCallOptions = {}): Promise<string> {
  return (await gitOk(ctx, args, options)).toString("utf8").trim();
}

/** Split NUL-delimited Git output, dropping the trailing empty field. */
export function splitNul(buffer: Buffer): string[] {
  const text = buffer.toString("utf8");
  const parts = text.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
