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
import { resolve, join, relative } from "node:path";
import type { FileExtraction } from "./types.js";
import type { DocsConfig, ImagesConfig } from "../shared/types.js";
import { parse } from "./parser.js";
import { getExtractorForFile, getSupportedExtensions } from "./languages/registry.js";
import { buildGraph, type BuiltGraph } from "./graph-builder.js";
import { detectCommunities, type CommunityResult } from "./community.js";
import { exportJson } from "./export-json.js";
import { log } from "../shared/utils.js";

export { buildGraph, type BuiltGraph } from "./graph-builder.js";
export { detectCommunities, type CommunityResult } from "./community.js";
export { exportJson } from "./export-json.js";
export { exportHtml, exportCommunityHtml } from "./export-html.js";
export type { FileExtraction } from "./types.js";

// ─── File Detection ──────────────────────────────────────────────────────────

/** Default directories to skip during file detection */
const SKIP_DIRS = new Set([
  "node_modules", "__pycache__", ".git", ".svn", ".hg",
  "venv", ".venv", "env", ".env", ".tox",
  "site-packages", "dist", "build", ".eggs",
  ".mypy_cache", ".pytest_cache", ".ruff_cache",
  "target", "bin", "obj",
]);

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
 */
export function detectFiles(workspace: string, excludeDirs: string[] = []): string[] {
  const extraExcludes = new Set(excludeDirs);
  const extensions = getCodeExtensions();
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
        if (SKIP_DIRS.has(entry.name) || extraExcludes.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = "." + (entry.name.split(".").pop()?.toLowerCase() ?? "");
        if (extensions.has(ext)) {
          const relPath = relative(workspace, fullPath).replace(/\\/g, "/");
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
export function detectDocFiles(workspace: string, excludeDirs: string[] = [], docsConfig?: DocsConfig): string[] {
  if (!docsConfig?.enabled) return [];

  const extraExcludes = new Set(excludeDirs);
  const maxSizeBytes = (docsConfig.max_file_size_kb ?? 500) * 1024;

  // Build exclude patterns (simplified glob → prefix matching)
  const excludePatterns = docsConfig.exclude.map((p) => p.replace(/\*\*/g, "").replace(/\*/g, ""));

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
        if (SKIP_DIRS.has(entry.name) || extraExcludes.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = "." + (entry.name.split(".").pop()?.toLowerCase() ?? "");
        if (!DOC_EXTENSIONS.has(ext)) continue;

        const relPath = relative(workspace, fullPath).replace(/\\/g, "/");

        // Check exclude patterns
        if (excludePatterns.some((p) => relPath.includes(p.replace(/^\//, "")))) continue;

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
export function detectDiagramFiles(workspace: string, excludeDirs: string[] = [], imagesConfig?: ImagesConfig): string[] {
  if (!imagesConfig?.enabled) return [];

  const extraExcludes = new Set(excludeDirs);
  const diagramExts = new Set([".puml", ".plantuml", ".svg", ".png", ".jpg", ".jpeg", ".gif"]);
  const excludePatterns = imagesConfig.exclude.map((p) => p.replace(/\*\*/g, "").replace(/\*/g, ""));

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
        if (SKIP_DIRS.has(entry.name) || extraExcludes.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = "." + (entry.name.split(".").pop()?.toLowerCase() ?? "");
        if (!diagramExts.has(ext)) continue;

        const relPath = relative(workspace, fullPath).replace(/\\/g, "/");

        // Check exclude patterns
        if (excludePatterns.some((p) => relPath.includes(p.replace(/^\//, "")))) continue;

        // Skip binary images unless puml/svg config says to parse them
        if ((ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif")) {
          // Binary images are very lightweight (just metadata node) — include them
        }

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

// ─── Full Pipeline ───────────────────────────────────────────────────────────

export interface PipelineOptions {
  /** Workspace root directory */
  workspace: string;
  /** Directory names to exclude from file detection */
  excludeDirs?: string[];
  /** Output path for graph.json */
  graphJsonPath: string;
  /** Repo name for tagging nodes */
  repoName?: string;
  /** Min degree for HTML filtering (passed through for orchestrator use) */
  htmlMinDegree?: number;
  /** Output directory (for incremental cache storage) */
  outputDir?: string;
  /** Whether to use incremental build (skip unchanged files) */
  incremental?: boolean;
  /** Docs configuration */
  docsConfig?: DocsConfig;
  /** Images/diagrams configuration */
  imagesConfig?: ImagesConfig;
}

export interface PipelineResult {
  builtGraph: BuiltGraph;
  communities: CommunityResult;
  fileCount: number;
  extractionCount: number;
  /** Incremental build stats */
  incrementalStats?: {
    cachedFiles: number;
    reextractedFiles: number;
  };
}

/**
 * Run the full extraction pipeline:
 * detect → extract → build graph → detect communities → export
 *
 * When incremental=true and outputDir is provided, caches extraction results
 * and reuses them for unchanged files on subsequent builds.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { workspace, excludeDirs = [], graphJsonPath, repoName, outputDir, incremental, docsConfig, imagesConfig } = options;

  // 1. Detect files
  log.info("Detecting files...");
  const codeFiles = detectFiles(workspace, excludeDirs);
  const docFiles = detectDocFiles(workspace, excludeDirs, docsConfig);
  const diagramFiles = detectDiagramFiles(workspace, excludeDirs, imagesConfig);
  const files = [...codeFiles, ...docFiles, ...diagramFiles];

  const extras: string[] = [];
  if (docFiles.length > 0) extras.push(`${docFiles.length} doc files`);
  if (diagramFiles.length > 0) extras.push(`${diagramFiles.length} diagram/image files`);
  log.info(`  Found ${codeFiles.length} source files${extras.length > 0 ? `, ${extras.join(", ")}` : ""}`);

  if (files.length === 0) {
    // Write empty graph
    const emptyGraph = buildGraph({ extractions: [] });
    const emptyCommunities = detectCommunities(emptyGraph.graph);
    exportJson({ graph: emptyGraph.graph, communities: emptyCommunities, outputPath: graphJsonPath });
    return {
      builtGraph: emptyGraph,
      communities: emptyCommunities,
      fileCount: 0,
      extractionCount: 0,
    };
  }

  // 2. Extract (with optional incremental caching)
  let extractions: FileExtraction[];
  let incrementalStats: { cachedFiles: number; reextractedFiles: number } | undefined;

  if (outputDir) {
    // Lazy-import to avoid circular dependencies
    const { computeHashes, loadBuildCache, diffFiles, saveBuildCache, cleanStaleCacheEntries } = await import("../build/incremental.js");

    log.info("Computing file hashes...");
    const currentHashes = computeHashes(workspace, files);

    // Only try to use cache when incremental is enabled
    const cache = incremental ? loadBuildCache(outputDir) : null;
    const diff = diffFiles(currentHashes, cache);

    if (diff.unchangedFiles.length > 0) {
      log.info(`  ${diff.unchangedFiles.length} files unchanged (cached)`);
      log.info(`  ${diff.changedFiles.length} files changed (re-extracting)`);
    }

    // Extract only changed files
    log.info("Extracting symbols and relationships...");
    const freshExtractions = await extractAll(workspace, diff.changedFiles);

    // Combine cached + fresh
    extractions = [...diff.cachedExtractions, ...freshExtractions];
    incrementalStats = {
      cachedFiles: diff.unchangedFiles.length,
      reextractedFiles: diff.changedFiles.length,
    };

    // Always save cache for future builds
    saveBuildCache(outputDir, currentHashes, extractions);
    cleanStaleCacheEntries(outputDir, currentHashes);
  } else {
    log.info("Extracting symbols and relationships...");
    extractions = await extractAll(workspace, files);
  }

  // 3. Build graph
  log.info("Building graph...");
  const builtGraph = buildGraph({ extractions, repoName });
  log.info(`  ${builtGraph.stats.nodeCount} nodes, ${builtGraph.stats.edgeCount} edges`);
  log.info(`  ${builtGraph.stats.crossFileEdges} cross-file edges, ${builtGraph.stats.unresolvedImports} external imports`);

  // 4. Detect communities
  log.info("Detecting communities...");
  const communities = detectCommunities(builtGraph.graph);
  log.info(`  ${communities.count} communities detected`);

  // 5. Export JSON
  log.info("Exporting graph.json...");
  exportJson({ graph: builtGraph.graph, communities, outputPath: graphJsonPath });

  // Note: HTML generation is done in the orchestrator AFTER the intelligence
  // layer, so that community summaries can be injected as community names.

  return {
    builtGraph,
    communities,
    fileCount: files.length,
    extractionCount: extractions.length,
    incrementalStats,
  };
}
