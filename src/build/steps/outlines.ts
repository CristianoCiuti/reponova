/**
 * Outline generation step.
 */
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, relative, dirname } from "node:path";
import { generateOutline, formatOutlineJson } from "../../outline/index.js";
import { atomicWriteJson } from "../../shared/atomic-write.js";
import { log } from "../../shared/utils.js";
import type { BuildStep, StepContext, StepResult } from "../types.js";
import { createPatternMatcher, buildSkipDirs, extensionsToGlobs } from "../../core/path-resolver.js";
import { getOutlineSupportedExtensions } from "../../outline/languages/registry.js";
import { hashFile } from "../incremental/incremental.js";

export const runOutlinesStep: BuildStep = async (ctx: StepContext): Promise<StepResult> => {
  const config = ctx.config.outlines;
  const outlinesDir = join(ctx.outputDir, "outlines");
  const cachePath = join(ctx.outputDir, ".cache", "outline-hashes.json");
  const effectiveForce = ctx.force;

  if (!config.enabled) {
    removeDirectory(outlinesDir);
    removeFile(cachePath);
    return { processed: 0, skipped: true, skipReason: "disabled in config" };
  }

  if (!ctx.graphChanged && !effectiveForce) {
    return { processed: 0, skipped: true, skipReason: "graph unchanged" };
  }

  const configDir = ctx.configDir;
  if (!configDir) {
    throw new Error("Outlines step requires configDir in StepContext");
  }

  const previousHashes = effectiveForce ? new Map<string, string>() : loadOutlineHashes(ctx.outputDir);
  const nextHashes = new Map<string, string>();
  const pendingWrites = new Map<string, string>();
  const tmpRoot = join(tmpdir(), `rn-outlines-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  let count = 0;
  const skipDirs = buildSkipDirs(config.exclude_common);
  const isMulti = ctx.config.repos.length > 1;

  mkdirSync(tmpRoot, { recursive: true });

  try {
    for (const repo of ctx.config.repos) {
      const repoPath = resolve(configDir, repo.path);
      if (!existsSync(repoPath)) {
        log.warn(`Repo path not found: ${repoPath}`);
        continue;
      }

      const files = findFiles(
        repoPath,
        config.patterns,
        config.exclude,
        skipDirs,
        isMulti ? repo.name : undefined,
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

        if (!effectiveForce && existsSync(outPath) && previousHashes.get(relPath) === fileHash) {
          continue;
        }

        try {
          const source = readFileSync(file, "utf-8");
          const outline = await generateOutline(relPath, source);
          if (!outline) continue;

          const tmpPath = join(tmpRoot, relPath + ".outline.json");
          mkdirSync(dirname(tmpPath), { recursive: true });
          writeFileSync(tmpPath, formatOutlineJson(outline));
          pendingWrites.set(relPath, tmpPath);
          count++;
        } catch (error) {
          log.warn(`Failed to process ${file}: ${error}`);
        }
      }
    }

    for (const [relPath, tmpPath] of pendingWrites) {
      const finalPath = join(outlinesDir, relPath + ".outline.json");
      mkdirSync(dirname(finalPath), { recursive: true });
      copyFileSync(tmpPath, finalPath);
    }

    let staleCount = 0;
    for (const [relPath] of previousHashes) {
      if (!nextHashes.has(relPath)) {
        const stalePath = join(outlinesDir, relPath + ".outline.json");
        try {
          if (existsSync(stalePath)) {
            unlinkSync(stalePath);
            staleCount++;
          }
        } catch {
          // ignore cleanup failures
        }
      }
    }

    if (staleCount > 0) log.info(`  Removed ${staleCount} stale outline(s)`);
    removeEmptyDirs(outlinesDir);
    saveOutlineHashes(ctx.outputDir, nextHashes);

    if (count === 0 && staleCount === 0) {
      return { processed: 0, skipped: true, skipReason: "up to date" };
    }

    return { processed: count, skipped: false };
  } finally {
    removeDirectory(tmpRoot);
  }
};

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
  const serialized: Record<string, string> = {};
  for (const [filePath, hash] of hashes) {
    serialized[filePath] = hash;
  }
  atomicWriteJson(join(outputDir, ".cache", "outline-hashes.json"), serialized);
}

function findFiles(
  baseDir: string,
  patterns: string[],
  exclude: string[],
  skipDirs: Set<string>,
  repoName?: string,
): string[] {
  const repoNames = repoName ? new Set([repoName]) : undefined;
  const effectivePatterns = patterns.length > 0 ? patterns : extensionsToGlobs(getOutlineSupportedExtensions());
  const isIncluded = createPatternMatcher(effectivePatterns, repoNames);
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
      if (isExcluded(relPath, repoName)) continue;
      if (isIncluded(relPath, repoName)) results.push(fullPath);
    }
  }

  walk(baseDir);
  return results;
}

function removeEmptyDirs(root: string): void {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const child = join(root, entry.name);
      removeEmptyDirs(child);
      try {
        if (readdirSync(child).length === 0) rmSync(child, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

function removeDirectory(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}

function removeFile(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
