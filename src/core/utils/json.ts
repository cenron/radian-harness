import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RadianError } from "../errors.ts";
import { isNodeError } from "./errors.ts";

export type JsonObject = Record<string, unknown>;

/** Returns `fallback` when the file does not exist; invalid JSON is an error, never silently replaced. */
export function readJsonFile<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
    return JSON.parse(text) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return fallback;

    if (error instanceof SyntaxError) {
      throw new RadianError("invalid_json", `${file} is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}

/** Writes through a temporary file so a crash never leaves half a file behind. */
export function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });

  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

export function readJsonAsObject(file: string): JsonObject {
  return asObject(readJsonFile<unknown>(file, {}));
}

export function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
