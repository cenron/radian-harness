// Result inbox. Workers write their result envelope into their own exchange
// directory; the coordinator reads it without following links, validates it
// through the run store, persists the accepted copy in protected run state, and
// only then reports it for notification. The exchange file is never trusted as
// state and is not deleted by the coordinator.

import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { AssignmentIdentity } from "../contracts/identity.ts";
import type { WorkerResult } from "../contracts/result.ts";
import { hashJson } from "../util/canonical.ts";
import { atomicWriteJson, readJsonIfExists } from "./fsutil.ts";
import type { RunStore } from "./run-store.ts";

export const RESULT_FILE = "result.json";
const MAX_RESULT_BYTES = 1024 * 1024;

export interface CollectedResult {
  result: WorkerResult;
  hash: string;
  /** True when this exact result was already accepted earlier (duplicate delivery). */
  duplicate: boolean;
}

export function readExchangeResult(exchangeDir: string): Outcome<unknown> {
  const file = path.join(exchangeDir, RESULT_FILE);
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return refuse("RESULT_INVALID", "no result file has been delivered");
  }
  if (!stat.isFile()) return refuse("RESULT_INVALID", "result must be a regular file (links are not followed)");
  if (stat.size > MAX_RESULT_BYTES) return refuse("RESULT_INVALID", "result file is too large");
  try {
    return success(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch {
    return refuse("RESULT_INVALID", "result file is not valid JSON");
  }
}

/**
 * Workers often report their own files by absolute path. Paths inside the
 * worker's worktree are made relative; anything else is left unchanged, so the
 * result validator still refuses paths outside the assignment.
 */
export function normalizeResultPaths(raw: unknown, worktree: string): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const prefix = worktree.endsWith("/") ? worktree : `${worktree}/`;
  const fix = (p: unknown) => (typeof p === "string" && p.startsWith(prefix) && p.length > prefix.length ? p.slice(prefix.length) : p);
  const out = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(out.deliverables)) out.deliverables = out.deliverables.map((d) => (d && typeof d === "object" ? { ...(d as Record<string, unknown>), path: fix((d as { path?: unknown }).path) } : d));
  const candidate = out.candidate as { patch?: { path?: unknown } } | undefined;
  if (candidate && typeof candidate === "object" && candidate.patch && typeof candidate.patch === "object") out.candidate = { ...candidate, patch: { ...candidate.patch, path: fix(candidate.patch.path) } };
  return out;
}

export async function collectResult(store: RunStore, exchangeDir: string, expected: { identity: AssignmentIdentity; briefHash: string }, worktree?: string): Promise<Outcome<CollectedResult>> {
  const read = readExchangeResult(exchangeDir);
  if (!read.ok) return read;
  const raw = { ...read, value: worktree ? normalizeResultPaths(read.value, worktree) : read.value };
  const hash = hashJson(raw.value);
  const duplicate = store.state.results[hash]?.accepted === true;
  const recorded = await store.recordResult(raw.value, expected);
  if (!recorded.ok) return recorded;
  const persisted = path.join(store.runDir, "results", `${hash.slice("sha256:".length)}.json`);
  if (readJsonIfExists(persisted).state !== "ok") atomicWriteJson(persisted, raw.value);
  return success({ result: recorded.value, hash, duplicate });
}
