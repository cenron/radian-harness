// Canonical path handling. Containment checks use resolved real paths and
// path.relative, never substring or string-prefix matching. For paths that do
// not exist yet, the nearest existing ancestor is resolved so symlinked parents
// cannot escape a root.

import { realpathSync } from "node:fs";
import path from "node:path";
import { type Outcome, refuse, success } from "./blockers.ts";

export function isWithin(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

export function canonicalPath(input: string): Outcome<string> {
  if (input.includes("\0")) return refuse("PATH_INVALID", "path contains NUL");
  if (!path.isAbsolute(input)) return refuse("PATH_INVALID", "path must be absolute");
  let current = path.resolve(input);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return success(rest.length === 0 ? real : path.join(real, ...rest.reverse()));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return refuse("PATH_INVALID", "path cannot be resolved");
      const parent = path.dirname(current);
      if (parent === current) return refuse("PATH_INVALID", "no existing ancestor");
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

export function canonicalPaths(inputs: readonly string[]): Outcome<string[]> {
  const out: string[] = [];
  for (const input of inputs) {
    const c = canonicalPath(input);
    if (!c.ok) return c;
    out.push(c.value);
  }
  return success(dedupeRoots(out));
}

/** Remove roots already covered by another root. */
export function dedupeRoots(roots: readonly string[]): string[] {
  const sorted = [...new Set(roots)].sort((a, b) => a.length - b.length);
  const out: string[] = [];
  for (const root of sorted) if (!out.some((existing) => isWithin(root, existing))) out.push(root);
  return out.sort();
}

/** Resolve a (possibly relative) requested path against a base and require it inside one of the roots. */
export function resolveWithin(base: string, requested: string, roots: readonly string[]): Outcome<string> {
  if (requested.includes("\0")) return refuse("PATH_INVALID", "path contains NUL");
  const absolute = path.isAbsolute(requested) ? requested : path.resolve(base, requested);
  const canonical = canonicalPath(absolute);
  if (!canonical.ok) return canonical;
  if (!roots.some((root) => isWithin(canonical.value, root))) {
    return refuse("PATH_OUTSIDE_SCOPE", "path resolves outside the permitted roots", "Request a scope change through the coordinator.");
  }
  return success(canonical.value);
}

/** Intersection of two root sets: the narrower root wherever one contains the other. */
export function intersectRoots(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  for (const x of a) {
    for (const y of b) {
      if (isWithin(x, y)) out.push(x);
      else if (isWithin(y, x)) out.push(y);
    }
  }
  return dedupeRoots(out);
}

export function overlaps(a: string, b: string): boolean {
  return isWithin(a, b) || isWithin(b, a);
}

/** Repository-relative path validation for deliverables and patches (no absolute, no traversal). */
export function safeRelative(relative: string): boolean {
  if (relative === "" || relative.includes("\0") || path.isAbsolute(relative) || relative.includes("\\")) return false;
  const parts = relative.split("/");
  return !parts.some((part) => part === ".." || part === "" || part === ".");
}
