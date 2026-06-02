/**
 * Extraction pipeline — orchestrates the full extraction flow.
 *
 * This is the main entry point for the in-process extraction engine.
 * It replaces the Python subprocess build pipeline.
 *
 * Flow:
 *   detectAllFiles → extractAll → buildGraph → detectCommunities → export
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import type { FileExtraction } from "./types.js";
import type { Config } from "../shared/types.js";
import { parse } from "./parser.js";
import { getExtractorForFile } from "./languages/registry.js";
import { buildSkipDirs, createPatternMatcher, extensionsToGlobs } from "../shared/path-resolver.js";
import { relativePosix } from "../shared/paths.js";
import { log } from "../shared/utils.js";

export { buildGraph, type BuiltGraph } from "../graph/builder.js";
export { detectCommunities, type CommunityResult } from "../graph/community.js";
export { exportJson } from "../graph/export-json.js";
export { exportHtml, exportCommunityHtml } from "../graph/export-html.js";
export type { FileExtraction } from "./types.js";

// ─── File Detection ──────────────────────────────────────────────────────────

/**
 * A registered file type for detection purposes.
 * Built-in "document" + all plugin-provided types.
 */
export interface RegisteredFileType {
  /** Key in detected-files result */
  id: string;
  /** Extensions with leading dot */
  extensions: Set<string>;
  /** Whether this type is enabled */
  enabled: boolean;
  /** Glob patterns specific to this type (override global) */
  patterns: string[];
  /** Exclude patterns specific to this type (additive to global) */
  exclude: string[];
  /** Max file size in KB (only relevant for docs) */
  maxFileSizeKb?: number;
}

/**
 * Detect all files under a workspace, categorized by registered file type.
 * Single filesystem walk. Returns Record<fileType, relativePaths[]>.
 */
export function detectAllFiles(
  workspace: string,
  config: Config,
  registeredTypes: RegisteredFileType[],
  skipDirs: Set<string> = buildSkipDirs(true),
  repoNames?: Set<string>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const enabledTypes = registeredTypes.filter((t) => t.enabled);

  // Build extension → type lookup
  const extToType = new Map<string, RegisteredFileType>();
  for (const type of enabledTypes) {
    result[type.id] = [];
    for (const ext of type.extensions) {
      extToType.set(ext, type);
    }
  }

  // Build per-type matchers
  const typeMatchers = new Map<string, { isIncluded: (p: string) => boolean; isExcluded: (p: string) => boolean }>();
  for (const type of enabledTypes) {
    const patterns = type.patterns.length > 0
      ? type.patterns
      : extensionsToGlobs(type.extensions);
    typeMatchers.set(type.id, {
      isIncluded: createPatternMatcher(patterns, repoNames),
      isExcluded: createPatternMatcher([...config.exclude, ...type.exclude], repoNames),
    });
  }

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const isDir = entry.isDirectory() || (entry.isSymbolicLink() && isDirectoryPath(fullPath));

      if (isDir) {
        if (skipDirs.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const relPath = relativePosix(workspace, fullPath);
        const lastDot = entry.name.lastIndexOf(".");
        if (lastDot === -1) continue;
        const ext = entry.name.slice(lastDot).toLowerCase();

        const type = extToType.get(ext);
        if (!type) continue;

        const matcher = typeMatchers.get(type.id)!;
        if (matcher.isExcluded(relPath)) continue;
        if (!matcher.isIncluded(relPath)) continue;

        // Check max file size if specified
        if (type.maxFileSizeKb) {
          try {
            const stat = statSync(fullPath);
            if (stat.size > type.maxFileSizeKb * 1024) continue;
          } catch {
            continue;
          }
        }

        result[type.id]!.push(relPath);
      }
    }
  }

  walk(workspace);

  // Sort all
  for (const key of Object.keys(result)) {
    result[key]!.sort();
  }

  return result;
}

/**
 * Check if a path points to a directory (follows symlinks/junctions).
 */
function isDirectoryPath(fullPath: string): boolean {
  try {
    return statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Extract all source files in a workspace.
 * Returns FileExtraction[] for all successfully parsed files.
 */
export async function extractAll(workspace: string, filePaths: string[]): Promise<FileExtraction[]> {
  const extractions: FileExtraction[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const relPath of filePaths) {
    const absPath = resolve(workspace, relPath);
    if (!existsSync(absPath)) {
      failed++;
      continue;
    }

    const extractor = getExtractorForFile(relPath);
    if (!extractor) {
      failed++;
      continue;
    }

    try {
      const source = readFileSync(absPath, "utf-8");

      let tree = null;
      if (extractor.wasmFile) {
        tree = await parse(source, extractor.wasmFile);
        if (!tree) {
          log.debug(`  Skipped (no parser): ${relPath}`);
          failed++;
          continue;
        }
      }

      const extraction = extractor.extract(tree, source, relPath);
      extractions.push(extraction);
      succeeded++;
    } catch (err) {
      log.debug(`  Failed to extract ${relPath}: ${err}`);
      failed++;
    }
  }

  log.info(`  Extracted: ${succeeded} files (${failed} skipped/failed)`);
  return extractions;
}


