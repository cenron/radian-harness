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

export async function collectResult(store: RunStore, exchangeDir: string, expected: { identity: AssignmentIdentity; briefHash: string }): Promise<Outcome<CollectedResult>> {
  const raw = readExchangeResult(exchangeDir);
  if (!raw.ok) return raw;
  const hash = hashJson(raw.value);
  const duplicate = store.state.results[hash]?.accepted === true;
  const recorded = await store.recordResult(raw.value, expected);
  if (!recorded.ok) return recorded;
  const persisted = path.join(store.runDir, "results", `${hash.slice("sha256:".length)}.json`);
  if (readJsonIfExists(persisted).state !== "ok") atomicWriteJson(persisted, raw.value);
  return success({ result: recorded.value, hash, duplicate });
}
