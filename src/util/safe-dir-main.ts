// Child helper for namespace-safe directory operations (see safe-dir.ts).
// It is started with its working directory set to the target directory and
// receives the device/inode that the parent validated through a link-refusing
// open. It refuses unless "." is exactly that directory, then performs only
// single-name operations relative to ".", which the kernel resolves through
// the verified working directory rather than by re-resolving a path. Finally
// it re-checks that the directory is still at its path; if it was moved during
// the operation, directories it created are removed again.
//
// argv: <dev> <ino> <dir-path> <json-ops>; stdout: one JSON result line.

import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, mkdirSync, openSync, renameSync, rmdirSync, statSync, unlinkSync } from "node:fs";

type Op =
  | { op: "mkdir"; name: string; mode: number }
  | { op: "rename"; from: string; to: string }
  | { op: "unlink"; name: string }
  | { op: "rmdir"; name: string }
  // Run a program in the verified directory: the child inherits this process's
  // working directory (no path is re-resolved). Used for controlled Git.
  | { op: "spawn"; file: string; argv: string[]; env: Record<string, string>; input?: string };

const O_NOFOLLOW_ANY = 0x20000000;

function out(result: Record<string, unknown>, code: number): never {
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(code);
}

function simple(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");
}

const [dev, ino, dirPath, opsText] = process.argv.slice(2);
if (!dev || !ino || !dirPath || !opsText) out({ ok: false, code: "usage" }, 2);
let ops: Op[];
try {
  ops = JSON.parse(opsText) as Op[];
} catch {
  out({ ok: false, code: "usage" }, 2);
}
const here = statSync(".", { bigint: true });
if (String(here.dev) !== dev || String(here.ino) !== ino) out({ ok: false, code: "substituted" }, 3);

const created: string[] = [];
const done: number[] = [];
const outputs: Array<{ status: number | null; stdout: string; stderr: string }> = [];
for (const [index, op] of ops.entries()) {
  try {
    switch (op.op) {
      case "mkdir":
        if (!simple(op.name)) out({ ok: false, code: "invalid-name", done }, 2);
        mkdirSync(op.name, { mode: op.mode });
        created.push(op.name);
        break;
      case "rename":
        if (!simple(op.from) || !simple(op.to)) out({ ok: false, code: "invalid-name", done }, 2);
        renameSync(op.from, op.to);
        break;
      case "unlink":
        if (!simple(op.name)) out({ ok: false, code: "invalid-name", done }, 2);
        unlinkSync(op.name);
        break;
      case "rmdir":
        if (!simple(op.name)) out({ ok: false, code: "invalid-name", done }, 2);
        rmdirSync(op.name);
        break;
      case "spawn": {
        const result = spawnSync(op.file, op.argv, { env: op.env, input: op.input ?? "", encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
        outputs.push({ status: result.status, stdout: (result.stdout ?? "").slice(0, 1024 * 1024), stderr: (result.stderr ?? "").slice(0, 16 * 1024) });
        if (result.status !== 0) out({ ok: false, code: "spawn-failed", index, done, outputs }, 4);
        break;
      }
      default:
        out({ ok: false, code: "invalid-op", done }, 2);
    }
    done.push(index);
  } catch (error) {
    out({ ok: false, code: "op-failed", errno: (error as NodeJS.ErrnoException).code ?? "unknown", index, done }, 4);
  }
}

// The directory must still be at its path, without links, after the operations.
let stillThere = false;
try {
  const fd = openSync(dirPath, constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY);
  try {
    const st = fstatSync(fd, { bigint: true });
    stillThere = String(st.dev) === dev && String(st.ino) === ino;
  } finally {
    closeSync(fd);
  }
} catch {
  stillThere = false;
}
if (!stillThere) {
  for (const name of created.reverse()) {
    try {
      rmdirSync(name);
    } catch {
      // Not empty or already gone: reported below; never removed recursively.
    }
  }
  out({ ok: false, code: "moved", done }, 5);
}
out({ ok: true, done, outputs }, 0);
