import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function hashString(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashObject(obj: unknown): string {
  return hashString(JSON.stringify(sortObjectKeys(obj)));
}

export function readHashFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch {
    return null;
  }
}

export function writeHashFile(filePath: string, hash: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, hash);
}

export function allFilesExist(paths: string[]): boolean {
  return paths.every((path) => existsSync(path));
}

export function allDirsExist(paths: string[]): boolean {
  return paths.every((path) => existsSync(path) && statSync(path).isDirectory());
}

export function dirExistsAndNonEmpty(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false;
  try {
    return readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortObjectKeys(item));
  }

  if (value && typeof value === "object") {
    const sortedEntries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortObjectKeys(child)]);
    return Object.fromEntries(sortedEntries);
  }

  return value;
}
