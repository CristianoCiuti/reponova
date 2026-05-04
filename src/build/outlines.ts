/**
 * Outline generation for the build pipeline.
 *
 * Walks configured repos, applies path filters, and generates
 * pre-computed .outline.json files using the outline module.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
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
  const isMulti = config.repos.length > 1;

  for (const repo of config.repos) {
    const repoPath = resolve(configDir, repo.path);
    if (!existsSync(repoPath)) {
      log.warn(`Repo path not found: ${repoPath}`);
      continue;
    }

    // Multi-repo: pass repo name so patterns like "repoName/path/**" match
    const files = findFiles(
      repoPath, config.outlines.patterns, config.outlines.exclude,
      skipDirs, isMulti ? repo.name : undefined,
    );

    if (files.length === 0) {
      log.info(`  ${repo.name}: no files matched outline patterns`);
    } else {
      log.info(`  ${repo.name}: ${files.length} file(s) matched`);
    }

    for (const file of files) {
      const relPath = isMulti
        ? `${repo.name}/${relative(repoPath, file)}`.split("\\").join("/")
        : relative(repoPath, file).split("\\").join("/");
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

  // Clean up stale outlines: files in previous build but not in current
  let staleCount = 0;
  for (const [relPath] of previousHashes) {
    if (!nextHashes.has(relPath)) {
      const stalePath = join(outlinesDir, relPath + ".outline.json");
      try {
        if (existsSync(stalePath)) {
          unlinkSync(stalePath);
          staleCount++;
        }
      } catch { /* ignore cleanup failures */ }
    }
  }
  if (staleCount > 0) log.info(`  Removed ${staleCount} stale outline(s)`);

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

/**
 * Walk baseDir and return files matching patterns.
 * When repoName is provided (multi-repo), tests BOTH forms:
 *   - repo-relative:      "commonlib/foo.py"
 *   - workspace-relative: "motore_common/commonlib/foo.py"
 * This mirrors the dual-match semantics in path-resolver.ts.
 */
function findFiles(
  baseDir: string,
  patterns: string[],
  exclude: string[],
  skipDirs: Set<string>,
  repoName?: string,
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
      const wsPath = repoName ? `${repoName}/${relPath}` : null;

      // Check exclusion — either form triggers exclude
      if (isExcluded(relPath)) continue;
      if (wsPath && isExcluded(wsPath)) continue;

      // Check inclusion — either form triggers include
      if (isIncluded(relPath) || (wsPath && isIncluded(wsPath))) {
        results.push(fullPath);
      }
    }
  }

  walk(baseDir);
  return results;
}
