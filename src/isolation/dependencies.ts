// Narrow executable dependency resolution for contained launches. Resolves the
// executable's real path, script interpreters, and Mach-O dynamic libraries
// (including @rpath/@loader_path) into explicit read grants. Anything that
// cannot be resolved is reported as missing; the caller blocks rather than
// widening access to a whole home or package-manager tree.

import { existsSync, openSync, readSync, closeSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { run, succeeded } from "../util/proc.ts";
import type { DependencyAccess } from "./profile.ts";

export interface ResolvedDependencies extends DependencyAccess {
  executable: string;
  missing: string[];
}

const OTOOL = "/usr/bin/otool";
const SYSTEM_PREFIXES = ["/usr/lib/", "/System/"];

function readHead(file: string, bytes: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const n = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export function shebangInterpreter(file: string): string | undefined {
  const head = readHead(file, 256).toString("utf8");
  if (!head.startsWith("#!")) return undefined;
  const line = head.slice(2).split("\n")[0]!.trim();
  const [interpreter, arg] = line.split(/\s+/);
  if (interpreter === "/usr/bin/env" && arg) return arg.startsWith("/") ? arg : undefined;
  return interpreter;
}

function isMachO(file: string): boolean {
  const magic = readHead(file, 4).readUInt32BE(0);
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
}

async function otool(flag: string, file: string): Promise<string | undefined> {
  const result = await run(OTOOL, [flag, file], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeoutMs: 20_000 });
  return succeeded(result) ? result.stdout.toString("utf8") : undefined;
}

export function parseLoadCommands(output: string): { libraries: string[] } {
  return {
    libraries: output
      .split("\n")
      .slice(1)
      .map((l) => l.trim().replace(/\s+\(compatibility version.*$/, ""))
      .filter((l) => l.length > 0),
  };
}

export function parseRpaths(output: string): string[] {
  const out: string[] = [];
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "cmd LC_RPATH") {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
        const m = /^\s*path (.+?) \(offset \d+\)/.exec(lines[j]!);
        if (m?.[1]) out.push(m[1]);
      }
    }
  }
  return out;
}

function expand(reference: string, loaderDir: string, executableDir: string, rpaths: readonly string[]): string[] {
  if (reference.startsWith("@loader_path/")) return [path.join(loaderDir, reference.slice("@loader_path/".length))];
  if (reference.startsWith("@executable_path/")) return [path.join(executableDir, reference.slice("@executable_path/".length))];
  if (reference.startsWith("@rpath/")) {
    const rest = reference.slice("@rpath/".length);
    return rpaths.map((r) => path.join(expand(r, loaderDir, executableDir, [])[0] ?? r, rest));
  }
  return [reference];
}

/** Resolve an executable's read dependencies. `extraRoots` are adapter-declared install roots. */
export async function resolveDependencies(executable: string, extraRoots: readonly string[] = []): Promise<ResolvedDependencies> {
  const missing: string[] = [];
  const files = new Set<string>();
  const roots = new Set<string>(extraRoots);
  let real: string;
  try {
    real = realpathSync(executable);
  } catch {
    return { executable, readRoots: [], readFiles: [], missing: [executable] };
  }
  const queue: Array<{ file: string; executableDir: string; inheritedRpaths: string[] }> = [{ file: real, executableDir: path.dirname(real), inheritedRpaths: [] }];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { file, executableDir, inheritedRpaths } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (SYSTEM_PREFIXES.some((prefix) => file.startsWith(prefix))) continue; // system roots / shared cache
    if (!existsSync(file)) {
      missing.push(file);
      continue;
    }
    files.add(file);
    if (!statSync(file).isFile()) continue;
    const interpreter = shebangInterpreter(file);
    if (interpreter) {
      try {
        queue.push({ file: realpathSync(interpreter), executableDir, inheritedRpaths: [] });
      } catch {
        missing.push(interpreter);
      }
      continue;
    }
    if (!isMachO(file)) continue;
    if (!existsSync(OTOOL)) {
      missing.push(`${OTOOL} (needed to resolve dynamic libraries)`);
      continue;
    }
    const loads = await otool("-L", file);
    const commands = await otool("-l", file);
    if (loads === undefined || commands === undefined) {
      missing.push(file);
      continue;
    }
    const rpaths = [...parseRpaths(commands), ...inheritedRpaths];
    for (const reference of parseLoadCommands(loads).libraries) {
      if (SYSTEM_PREFIXES.some((prefix) => reference.startsWith(prefix))) continue;
      const candidates = expand(reference, path.dirname(file), executableDir, rpaths);
      const found = candidates.find((candidate) => existsSync(candidate));
      if (!found) {
        missing.push(reference);
        continue;
      }
      queue.push({ file: realpathSync(found), executableDir, inheritedRpaths: rpaths });
    }
  }
  // OpenSSL-linked interpreters read their configuration at startup. Grant only
  // the configuration and certificate store, never the OPENSSLDIR private/ tree.
  for (const lib of [...files]) {
    if (!/libcrypto\.\d+\.dylib$/.test(lib)) continue;
    const config = await opensslConfig(lib);
    if (!config) {
      missing.push(`OpenSSL configuration for ${path.basename(lib)}`);
      continue;
    }
    for (const name of ["openssl.cnf", "cert.pem", "ct_log_list.cnf"]) {
      const candidate = path.join(config, name);
      if (existsSync(candidate)) files.add(realpathSync(candidate));
    }
    if (existsSync(path.join(config, "certs"))) roots.add(realpathSync(path.join(config, "certs")));
  }
  return { executable: real, readRoots: [...roots].sort(), readFiles: [...files].sort(), missing };
}

/** OPENSSLDIR reported by the openssl tool installed beside a libcrypto, if any. */
async function opensslConfig(libcrypto: string): Promise<string | undefined> {
  const tool = path.join(path.dirname(path.dirname(libcrypto)), "bin", "openssl");
  if (!existsSync(tool)) return undefined;
  const result = await run(tool, ["version", "-d"], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeoutMs: 10_000 });
  if (!succeeded(result)) return undefined;
  const match = /OPENSSLDIR:\s*"([^"]+)"/.exec(result.stdout.toString("utf8"));
  if (!match?.[1] || !existsSync(match[1])) return undefined;
  return realpathSync(match[1]);
}
