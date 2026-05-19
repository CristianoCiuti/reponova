/**
 * Known output files/dirs for each phase.
 * Used by --start-after to validate prerequisite outputs exist.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export const PHASE_OUTPUTS: Record<string, string[]> = {
  "file-detection": ["detected-files.json"],
  "graph": ["graph-nodes.json"],
  "outlines": [],
  "communities": ["graph.json"],
  "enrich": ["graph-enriched.json", "node_descriptions.json", "community_summaries.json"],
  "index": ["graph_search.db"],
  "embeddings": [],
  "html": ["graph.html", "graph_communities.html"],
  "report": ["report.md"],
};

export const PHASE_OUTPUT_DIRS: Record<string, string[]> = {
  "outlines": ["outlines"],
  "embeddings": ["vectors"],
};

/**
 * Check that a phase's expected outputs exist on disk.
 * Throws if any required output is missing.
 */
export function validatePhaseOutputsExist(
  phaseId: string,
  outputDir: string,
): void {
  const files = PHASE_OUTPUTS[phaseId] ?? [];
  const dirs = PHASE_OUTPUT_DIRS[phaseId] ?? [];

  const missing: string[] = [];

  for (const file of files) {
    if (!existsSync(join(outputDir, file))) {
      missing.push(file);
    }
  }

  for (const dir of dirs) {
    if (!existsSync(join(outputDir, dir))) {
      missing.push(`${dir}/`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Cannot use --start-after "${phaseId}": missing output files: ${missing.join(", ")}. ` +
      `Run a full build first, or run with --target to include this phase.`,
    );
  }
}
