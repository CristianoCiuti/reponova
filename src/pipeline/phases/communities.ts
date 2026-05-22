/**
 * communities phase — runs Louvain community detection.
 *
 * Loads graph-nodes.json into graphology, runs Louvain, writes graph.json
 * (the canonical graph file with community assignments for all downstream phases).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../shared/types.js";
import { loadGraphAsGraphology } from "../../graph/graphology.js";
import { detectCommunities } from "../../graph/community.js";
import { exportJson } from "../../graph/export-json.js";
import { log } from "../../shared/utils.js";
import { BasePhase, type PhaseContext, type PhaseResult } from "../engine/phase.js";

class CommunitiesPhase extends BasePhase {
  readonly id = "communities";
  readonly label = "Community Detection";
  readonly dependencies = ["graph"];
  readonly inputs = ["graph-nodes.json"];

  getExpectedOutputs(_config: Config): { files: string[]; dirs: string[] } {
    return { files: ["graph.json"], dirs: [] };
  }

  getRelevantConfig(_config: Config): object {
    return {};
  }

  async doWork(ctx: PhaseContext): Promise<PhaseResult> {
    const { config, outputDir } = ctx;
    const graphNodesPath = join(outputDir, "graph-nodes.json");
    const graphJsonPath = join(outputDir, "graph.json");

    if (!existsSync(graphNodesPath)) {
      throw new Error("graph-nodes.json not found — graph phase must run first");
    }

    const graph = loadGraphAsGraphology(graphNodesPath);
    const communities = detectCommunities(graph);

    log.info(`  ${communities.count} communities detected (modularity: ${communities.modularity.toFixed(3)})`);

    exportJson({
      graph,
      outputPath: graphJsonPath,
      config,
      configDir: ctx.configDir,
      outputDir,
    });

    return { processed: communities.count, skipped: false };
  }
}

export const communitiesPhase = new CommunitiesPhase();
