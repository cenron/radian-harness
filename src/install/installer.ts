import fs from "node:fs";
import path from "node:path";
import { RadianError } from "../core/errors.ts";

export type InstallOperation = "install" | "update" | "remove";

/** A whole-file change. `undefined` content means the file is absent. */
export interface FileChange {
  path: string;
  description: string;
  before: string | undefined;
  after: string | undefined;
}

export interface InstallPlan {
  operation: InstallOperation;
  workspace: string;
  changes: FileChange[];
}

export interface InstallManifest {
  version: 1;
  harness: string;
  packageEntry: string;
  createdSettingsFile: boolean;
}

export interface InstallStatus {
  workspace: string;
  isInstalled: boolean;
  harness: string | undefined;
  packageEntry: string | undefined;
  hasPackageEntry: boolean;
  hasHarness: boolean;
  hasWorkspaceFile: boolean;
}

type Settings = Record<string, unknown>;

export function planInstall(options: { workspace: string; harness: string }): InstallPlan {
  const workspace = requireWorkspace(options.workspace);
  const harness = requireHarness(options.harness);
  if (fs.existsSync(workspaceFiles(workspace).manifest)) {
    throw new RadianError(
      "already_installed",
      `Radian is already installed in ${workspace}; run update instead.`,
    );
  }
  const packageEntry = packageEntryFor(workspace, harness);
  const settingsFile = readSettingsFile(workspace);
  const packages = readPackages(settingsFile.settings);
  const nextPackages = packages.includes(packageEntry) ? packages : [...packages, packageEntry];
  return buildPlan("install", workspace, [
    settingsChange(settingsFile, nextPackages, "add Radian package entry"),
    workspaceFileChange(workspace),
    manifestChange(workspace, {
      version: 1,
      harness,
      packageEntry,
      createdSettingsFile: settingsFile.text === undefined,
    }),
  ]);
}

export function planUpdate(options: { workspace: string; harness?: string }): InstallPlan {
  const workspace = requireWorkspace(options.workspace);
  const manifest = requireManifest(workspace);
  const harness = requireHarness(options.harness ?? manifest.harness);
  const packageEntry = packageEntryFor(workspace, harness);
  const settingsFile = readSettingsFile(workspace);
  const packages = readPackages(settingsFile.settings);
  const isEntryPresent = packages.includes(manifest.packageEntry);
  const nextPackages = isEntryPresent
    ? replaceEntry(packages, manifest.packageEntry, packageEntry)
    : [...packages, packageEntry];
  const description = isEntryPresent
    ? `point Radian package entry at ${packageEntry}`
    : "re-add Radian package entry (it had been removed from settings)";
  return buildPlan("update", workspace, [
    settingsChange(settingsFile, nextPackages, description),
    workspaceFileChange(workspace),
    manifestChange(workspace, {
      version: 1,
      harness,
      packageEntry,
      createdSettingsFile: manifest.createdSettingsFile || settingsFile.text === undefined,
    }),
  ]);
}

export function planRemove(options: { workspace: string }): InstallPlan {
  const workspace = requireWorkspace(options.workspace);
  const manifest = requireManifest(workspace);
  const manifestFile = workspaceFiles(workspace).manifest;
  return buildPlan("remove", workspace, [
    removeEntryChange(readSettingsFile(workspace), manifest),
    {
      path: manifestFile,
      description: "delete install manifest",
      before: readOptionalFile(manifestFile),
      after: undefined,
    },
  ]);
}

/** Writes the plan only if every file still matches what the preview showed. */
export function applyPlan(plan: InstallPlan): void {
  for (const change of plan.changes) {
    if (readOptionalFile(change.path) !== change.before) {
      throw new RadianError(
        "stale_preview",
        `${change.path} changed since the preview; run the command again.`,
      );
    }
  }
  for (const change of plan.changes) writeOrDelete(change.path, change.after);
}

export function readInstallStatus(workspace: string): InstallStatus {
  const absolute = path.resolve(workspace);
  const resolved = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
  const files = workspaceFiles(resolved);
  const hasWorkspaceFile = fs.existsSync(files.workspaceRecord);
  if (!fs.existsSync(files.manifest)) {
    return {
      workspace: resolved,
      isInstalled: false,
      harness: undefined,
      packageEntry: undefined,
      hasPackageEntry: false,
      hasHarness: false,
      hasWorkspaceFile,
    };
  }
  const manifest = requireManifest(resolved);
  const packages = readPackages(readSettingsFile(resolved).settings);
  return {
    workspace: resolved,
    isInstalled: true,
    harness: manifest.harness,
    packageEntry: manifest.packageEntry,
    hasPackageEntry: packages.includes(manifest.packageEntry),
    hasHarness: fs.existsSync(manifest.harness),
    hasWorkspaceFile,
  };
}

function workspaceFiles(workspace: string) {
  return {
    settings: path.join(workspace, ".pi", "settings.json"),
    workspaceRecord: path.join(workspace, ".radian", "workspace.json"),
    manifest: path.join(workspace, ".radian", "install-manifest.json"),
  };
}

function requireWorkspace(workspace: string): string {
  const resolved = path.resolve(workspace);
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
    throw new RadianError("invalid_workspace", `${resolved} is not an existing directory.`);
  }
  return fs.realpathSync(resolved);
}

function requireHarness(harness: string): string {
  const resolved = path.resolve(harness);
  const packageText = readOptionalFile(path.join(resolved, "package.json"));
  const packageJson = packageText === undefined ? undefined : parseJson(packageText);
  if (!isObject(packageJson) || packageJson.name !== "radian-harness" || !packageJson.pi) {
    throw new RadianError("invalid_harness", `${resolved} is not a Radian harness checkout.`);
  }
  return fs.realpathSync(resolved);
}

function requireManifest(workspace: string): InstallManifest {
  const manifestFile = workspaceFiles(workspace).manifest;
  const text = readOptionalFile(manifestFile);
  if (text === undefined) {
    throw new RadianError(
      "not_installed",
      `Radian is not installed in ${workspace}; run install first.`,
    );
  }
  const manifest = parseJson(text);
  if (!isManifest(manifest)) {
    throw new RadianError("invalid_manifest", `${manifestFile} is not a valid install manifest.`);
  }
  return manifest;
}

function isManifest(value: unknown): value is InstallManifest {
  return (
    isObject(value) &&
    value.version === 1 &&
    typeof value.harness === "string" &&
    typeof value.packageEntry === "string" &&
    typeof value.createdSettingsFile === "boolean"
  );
}

/** Pi resolves package paths relative to the settings file's directory. */
function packageEntryFor(workspace: string, harness: string): string {
  const relative = path.relative(path.join(workspace, ".pi"), harness) || ".";
  return relative.startsWith(".") ? relative : `./${relative}`;
}

interface SettingsFile {
  path: string;
  text: string | undefined;
  settings: Settings;
}

function readSettingsFile(workspace: string): SettingsFile {
  const settingsPath = workspaceFiles(workspace).settings;
  const text = readOptionalFile(settingsPath);
  if (text === undefined) return { path: settingsPath, text, settings: {} };
  const settings = parseJson(text);
  if (!isObject(settings)) {
    throw new RadianError(
      "invalid_settings",
      `${settingsPath} is not a JSON object; left untouched.`,
    );
  }
  return { path: settingsPath, text, settings };
}

function readPackages(settings: Settings): unknown[] {
  if (settings.packages === undefined) return [];
  if (!Array.isArray(settings.packages)) {
    throw new RadianError(
      "invalid_settings",
      "The packages setting is not an array; left untouched.",
    );
  }
  return settings.packages;
}

function replaceEntry(packages: unknown[], oldEntry: string, newEntry: string): unknown[] {
  const withoutNew = packages.filter((entry) => entry !== newEntry || entry === oldEntry);
  return withoutNew.map((entry) => (entry === oldEntry ? newEntry : entry));
}

/** Leaves the file byte-for-byte alone when its packages already match. */
function settingsChange(file: SettingsFile, packages: unknown[], description: string): FileChange {
  const isUnchanged =
    file.text !== undefined &&
    JSON.stringify(readPackages(file.settings)) === JSON.stringify(packages);
  return {
    path: file.path,
    description: `${description} (other settings preserved)`,
    before: file.text,
    after: isUnchanged ? file.text : toJsonText({ ...file.settings, packages }),
  };
}

function removeEntryChange(file: SettingsFile, manifest: InstallManifest): FileChange {
  const { packages: _packages, ...otherSettings } = file.settings;
  const packages = readPackages(file.settings);
  const remaining = packages.filter((entry) => entry !== manifest.packageEntry);
  const settings = remaining.length > 0 ? { ...otherSettings, packages: remaining } : otherSettings;
  // Checked even when the entry is already gone: the user may have removed it by hand,
  // leaving the file Radian created as `{}`.
  const isEmptyOwnedFile =
    file.text !== undefined && manifest.createdSettingsFile && Object.keys(settings).length === 0;
  if (isEmptyOwnedFile) {
    return {
      path: file.path,
      description: "delete (Radian created it and it is now empty; an empty .pi/ folder goes too)",
      before: file.text,
      after: undefined,
    };
  }
  if (remaining.length === packages.length) {
    return { path: file.path, description: "", before: file.text, after: file.text };
  }
  return {
    path: file.path,
    description: "remove Radian package entry (other settings preserved)",
    before: file.text,
    after: toJsonText(settings),
  };
}

function workspaceFileChange(workspace: string): FileChange {
  const recordPath = workspaceFiles(workspace).workspaceRecord;
  const text = readOptionalFile(recordPath);
  return {
    path: recordPath,
    description: "create workspace record",
    before: text,
    after: text ?? toJsonText({ version: 1 }),
  };
}

function manifestChange(workspace: string, manifest: InstallManifest): FileChange {
  const manifestFile = workspaceFiles(workspace).manifest;
  return {
    path: manifestFile,
    description: "write install manifest",
    before: readOptionalFile(manifestFile),
    after: toJsonText(manifest),
  };
}

function buildPlan(
  operation: InstallOperation,
  workspace: string,
  changes: FileChange[],
): InstallPlan {
  return {
    operation,
    workspace,
    changes: changes.filter((change) => change.before !== change.after),
  };
}

function writeOrDelete(file: string, content: string | undefined): void {
  if (content === undefined) {
    fs.rmSync(file, { force: true });
    removeFolderIfEmpty(path.dirname(file));
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A folder left empty by deleting Radian's file was only there for that file. */
function removeFolderIfEmpty(folder: string): void {
  if (fs.existsSync(folder) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
}

function readOptionalFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
