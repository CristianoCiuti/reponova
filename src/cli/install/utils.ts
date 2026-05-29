import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  modify as modifyJsonc,
  applyEdits,
  type FormattingOptions,
} from "jsonc-parser";
import { DEFAULT_CONFIG_YAML } from "./content/default-config.js";

const JSONC_FMT: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
};

/**
 * Resolve a JSON config file path, preferring .jsonc over .json.
 * If a .jsonc variant exists it is returned; otherwise the .json path is
 * returned (whether it exists or not — callers create it when missing).
 */
export function resolveJsonConfigPath(dir: string, baseName: string): string {
  const jsoncPath = join(dir, `${baseName}.jsonc`);
  if (existsSync(jsoncPath)) return jsoncPath;
  return join(dir, `${baseName}.json`);
}

/** Read raw text from a JSON/JSONC file.  Returns `"{}"` when missing. */
export function readJsoncText(filePath: string): string {
  if (!existsSync(filePath)) return "{}";
  return readFileSync(filePath, "utf-8");
}

/**
 * Set a single property inside a JSON/JSONC text via `jsonc-parser`.
 * Comments and formatting in the rest of the document are preserved.
 */
export function setJsoncProperty(
  text: string,
  path: (string | number)[],
  value: unknown,
): string {
  const edits = modifyJsonc(text, path, value, {
    formattingOptions: JSONC_FMT,
  });
  return applyEdits(text, edits);
}

/** Ensure text ends with exactly one newline. */
export function withTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : text + "\n";
}

/** Create directory if it doesn't exist. */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Write config file into the editor directory if it doesn't already exist.
 */
export function writeConfigFile(editorDir: string): string | null {
  const configPath = join(editorDir, "reponova.yml");
  if (existsSync(configPath)) return null;
  ensureDir(editorDir);
  writeFileSync(configPath, DEFAULT_CONFIG_YAML);
  return configPath;
}

// ─── Test helpers (internal) ─────────────────────────────────────────────────

export const _testing = {
  resolveJsonConfigPath,
  readJsoncText,
  setJsoncProperty,
  withTrailingNewline,
};
