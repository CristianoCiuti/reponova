/**
 * graph phase — extracts symbols and builds the node+edge graph.
 *
 * Reads detected-files.json, performs incremental extraction (SHA-256 per-file),
 * assembles the full graph, and writes graph-nodes.json (no communities).
 */
import { join } from "node:path";
import type { Phase, PhaseContext, PhaseResult } from "../engine/phase.js";
import { readDetectedFiles } from "./file-detection.js";
import { extractAll, buildGraph } from "../../extract/index.js";
import { exportJson } from "../../extract/export-json.js";
import {
  computeHashes,
  loadBuildCache,
  diffFiles,
  saveBuildCache,
  cleanStaleCacheEntries,
} from "../../extract/incremental.js";
import { log } from "../../shared/utils.js";

export const graphPhase: Phase = {
  id: "graph",
  label: "Graph Building",
  dependencies: ["file-detection"],

  async execute(ctx: PhaseContext): Promise<PhaseResult> {
    const { config, workspace, outputDir, force } = ctx;
    const graphNodesPath = join(outputDir, "graph-nodes.json");

    // Read file list from upstream phase
    const detected = readDetectedFiles(outputDir);
    const allFiles = [...detected.code, ...detected.docs, ...detected.diagrams];

    if (allFiles.length === 0) {
      const emptyGraph = buildGraph({ extractions: [] });
      exportJson({
        graph: emptyGraph.graph,
        outputPath: graphNodesPath,
        config,
        configDir: ctx.configDir,
        outputDir,
      });
      return { processed: 0, skipped: false };
    }

    // Incremental extraction
    const incremental = config.incremental && !force;
    log.info(`Computing file hashes...`);
    const currentHashes = computeHashes(workspace, allFiles);

    const cache = incremental ? loadBuildCache(outputDir) : null;
    const diff = diffFiles(currentHashes, cache);

    if (diff.unchangedFiles.length > 0) {
      log.info(`  ${diff.unchangedFiles.length} files unchanged (cached)`);
      log.info(`  ${diff.changedFiles.length} files changed (re-extracting)`);
    }

    log.info("Extracting symbols and relationships...");
    const freshExtractions = await extractAll(workspace, diff.changedFiles);
    const extractions = [...diff.cachedExtractions, ...freshExtractions];

    // Always save cache (even after --force) so next incremental build works
    saveBuildCache(outputDir, currentHashes, extractions);
    cleanStaleCacheEntries(outputDir, currentHashes);

    // Build graph
    log.info("Building graph...");
    const repoNames = config.repos.length > 1
      ? new Set(config.repos.map((r) => r.name))
      : undefined;
    const repoName = config.repos.length === 1 ? config.repos[0]!.name : undefined;

    const builtGraph = buildGraph({
      extractions,
      repoName,
      repoNames: repoNames ? [...repoNames] : undefined,
    });

    log.info(`  ${builtGraph.stats.nodeCount} nodes, ${builtGraph.stats.edgeCount} edges`);
    log.info(`  ${builtGraph.stats.crossFileEdges} cross-file edges, ${builtGraph.stats.unresolvedImports} external imports`);

    // Export graph-nodes.json (no communities)
    exportJson({
      graph: builtGraph.graph,
      outputPath: graphNodesPath,
      config,
      configDir: ctx.configDir,
      outputDir,
    });

    return { processed: extractions.length, skipped: false };
  },
};
