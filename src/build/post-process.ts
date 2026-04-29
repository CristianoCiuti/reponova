import { readFileSync, writeFileSync } from "node:fs";
import type { GraphData } from "../shared/types.js";
import { fixGraphPaths } from "../core/path-fixer.js";
import { log } from "../shared/utils.js";

/**
 * Post-process the merged graph.json:
 * - Normalize file paths to relative, forward-slash form
 */
export function postProcess(graphJsonPath: string, basePaths: string[]): void {
  log.info("Post-processing graph...");

  const raw = readFileSync(graphJsonPath, "utf-8");
  const data = JSON.parse(raw) as GraphData;

  // Fix node paths
  fixGraphPaths(data.nodes, basePaths);

  // Fix edge source/target (they might reference file paths in some formats)
  // Usually edges reference node IDs, not paths, so this is a no-op for most cases

  writeFileSync(graphJsonPath, JSON.stringify(data, null, 2));
  log.info("  \u2713 Paths normalized");
}
