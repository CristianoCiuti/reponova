/**
 * Incremental build engine.
 *
 * Uses SHA-256 content hashing per file to avoid re-extracting unchanged files.
 * Cached FileExtraction results are stored on disk and reused across builds.
 *
 * Storage layout:
 *   <output>/.cache/
 *     hashes.json                   # { "relative/path.py": "sha256hex", ... }
 *     extractions/
 *       <sha256>.json               # cached FileExtraction per file
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { FileExtraction } from "../extract/types.js";
import { log } from "../shared/utils.js";

export interface BuildCache {
  /** Stored hashes from the last build: relPath → sha256 */
  hashes: Map<string, string>;
  /** Directory where extraction caches are stored */
  cacheDir: string;
  /** Directory where hashes.json lives */
  baseDir: string;
}

export interface IncrementalResult {
  /** Files that changed or are new (need re-extraction) */
  changedFiles: string[];
  /** Files that are unchanged (use cached extraction) */
  unchangedFiles: string[];
  /** Files that existed in cache but were removed from the workspace */
  removedFiles: string[];
  /** Cached extractions loaded from disk */
  cachedExtractions: FileExtraction[];
}

/**
 * Compute SHA-256 hash of file contents.
 */
export function hashFile(absPath: string): string {
  const content = readFileSync(absPath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute hashes for all files in the list.
 * @param workspace - Workspace root directory
 * @param filePaths - Relative file paths
 * @returns Map of relPath → sha256
 */
export function computeHashes(workspace: string, filePaths: string[]): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const relPath of filePaths) {
    const absPath = join(workspace, relPath);
    try {
      hashes.set(relPath, hashFile(absPath));
    } catch {
      // File might have been deleted between detection and hashing
    }
  }
  return hashes;
}

/**
 * Load the build cache from disk.
 * Returns null if no cache exists (first build or --force).
 */
export function loadBuildCache(outputDir: string): BuildCache | null {
  const baseDir = join(outputDir, ".cache");
  const hashesPath = join(baseDir, "hashes.json");

  if (!existsSync(hashesPath)) {
    return null;
  }

  try {
    const raw = readFileSync(hashesPath, "utf-8");
    const data = JSON.parse(raw) as Record<string, string>;
    const hashes = new Map(Object.entries(data));
    return {
      hashes,
      cacheDir: join(baseDir, "extractions"),
      baseDir,
    };
  } catch {
    log.debug("Failed to load build cache, will rebuild from scratch");
    return null;
  }
}

/**
 * Compute a cache key from a file path.
 * Used to store/retrieve cached extractions independently of content hash.
 */
function cacheKeyForPath(relPath: string): string {
  return createHash("sha256").update(relPath).digest("hex");
}

/**
 * Save the build cache to disk.
 */
export function saveBuildCache(
  outputDir: string,
  hashes: Map<string, string>,
  extractions: FileExtraction[],
): void {
  const baseDir = join(outputDir, ".cache");
  const extractionsDir = join(baseDir, "extractions");
  mkdirSync(extractionsDir, { recursive: true });

  // Save hashes
  const hashObj: Record<string, string> = {};
  for (const [k, v] of hashes) {
    hashObj[k] = v;
  }
  writeFileSync(join(baseDir, "hashes.json"), JSON.stringify(hashObj, null, 2));

  // Save extractions keyed by path hash (not content hash)
  // This avoids collisions for files with identical content but different paths
  for (const extraction of extractions) {
    const pathKey = cacheKeyForPath(extraction.filePath);
    const cachePath = join(extractionsDir, `${pathKey}.json`);
    writeFileSync(cachePath, JSON.stringify(extraction));
  }
}

/**
 * Load a cached extraction by file path.
 */
export function loadCachedExtraction(cache: BuildCache, relPath: string): FileExtraction | null {
  const pathKey = cacheKeyForPath(relPath);
  const cachePath = join(cache.cacheDir, `${pathKey}.json`);
  if (!existsSync(cachePath)) {
    return null;
  }

  try {
    const raw = readFileSync(cachePath, "utf-8");
    return JSON.parse(raw) as FileExtraction;
  } catch {
    return null;
  }
}

/**
 * Determine which files need re-extraction vs can use cache.
 *
 * @param currentHashes - Hashes of all currently detected files
 * @param cache - Previous build cache (null = first build)
 * @returns IncrementalResult with changed/unchanged files and cached extractions
 */
export function diffFiles(
  currentHashes: Map<string, string>,
  cache: BuildCache | null,
): IncrementalResult {
  if (!cache) {
    // No cache — everything is "changed"
    return {
      changedFiles: [...currentHashes.keys()],
      unchangedFiles: [],
      removedFiles: [],
      cachedExtractions: [],
    };
  }

  const changedFiles: string[] = [];
  const unchangedFiles: string[] = [];
  const removedFiles: string[] = [];
  const cachedExtractions: FileExtraction[] = [];

  for (const [relPath, hash] of currentHashes) {
    const prevHash = cache.hashes.get(relPath);
    if (prevHash === hash) {
      // File unchanged — try to load cached extraction
      const cached = loadCachedExtraction(cache, relPath);
      if (cached) {
        unchangedFiles.push(relPath);
        cachedExtractions.push(cached);
      } else {
        // Cache file missing — treat as changed
        changedFiles.push(relPath);
      }
    } else {
      changedFiles.push(relPath);
    }
  }

  for (const prevPath of cache.hashes.keys()) {
    if (!currentHashes.has(prevPath)) {
      removedFiles.push(prevPath);
    }
  }

  return { changedFiles, unchangedFiles, removedFiles, cachedExtractions };
}

/**
 * Clean up stale cache entries that no longer correspond to any file.
 */
export function cleanStaleCacheEntries(
  outputDir: string,
  currentHashes: Map<string, string>,
): void {
  const extractionsDir = join(outputDir, ".cache", "extractions");
  if (!existsSync(extractionsDir)) return;

  const validPathKeys = new Set<string>();
  for (const relPath of currentHashes.keys()) {
    validPathKeys.add(cacheKeyForPath(relPath));
  }

  try {
    for (const entry of readdirSync(extractionsDir)) {
      const pathKey = entry.replace(".json", "");
      if (!validPathKeys.has(pathKey)) {
        try {
          unlinkSync(join(extractionsDir, entry));
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  } catch {
    // Ignore if directory doesn't exist or can't be read
  }
}
