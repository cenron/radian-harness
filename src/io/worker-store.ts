import { RadianError } from "../core/errors.ts";
import type { WorkerRecord } from "../core/worker.ts";
import { readJsonFile, writeJsonFile } from "./json-file.ts";

interface WorkerFile {
  version: 1;
  workers: WorkerRecord[];
}

export function listWorkers(workersFile: string): WorkerRecord[] {
  return readJsonFile<WorkerFile>(workersFile, { version: 1, workers: [] }).workers;
}

export function findWorker(workersFile: string, name: string): WorkerRecord {
  const worker = listWorkers(workersFile).find((candidate) => candidate.name === name);
  if (!worker)
    throw new RadianError(
      "unknown_worker",
      `No worker named "${name}". Run /radian workers to list them.`,
    );
  return worker;
}

export function saveWorker(workersFile: string, worker: WorkerRecord): void {
  const workers = listWorkers(workersFile);
  const index = workers.findIndex((candidate) => candidate.name === worker.name);
  if (index === -1) workers.push(worker);
  else workers[index] = worker;
  writeJsonFile(workersFile, { version: 1, workers });
}

export function removeWorker(workersFile: string, name: string): void {
  const workers = listWorkers(workersFile).filter((candidate) => candidate.name !== name);
  writeJsonFile(workersFile, { version: 1, workers });
}
