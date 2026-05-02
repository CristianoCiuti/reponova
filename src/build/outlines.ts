/**
 * Outline generation for the build pipeline.
 *
 * Walks configured repos, applies path filters, and generates
 * pre-computed .outline.json files using the outline module.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join, relative, dirname } from "node:path";
import { generateOutline, formatOutlineJson } from "../outline/index.js";
import { log } from "../shared/utils.js";
import type { Config } from "../shared/types.js";
import { hashFile } from "./incremental.js";

export interface OutlineOptions {
  force: boolean;
}

/**
 * Generate pre-computed outlines for all configured repos/patterns.
 * Called by both `build` (when outlines.enabled) and the standalone `outline` CLI command.
 */
export async function runOutlineGeneration(
  config: Config,
  configDir: string,
  outputDir: string,
  options: OutlineOptions,
): Promise<number> {
  const outlinesDir = join(outputDir, "outlines");
  if (!existsSync(outlinesDir)) mkdirSync(outlinesDir, { recursive: true });
  const previousHashes = loadOutlineHashes(outputDir);
  const nextHashes = new Map<string, string>();

  let count = 0;

  for (const repo of config.repos) {
    const repoPath = resolve(configDir, repo.path);
    if (!existsSync(repoPath)) {
      log.warn(`Repo path not found: ${repoPath}`);
      continue;
    }

    for (const pattern of config.outlines.paths) {
      const files = findFiles(repoPath, pattern, config.outlines.exclude);

      for (const file of files) {
        const relPath = `${repo.name}/${relative(repoPath, file)}`.split("\\").join("/");
        const outPath = join(outlinesDir, relPath + ".outline.json");
        const fileHash = hashFile(file);
        nextHashes.set(relPath, fileHash);

        if (!options.force && existsSync(outPath) && previousHashes.get(relPath) === fileHash) continue;

        try {
          const source = readFileSync(file, "utf-8");
          const outline = await generateOutline(relPath, source);
          if (!outline) continue;

          const outDir = dirname(outPath);
          if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
          writeFileSync(outPath, formatOutlineJson(outline));
          count++;
        } catch (error) {
          log.warn(`Failed to process ${file}: ${error}`);
        }
      }
    }
  }

  saveOutlineHashes(outputDir, nextHashes);

  return count;
}

export function loadOutlineHashes(outputDir: string): Map<string, string> {
  const hashesPath = join(outputDir, ".cache", "outline-hashes.json");
  if (!existsSync(hashesPath)) return new Map();

  try {
    const raw = JSON.parse(readFileSync(hashesPath, "utf-8")) as Record<string, string>;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

export function saveOutlineHashes(outputDir: string, hashes: Map<string, string>): void {
  const cacheDir = join(outputDir, ".cache");
  mkdirSync(cacheDir, { recursive: true });

  const serialized: Record<string, string> = {};
  for (const [filePath, hash] of hashes) {
    serialized[filePath] = hash;
  }

  writeFileSync(join(cacheDir, "outline-hashes.json"), JSON.stringify(serialized, null, 2));
}

// ─── File discovery (shared) ────────────────────────────────────────────────────

function findFiles(baseDir: string, pattern: string, exclude: string[]): string[] {
  const results: string[] = [];
  const ext = extractExtension(pattern);

  const prefixMatch = pattern.match(/^([^*]*?)(?:\/?\*\*)/);
  const prefixDir = prefixMatch?.[1] || "";
  const startDir = prefixDir ? join(baseDir, prefixDir) : baseDir;
  if (!existsSync(startDir)) return results;

  function walk(dir: string): void {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(baseDir, fullPath).split("\\").join("/");

      if (exclude.some((ex) => matchExclude(relPath, ex))) continue;

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && fullPath.endsWith(ext) && matchInclude(relPath, pattern)) {
        results.push(fullPath);
      }
    }
  }

  walk(startDir);
  return results;
}

function extractExtension(pattern: string): string {
  const match = pattern.match(/\*(\.\w+)$/);
  return match?.[1] ?? "";
}

function matchInclude(relPath: string, pattern: string): boolean {
  const prefixMatch = pattern.match(/^([^*]*?)(?:\/?\*\*)/);
  const prefix = prefixMatch?.[1] || "";
  const ext = extractExtension(pattern);
  if (prefix && !relPath.startsWith(prefix)) return false;
  if (ext && !relPath.endsWith(ext)) return false;
  return true;
}

function matchExclude(path: string, pattern: string): boolean {
  if (pattern.startsWith("**/")) return path.includes(pattern.slice(3));
  if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -3));
  return path.includes(pattern.replace(/\*\*/g, "").replace(/\*/g, ""));
}
