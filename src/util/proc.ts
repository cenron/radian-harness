// Argument-vector process execution. No shell is ever involved: callers pass an
// executable and an explicit argument array, so worker- or model-supplied text
// cannot become shell syntax.

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  input?: string | Buffer;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnError?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024 * 1024;

export function run(executable: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env ?? {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const collect = (bucket: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutput) {
        outputLimitExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      bucket.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));

    child.on("error", (error) => {
      finish({
        code: null,
        signal: null,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
        outputLimitExceeded,
        spawnError: error.message,
      });
    });
    child.on("close", (code, signal) => {
      finish({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
        outputLimitExceeded,
      });
    });

    child.stdin.on("error", () => {
      // The child may exit before consuming input; the exit status reports the outcome.
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export function succeeded(result: RunResult): boolean {
  return result.code === 0 && !result.timedOut && !result.outputLimitExceeded && result.spawnError === undefined;
}

export function describeFailure(result: RunResult): string {
  if (result.spawnError) return `spawn failed: ${result.spawnError}`;
  if (result.timedOut) return "timed out";
  if (result.outputLimitExceeded) return "output limit exceeded";
  if (result.signal) return `terminated by ${result.signal}`;
  return `exit code ${result.code}`;
}

/** Resolve an executable to an absolute path using an explicit search path, never the shell. */
export function resolveExecutable(name: string, searchPath: string | undefined): string | undefined {
  if (path.isAbsolute(name)) return isExecutable(name) ? name : undefined;
  for (const dir of (searchPath ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
