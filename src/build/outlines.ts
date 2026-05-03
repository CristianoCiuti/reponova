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
import { createMatcher } from "../shared/glob.js";
import { hashFile } from "./incremental.js";

export interface OutlineOptions {
  force: boolean;
  skipDirs?: Set<string>;
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
  const skipDirs = options.skipDirs ?? new Set<string>();

  for (const repo of config.repos) {
    const repoPath = resolve(configDir, repo.path);
    if (!existsSync(repoPath)) {
      log.warn(`Repo path not found: ${repoPath}`);
      continue;
    }

    const files = findFiles(repoPath, config.outlines.patterns, config.outlines.exclude, skipDirs);

    for (const file of files) {
      // Single-repo: no repo prefix. Multi-repo: prefix with repo name.
      const mode = config.repos.length === 1 ? "single" : "multi";
      const relPath = mode === "single"
        ? relative(repoPath, file).split("\\").join("/")
        : `${repo.name}/${relative(repoPath, file)}`.split("\\").join("/");
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

function findFiles(
  baseDir: string,
  patterns: string[],
  exclude: string[],
  skipDirs: Set<string>,
): string[] {
  const isIncluded = createMatcher(patterns);
  const isExcluded = createMatcher(exclude);
  const results: string[] = [];

  function walk(dir: string): void {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const relPath = relative(baseDir, fullPath).split("\\").join("/");
      if (isExcluded(relPath)) continue;
      if (isIncluded(relPath)) {
        results.push(fullPath);
      }
    }
  }

  walk(baseDir);
  return results;
}
