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
import { parse } from "./parser.js";
import { getExtractorForFile, getSupportedExtensions } from "./languages/registry.js";
import { buildGraph, type BuiltGraph } from "./graph-builder.js";
import { detectCommunities, type CommunityResult } from "./community.js";
import { exportJson } from "./export-json.js";
import { exportHtml } from "./export-html.js";
import { log } from "../shared/utils.js";

export { buildGraph, type BuiltGraph } from "./graph-builder.js";
export { detectCommunities, type CommunityResult } from "./community.js";
export { exportJson } from "./export-json.js";
export { exportHtml } from "./export-html.js";

// ─── File Detection ──────────────────────────────────────────────────────────

/** Default directories to skip during file detection */
const SKIP_DIRS = new Set([
  "node_modules", "__pycache__", ".git", ".svn", ".hg",
  "venv", ".venv", "env", ".env", ".tox",
  "site-packages", "dist", "build", ".eggs",
  ".mypy_cache", ".pytest_cache", ".ruff_cache",
  "target", "bin", "obj",
]);

/**
 * Detect all source files under a workspace directory.
 * Returns relative paths (forward slashes).
 */
export function detectFiles(workspace: string, excludeDirs: string[] = []): string[] {
  const extraExcludes = new Set(excludeDirs);
  const extensions = new Set(getSupportedExtensions());
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

      // Handle both regular directories and symlinks/junctions
      // On Windows, junctions report isDirectory()=false, isSymbolicLink()=true
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
      const tree = await parse(source, extractor.wasmFile);

      if (!tree) {
        log.debug(`  Skipped (no parser): ${relPath}`);
        failed++;
        continue;
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
  /** Output path for graph.html (optional) */
  graphHtmlPath?: string;
  /** Repo name for tagging nodes */
  repoName?: string;
  /** Min degree for HTML filtering */
  htmlMinDegree?: number;
}

export interface PipelineResult {
  builtGraph: BuiltGraph;
  communities: CommunityResult;
  fileCount: number;
  extractionCount: number;
}

/**
 * Run the full extraction pipeline:
 * detect → extract → build graph → detect communities → export
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { workspace, excludeDirs = [], graphJsonPath, graphHtmlPath, repoName, htmlMinDegree } = options;

  // 1. Detect files
  log.info("Detecting files...");
  const files = detectFiles(workspace, excludeDirs);
  log.info(`  Found ${files.length} source files`);

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

  // 2. Extract
  log.info("Extracting symbols and relationships...");
  const extractions = await extractAll(workspace, files);

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

  // 6. Export HTML (optional)
  if (graphHtmlPath) {
    log.info("Generating graph.html...");
    exportHtml({
      graph: builtGraph.graph,
      communities,
      outputPath: graphHtmlPath,
      minDegree: htmlMinDegree,
    });
  }

  return {
    builtGraph,
    communities,
    fileCount: files.length,
    extractionCount: extractions.length,
  };
}
