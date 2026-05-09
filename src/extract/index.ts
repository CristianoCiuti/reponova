/**
 * Extraction pipeline — orchestrates the full extraction flow.
 *
 * This is the main entry point for the in-process extraction engine.
 * It replaces the Python subprocess build pipeline.
 *
 * Flow:
 *   detectFiles → extractAll → buildGraph → detectCommunities → export
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import type { FileExtraction } from "./types.js";
import type { DocsConfig, ImagesConfig } from "../shared/types.js";
import { parse } from "./parser.js";
import { getExtractorForFile, getSupportedExtensions } from "./languages/registry.js";
import { buildSkipDirs, createPatternMatcher, extensionsToGlobs } from "../shared/path-resolver.js";
import { relativePosix } from "../shared/paths.js";
import { log } from "../shared/utils.js";

export { buildGraph, type BuiltGraph } from "../graph/builder.js";
export { detectCommunities, type CommunityResult } from "../graph/community.js";
export { exportJson } from "../graph/export-json.js";
export { exportHtml, exportCommunityHtml } from "../graph/export-html.js";
export type { FileExtraction } from "./types.js";

// ─── File Detection ──────────────────────────────────────────────────────────

/** Doc/text extensions handled by the markdown extractor */
const DOC_EXTENSIONS = new Set([".md", ".txt", ".rst"]);

/** Diagram/image extensions handled by the diagram extractor */
const DIAGRAM_EXTENSIONS = new Set([".puml", ".plantuml", ".svg", ".png", ".jpg", ".jpeg", ".gif"]);

/** Code extensions (all non-doc, non-diagram supported extensions) */
function getCodeExtensions(): Set<string> {
  const all = new Set(getSupportedExtensions());
  for (const ext of DOC_EXTENSIONS) {
    all.delete(ext);
  }
  for (const ext of DIAGRAM_EXTENSIONS) {
    all.delete(ext);
  }
  return all;
}

/**
 * Detect all source code files under a workspace directory.
 * Returns relative paths (forward slashes). Excludes doc files.
 *
 * @param workspace - Root directory to walk
 * @param patterns - Glob patterns for files to include (empty = auto-detect by extension)
 * @param excludeGlobs - Glob patterns to exclude from results
 */
export function detectFiles(
  workspace: string,
  patterns: string[] = [],
  excludeGlobs: string[] = [],
  skipDirs: Set<string> = buildSkipDirs(true),
  repoNames?: Set<string>,
): string[] {
  const effectivePatterns = patterns.length > 0 ? patterns : extensionsToGlobs(getCodeExtensions());
  const isIncluded = createPatternMatcher(effectivePatterns, repoNames);
  const isExcluded = createPatternMatcher(excludeGlobs, repoNames);
  const files: string[] = [];

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

        if (isExcluded(relPath)) continue;
        if (isIncluded(relPath)) {
          files.push(relPath);
        }
      }
    }
  }

  walk(workspace);
  return files;
}

/**
 * Detect documentation files under a workspace directory.
 * Respects docs config (patterns, excludes, max file size).
 */
export function detectDocFiles(workspace: string, docsConfig?: DocsConfig, skipDirs: Set<string> = buildSkipDirs(true), repoNames?: Set<string>): string[] {
  if (!docsConfig?.enabled) return [];

  const maxSizeBytes = (docsConfig.max_file_size_kb ?? 500) * 1024;
  const effectivePatterns = docsConfig.patterns.length > 0 ? docsConfig.patterns : extensionsToGlobs(DOC_EXTENSIONS);
  const isIncluded = createPatternMatcher(effectivePatterns, repoNames);
  const isExcluded = createPatternMatcher(docsConfig.exclude, repoNames);

  const files: string[] = [];

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

        if (isExcluded(relPath)) continue;
        if (!isIncluded(relPath)) continue;

        // Check file size
        try {
          const stat = statSync(fullPath);
          if (stat.size > maxSizeBytes) continue;
        } catch {
          continue;
        }

        files.push(relPath);
      }
    }
  }

  walk(workspace);
  return files;
}

/**
 * Detect diagram/image files under a workspace directory.
 * Respects images config (patterns, excludes).
 */
export function detectDiagramFiles(workspace: string, imagesConfig?: ImagesConfig, skipDirs: Set<string> = buildSkipDirs(true), repoNames?: Set<string>): string[] {
  if (!imagesConfig?.enabled) return [];

  const effectivePatterns = imagesConfig.patterns.length > 0 ? imagesConfig.patterns : extensionsToGlobs(DIAGRAM_EXTENSIONS);
  const isIncluded = createPatternMatcher(effectivePatterns, repoNames);
  const isExcluded = createPatternMatcher(imagesConfig.exclude, repoNames);

  const files: string[] = [];

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

        if (isExcluded(relPath)) continue;
        if (!isIncluded(relPath)) continue;

        files.push(relPath);
      }
    }
  }

  walk(workspace);
  return files;
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
      // Binary image files: read as empty string (extractor only needs filePath)
      const isBinaryImage = /\.(png|jpg|jpeg|gif)$/i.test(relPath);
      const source = isBinaryImage ? "" : readFileSync(absPath, "utf-8");

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

