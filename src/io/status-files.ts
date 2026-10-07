import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseStatusLines, type StatusEntry } from "../core/status.ts";

export interface WorkerFiles {
  brief: string;
  status: string;
  report: string;
}

export function workerFiles(workerDir: string): WorkerFiles {
  return {
    brief: path.join(workerDir, "brief.md"),
    status: path.join(workerDir, "status"),
    report: path.join(workerDir, "report.md"),
  };
}

export function writeBrief(files: WorkerFiles, brief: string): void {
  mkdirSync(path.dirname(files.brief), { recursive: true });
  writeFileSync(files.brief, brief);
  writeFileSync(files.status, "", { flag: "a" });
}

export function readStatusEntries(statusFile: string): StatusEntry[] {
  return parseStatusLines(readOptionalText(statusFile) ?? "");
}

export function readReport(reportFile: string): string | undefined {
  return readOptionalText(reportFile);
}

function readOptionalText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
