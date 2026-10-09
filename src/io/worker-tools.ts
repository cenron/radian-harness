import path from "node:path";
import { readJsonFile, writeJsonFile } from "#core/utils/json.ts";

interface WorkerToolsFile {
  version: 1;
  tools: string[];
}

/** Extra tools the user approved for this project's workers, kept in the project's .radian folder. */
export function readWorkerTools(projectPath: string): string[] {
  return readJsonFile<WorkerToolsFile>(toolsFile(projectPath), { version: 1, tools: [] }).tools;
}

export function addWorkerTool(projectPath: string, tool: string): void {
  const tools = readWorkerTools(projectPath);
  if (tools.includes(tool)) return;
  writeJsonFile(toolsFile(projectPath), { version: 1, tools: [...tools, tool] });
}

export function removeWorkerTool(projectPath: string, tool: string): void {
  const tools = readWorkerTools(projectPath).filter((candidate) => candidate !== tool);
  writeJsonFile(toolsFile(projectPath), { version: 1, tools });
}

function toolsFile(projectPath: string): string {
  return path.join(projectPath, ".radian", "worker-tools.json");
}
