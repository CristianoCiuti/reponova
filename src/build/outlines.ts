/**
 * Outline generation for the build pipeline.
 *
 * Walks configured repos, applies path filters, and generates
 * pre-computed .outline.json files using the outline module.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { resolve, join, relative, dirname } from "node:path";
import { generateOutline, formatOutlineJson } from "../outline/index.js";
import { log } from "../shared/utils.js";
import type { Config } from "../shared/types.js";
import { createPatternMatcher } from "../core/path-resolver.js";
import { buildSkipDirs } from "../core/path-resolver.js";
import { getOutlineSupportedExtensions } from "../outline/languages/registry.js";
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
  const skipDirs = options.skipDirs ?? buildSkipDirs(config.outlines.exclude_common);
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

  // Clean up empty directories left behind by stale removal
  removeEmptyDirs(outlinesDir);

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
 * When patterns is empty, auto-detects by file extension using the outline language registry.
 * When patterns is provided, uses createPatternMatcher for bidirectional dual matching.
 */
function findFiles(
  baseDir: string,
  patterns: string[],
  exclude: string[],
  skipDirs: Set<string>,
  repoName?: string,
): string[] {
  const repoNames = repoName ? new Set([repoName]) : undefined;
  const outlineExts = patterns.length === 0 ? getOutlineSupportedExtensions() : null;
  const isIncluded = patterns.length > 0 ? createPatternMatcher(patterns, repoNames) : null;
  const isExcluded = createPatternMatcher(exclude, repoNames);
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

      // Check exclusion — pass repoName so workspace-relative excludes work
      if (isExcluded(relPath, repoName)) continue;

      if (isIncluded) {
        // Pattern-based: pass repoName so workspace-relative patterns work
        if (isIncluded(relPath, repoName)) {
          results.push(fullPath);
        }
      } else {
        // Extension-based auto-detect (no patterns)
        const ext = "." + (entry.name.split(".").pop()?.toLowerCase() ?? "");
        if (outlineExts!.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(baseDir);
  return results;
}

/**
 * Recursively remove empty directories under root (bottom-up).
 * Leaves root itself intact even if empty.
 */
function removeEmptyDirs(root: string): void {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const child = join(root, entry.name);
      removeEmptyDirs(child);
      // After recursing, try to remove if now empty
      try {
        if (readdirSync(child).length === 0) rmdirSync(child);
      } catch { /* ignore */ }
    }
  }
}
