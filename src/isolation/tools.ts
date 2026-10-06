// User-approved worker tools (`execution.workerTools`). Each configured
// executable is exposed to a contained worker and its checks under its
// configured name, through a per-attempt directory of links placed first on
// PATH. Read access is limited to the resolved binary (or the whole .app
// bundle it lives in, which macOS applications need) plus its resolved
// library dependencies. Nothing else next to the configured path becomes
// reachable. Any invalid entry refuses the launch rather than widening access.

import { accessSync, constants, mkdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { resolveDependencies } from "./dependencies.ts";

export interface WorkerTools {
  /** Directory of links, one per tool, to put first on PATH. */
  binDir: string;
  /** Names exposed on PATH, in configuration order. */
  names: string[];
  readRoots: string[];
  readFiles: string[];
}

const NAME = /^[A-Za-z0-9._+-]{1,64}$/;

/** The enclosing `.app` bundle of an executable, if any. */
function appBundle(file: string): string | undefined {
  const index = file.indexOf(".app/");
  return index >= 0 ? file.slice(0, index + 4) : undefined;
}

export async function resolveWorkerTools(configured: readonly string[], binDir: string): Promise<Outcome<WorkerTools>> {
  const out: WorkerTools = { binDir, names: [], readRoots: [], readFiles: [] };
  if (configured.length === 0) return success(out);
  const missing = (entry: string, why: string) => refuse("CAPABILITY_MISSING", `approved worker tool ${JSON.stringify(entry)} ${why}`, "Fix execution.workerTools in the Radian config; Radian does not guess tool locations.");
  const links: Array<{ name: string; target: string }> = [];
  for (const entry of configured) {
    if (!path.isAbsolute(entry)) return missing(entry, "must be an absolute path");
    const name = path.basename(entry);
    if (!NAME.test(name)) return missing(entry, "has an unsupported name");
    if (out.names.includes(name)) return missing(entry, "duplicates another tool name");
    let real: string;
    try {
      real = realpathSync(entry);
      if (!statSync(real).isFile()) return missing(entry, "is not a file");
      accessSync(real, constants.X_OK);
    } catch {
      return missing(entry, "is not an existing executable");
    }
    const bundle = appBundle(real);
    const deps = await resolveDependencies(real, bundle ? [bundle] : []);
    if (deps.missing.length > 0) return missing(entry, "has dependencies that could not be resolved narrowly");
    out.names.push(name);
    if (bundle) out.readRoots.push(bundle);
    out.readRoots.push(...deps.readRoots);
    out.readFiles.push(real, ...deps.readFiles);
    links.push({ name, target: real });
  }
  rmSync(binDir, { recursive: true, force: true });
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  for (const link of links) symlinkSync(link.target, path.join(binDir, link.name));
  out.readRoots = [...new Set(out.readRoots)];
  out.readFiles = [...new Set(out.readFiles)];
  return success(out);
}
