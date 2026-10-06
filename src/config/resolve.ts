// Deterministic configuration resolution with provenance:
//   shipped defaults → workspace overrides → project overrides
// followed, per assignment, by an explicit authorized profile selection
// (see dispatch.selectProfile). Objects merge by key, arrays and scalars
// replace. The effective result is validated after every merge and snapshotted
// per run with layer hashes, so later edits never silently change a run.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { formatIssues } from "../contracts/schema.ts";
import { canonicalJson, deepClone, deepFreeze, hashJson } from "../util/canonical.ts";
import { type DispatchConfig, dispatchConfigSchema, rawProhibitedFields } from "./dispatch.ts";
import { type HarnessConfig, harnessConfigSchema } from "./harness.ts";

export const CONFIG_FILES = ["harness.json", "dispatch.json"] as const;
export type ConfigFile = (typeof CONFIG_FILES)[number];
export const OVERRIDE_DIR = path.join(".radian", "config");
const MAX_CONFIG_BYTES = 256 * 1024;

export type LayerName = "shipped" | "workspace" | "project";

export interface ConfigLayer {
  layer: LayerName;
  /** Display label (relative, never an absolute personal path). */
  label: string;
  harness?: unknown;
  dispatch?: unknown;
}

export interface ConfigSnapshot {
  schema: "radian.config-snapshot/1";
  layers: Array<{ layer: LayerName; label: string; harnessHash: string | null; dispatchHash: string | null }>;
  harness: HarnessConfig;
  dispatch: DispatchConfig;
  /** Leaf key path → layer that last set it. */
  provenance: Record<string, LayerName>;
  hash: string;
}

export function shippedConfigDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "config");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeLayer(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      out[key] = key in base ? mergeLayer(base[key], value) : deepClone(value);
    }
    return out;
  }
  return deepClone(override);
}

function recordLeaves(value: unknown, prefix: string, layer: LayerName, into: Record<string, LayerName>): void {
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) recordLeaves(entry, prefix ? `${prefix}.${key}` : key, layer, into);
    return;
  }
  // Replacing a subtree supersedes provenance recorded for its former leaves.
  for (const existing of Object.keys(into)) if (existing.startsWith(prefix + ".")) delete into[existing];
  into[prefix] = layer;
}

/** Read one optional JSON override file; absence is not an error. */
export function readConfigFile(dir: string, file: ConfigFile, label: string): Outcome<unknown | undefined> {
  const full = path.join(dir, file);
  let size: number;
  try {
    const stat = statSync(full);
    if (!stat.isFile()) return refuse("CONFIG_INVALID", `${label}/${file} is not a regular file`);
    size = stat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return success(undefined);
    return refuse("CONFIG_INVALID", `${label}/${file} is unreadable`);
  }
  if (size > MAX_CONFIG_BYTES) return refuse("CONFIG_INVALID", `${label}/${file} is too large`);
  try {
    return success(JSON.parse(readFileSync(full, "utf8")) as unknown);
  } catch {
    return refuse("CONFIG_INVALID", `${label}/${file} is not valid JSON`);
  }
}

export function loadLayer(layer: LayerName, dir: string, label: string): Outcome<ConfigLayer> {
  const harness = readConfigFile(dir, "harness.json", label);
  if (!harness.ok) return harness;
  const dispatch = readConfigFile(dir, "dispatch.json", label);
  if (!dispatch.ok) return dispatch;
  const out: ConfigLayer = { layer, label };
  if (harness.value !== undefined) out.harness = harness.value;
  if (dispatch.value !== undefined) out.dispatch = dispatch.value;
  return success(out);
}

export function resolveConfig(layers: readonly ConfigLayer[]): Outcome<ConfigSnapshot> {
  if (layers.length === 0 || layers[0]?.layer !== "shipped") return refuse("CONFIG_INVALID", "shipped defaults must be the first layer");
  const order: LayerName[] = ["shipped", "workspace", "project"];
  let last = -1;
  for (const layer of layers) {
    const index = order.indexOf(layer.layer);
    if (index <= last) return refuse("CONFIG_INVALID", "configuration layers must be shipped → workspace → project, each at most once");
    last = index;
  }

  let harness: unknown = {};
  let dispatch: unknown = {};
  const provenance: Record<string, LayerName> = {};
  const summary: ConfigSnapshot["layers"] = [];
  for (const layer of layers) {
    for (const prohibited of rawProhibitedFields(layer.dispatch)) {
      return refuse("CUSTOM_ENDPOINT_PROHIBITED", `${layer.label} profile '${prohibited.profile}' sets custom endpoint/credential fields`, "Remove endpoint, key, proxy, and billing fields.", { fields: prohibited.fields.join(",") });
    }
    if (layer.harness !== undefined) {
      if (!isPlainObject(layer.harness)) return refuse("CONFIG_INVALID", `${layer.label}/harness.json must be an object`);
      harness = mergeLayer(harness, layer.harness);
      recordLeaves(layer.harness, "harness", layer.layer, provenance);
    }
    if (layer.dispatch !== undefined) {
      if (!isPlainObject(layer.dispatch)) return refuse("CONFIG_INVALID", `${layer.label}/dispatch.json must be an object`);
      dispatch = mergeLayer(dispatch, layer.dispatch);
      recordLeaves(layer.dispatch, "dispatch", layer.layer, provenance);
    }
    summary.push({
      layer: layer.layer,
      label: layer.label,
      harnessHash: layer.harness === undefined ? null : hashJson(layer.harness),
      dispatchHash: layer.dispatch === undefined ? null : hashJson(layer.dispatch),
    });
    // Validate after each merge so an invalid intermediate override is attributed to its layer.
    if (layer.layer !== "shipped" || layers.length === 1) {
      const h = harnessConfigSchema.parse(harness);
      if (!h.ok) return refuse("CONFIG_INVALID", `harness configuration invalid after ${layer.label}: ${formatIssues(h.issues)}`);
      const d = dispatchConfigSchema.parse(dispatch);
      if (!d.ok) return refuse("CONFIG_INVALID", `dispatch configuration invalid after ${layer.label}: ${formatIssues(d.issues)}`);
    }
  }
  const h = harnessConfigSchema.parse(harness);
  if (!h.ok) return refuse("CONFIG_INVALID", `harness configuration invalid: ${formatIssues(h.issues)}`);
  const d = dispatchConfigSchema.parse(dispatch);
  if (!d.ok) return refuse("CONFIG_INVALID", `dispatch configuration invalid: ${formatIssues(d.issues)}`);
  const body = { schema: "radian.config-snapshot/1" as const, layers: summary, harness: h.value, dispatch: d.value, provenance };
  return success(deepFreeze({ ...body, hash: hashJson(body) }));
}

export interface ResolveLocations {
  shippedDir?: string;
  workspaceRoot?: string;
  projectRoot?: string;
}

export function loadAndResolve(locations: ResolveLocations): Outcome<ConfigSnapshot> {
  const layers: ConfigLayer[] = [];
  const shipped = loadLayer("shipped", locations.shippedDir ?? shippedConfigDir(), "shipped config");
  if (!shipped.ok) return shipped;
  layers.push(shipped.value);
  if (locations.workspaceRoot) {
    const ws = loadLayer("workspace", path.join(locations.workspaceRoot, OVERRIDE_DIR), "workspace .radian/config");
    if (!ws.ok) return ws;
    layers.push(ws.value);
  }
  if (locations.projectRoot) {
    const project = loadLayer("project", path.join(locations.projectRoot, OVERRIDE_DIR), "project .radian/config");
    if (!project.ok) return project;
    layers.push(project.value);
  }
  return resolveConfig(layers);
}

/** True when two snapshots are byte-identical in effective content. */
export function sameEffectiveConfig(a: ConfigSnapshot, b: ConfigSnapshot): boolean {
  return canonicalJson({ h: a.harness, d: a.dispatch }) === canonicalJson({ h: b.harness, d: b.dispatch });
}
