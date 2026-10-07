import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RadianError } from "../core/errors.ts";

/** Returns `fallback` when the file does not exist; invalid JSON is an error, never silently replaced. */
export function readJsonFile<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new RadianError("invalid_json", `${file} is not valid JSON: ${(error as Error).message}`);
  }
}

/** Writes through a temporary file so a crash never leaves half a file behind. */
export function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}
