/**
 * Filesystem read utilities — centralized JSON read with guards.
 *
 * Replaces 22+ inline `existsSync + try { JSON.parse(readFileSync(...)) }` patterns.
 */
import { existsSync, readFileSync } from "node:fs";

/**
 * Read and parse a JSON file, returning `undefined` if the file
 * is missing or the content is not valid JSON.
 */
export function readJsonSafe<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Read and parse a JSON file, returning `fallback` if the file
 * is missing or the content is not valid JSON.
 */
export function readJsonOr<T>(path: string, fallback: T): T {
  return readJsonSafe<T>(path) ?? fallback;
}
