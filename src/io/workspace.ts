import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { RadianError } from "../core/errors.ts";
import { parseMode, type Mode } from "../core/roles.ts";
import { assertProjectName } from "../core/worker.ts";
import { branchExists, initRepository, isRepository, runGit } from "./git.ts";
import { readJsonFile, writeJsonFile } from "./json-file.ts";

export interface Project {
  name: string;
  path: string;
  /** Branch name (without refs/heads/) that worker branches merge into. */
  target: string;
}

interface Registry {
  version: 1;
  projects: Project[];
}

/** Radian runs only where the installer created `.radian/workspace.json`. */
export function isWorkspaceRoot(directory: string): boolean {
  return existsSync(path.join(directory, ".radian", "workspace.json"));
}

export function projectPaths(workspaceRoot: string, project: string) {
  const stateDir = path.join(workspaceRoot, ".radian", "projects", project);
  const workersDir = path.join(stateDir, "workers");
  const worktreesDir = path.join(stateDir, "worktrees");
  return {
    stateDir,
    workersDir,
    worktreesDir,
    workersFile: path.join(stateDir, "workers.json"),
    modeFile: path.join(stateDir, "mode.json"),
    sessionFile: path.join(stateDir, "session.json"),
    workerDir: (worker: string) => path.join(workersDir, worker),
    worktree: (worker: string) => path.join(worktreesDir, worker),
  };
}

export function listProjects(workspaceRoot: string): Project[] {
  return readRegistry(workspaceRoot).projects;
}

export function getProject(workspaceRoot: string, name: string): Project {
  const project = listProjects(workspaceRoot).find((candidate) => candidate.name === name);
  if (!project)
    throw new RadianError(
      "unknown_project",
      `No project named "${name}". Run /projects to list them.`,
    );
  return project;
}

export async function createProject(
  workspaceRoot: string,
  input: { name: string; branch: string },
): Promise<Project> {
  assertProjectName(input.name);
  assertNameFree(workspaceRoot, input.name);
  const directory = path.join(workspaceRoot, input.name);
  if (existsSync(directory)) {
    throw new RadianError(
      "project_exists",
      `${directory} already exists. Use /projects add to register it.`,
    );
  }
  mkdirSync(directory);
  await initRepository(directory, input.branch);
  return register(workspaceRoot, { name: input.name, path: directory, target: input.branch });
}

export async function addProject(
  workspaceRoot: string,
  input: { path: string; target: string },
): Promise<Project> {
  const directory = realpathSync(path.resolve(workspaceRoot, input.path));
  if (!(await isRepository(directory)))
    throw new RadianError("not_repository", `${directory} is not a git repository.`);
  const target = input.target.replace(/^refs\/heads\//, "");
  if (!(await branchExists(directory, target))) {
    throw new RadianError("unknown_branch", `${directory} has no branch ${target}.`);
  }
  const name = path.basename(directory).toLowerCase();
  assertProjectName(name);
  assertNameFree(workspaceRoot, name);
  return register(workspaceRoot, { name, path: directory, target });
}

/** Callers check for live workers and confirm with the user first. */
export async function deleteProject(
  workspaceRoot: string,
  input: { name: string; shouldDeleteFiles: boolean },
): Promise<void> {
  const project = getProject(workspaceRoot, input.name);
  rmSync(projectPaths(workspaceRoot, project.name).stateDir, { recursive: true, force: true });
  if (input.shouldDeleteFiles) {
    rmSync(project.path, { recursive: true, force: true });
  } else if (existsSync(project.path)) {
    await runGit(project.path, ["worktree", "prune"]);
  }
  const registry = readRegistry(workspaceRoot);
  const projects = registry.projects.filter((candidate) => candidate.name !== project.name);
  writeJsonFile(registryFile(workspaceRoot), { ...registry, projects });
}

export function readMode(workspaceRoot: string, project: string, startMode: Mode): Mode {
  const stored = readJsonFile<{ mode?: string }>(projectPaths(workspaceRoot, project).modeFile, {});
  return stored.mode ? parseMode(stored.mode) : startMode;
}

export function writeMode(workspaceRoot: string, project: string, mode: Mode): void {
  writeJsonFile(projectPaths(workspaceRoot, project).modeFile, { mode });
}

async function register(workspaceRoot: string, project: Project): Promise<Project> {
  await excludeRadianFolder(project.path);
  const registry = readRegistry(workspaceRoot);
  writeJsonFile(registryFile(workspaceRoot), {
    ...registry,
    projects: [...registry.projects, project],
  });
  return project;
}

// Planning docs live in the project's .radian/ folder. Excluding it locally keeps
// the checkout clean for merges without changing the project's own .gitignore.
async function excludeRadianFolder(projectPath: string): Promise<void> {
  const relative = (await runGit(projectPath, ["rev-parse", "--git-path", "info/exclude"])).trim();
  const excludeFile = path.resolve(projectPath, relative);
  const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
  if (/^\.radian\/$/m.test(current)) return;
  mkdirSync(path.dirname(excludeFile), { recursive: true });
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(excludeFile, `${separator}.radian/\n`);
}

function assertNameFree(workspaceRoot: string, name: string): void {
  if (listProjects(workspaceRoot).some((project) => project.name === name)) {
    throw new RadianError("project_exists", `A project named "${name}" is already registered.`);
  }
}

function readRegistry(workspaceRoot: string): Registry {
  return readJsonFile<Registry>(registryFile(workspaceRoot), { version: 1, projects: [] });
}

function registryFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".radian", "projects.json");
}
