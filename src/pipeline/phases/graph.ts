/**
 * graph phase — extracts symbols and builds the node+edge graph.
 *
 * Reads detected-files.json, performs incremental extraction (SHA-256 per-file),
 * assembles the full graph, and writes graph-nodes.json (no communities).
 */
import { join } from "node:path";
import type { Config } from "../../shared/types.js";
import { extractAll, buildGraph } from "../../extract/index.js";
import { exportJson } from "../../graph/export-json.js";
import {
  loadBuildCache,
  diffFiles,
  saveBuildCache,
  cleanStaleCacheEntries,
} from "../cache.js";
import { log } from "../../shared/utils.js";
import { BasePhase, type PhaseContext, type PhaseResult } from "../engine/phase.js";
import { readDetectedFiles, readFileHashes } from "./file-detection.js";

class GraphPhase extends BasePhase {
  readonly id = "graph";
  readonly label = "Graph Building";
  readonly dependencies = ["file-detection"];
  readonly inputs = ["detected-files.json", "file-hashes.json"];

  getExpectedOutputs(_config: Config): { files: string[]; dirs: string[] } {
    return { files: ["graph-nodes.json"], dirs: [] };
  }

  getRelevantConfig(config: Config): object {
    return {
      patterns: config.patterns,
      exclude: config.exclude,
      incremental: config.incremental,
    };
  }

  async doWork(ctx: PhaseContext): Promise<PhaseResult> {
    const { config, outputDir, force } = ctx;
    const graphNodesPath = join(outputDir, "graph-nodes.json");

    const detected = readDetectedFiles(outputDir);
    const allFiles = Object.values(detected.files).flat();

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

    const incremental = config.incremental && !force;
    const currentHashes = readFileHashes(outputDir);
    const cache = incremental ? loadBuildCache(outputDir) : null;
    const diff = diffFiles(currentHashes, cache);

    if (diff.unchangedFiles.length > 0) {
      log.info(`  ${diff.unchangedFiles.length} files unchanged (cached)`);
      log.info(`  ${diff.changedFiles.length} files changed (re-extracting)`);
    }

    log.info("Extracting symbols and relationships...");
    const freshExtractions = await extractAll(ctx.workspace, diff.changedFiles);
    const extractions = [...diff.cachedExtractions, ...freshExtractions];

    saveBuildCache(outputDir, currentHashes, extractions);
    cleanStaleCacheEntries(outputDir, currentHashes);

    log.info("Building graph...");
    const repoNames = config.repos.length > 1
      ? new Set(config.repos.map((repo) => repo.name))
      : undefined;
    const repoName = config.repos.length === 1 ? config.repos[0]!.name : undefined;

    const builtGraph = buildGraph({
      extractions,
      repoName,
      repoNames: repoNames ? [...repoNames] : undefined,
    });

    log.info(`  ${builtGraph.stats.nodeCount} nodes, ${builtGraph.stats.edgeCount} edges`);
    log.info(`  ${builtGraph.stats.crossFileEdges} cross-file edges, ${builtGraph.stats.unresolvedImports} external imports`);

    exportJson({
      graph: builtGraph.graph,
      outputPath: graphNodesPath,
      config,
      configDir: ctx.configDir,
      outputDir,
    });

    return { processed: extractions.length, skipped: false };
  }
}

export const graphPhase = new GraphPhase();
