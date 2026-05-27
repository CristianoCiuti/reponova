/**
 * enrich phase — generates graph-enriched.json, node descriptions, and community summaries.
 *
 * Algorithmic mode only in M1.
 */
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, GraphData } from "../../shared/types.js";
import { atomicWriteJson } from "../../shared/atomic-write.js";
import {
  algorithmicDescription,
  buildAlgorithmicSummary,
  buildCommunityData,
  computeEdgeCounts,
  findHubs,
  findPrimaryPath,
  selectTargetNodes,
  type CommunitySummary,
  type NodeDescription,
} from "../enrich/algorithmic.js";
import { BasePhase, type PhaseContext, type PhaseResult } from "../engine/phase.js";

class EnrichPhase extends BasePhase {
  readonly id = "enrich";
  readonly label = "Enrich";
  readonly dependencies = ["communities"];
  readonly inputs = ["graph.json"];

  getExpectedOutputs(_config: Config): { files: string[]; dirs: string[] } {
    return {
      files: ["graph-enriched.json", "node_descriptions.json", "community_summaries.json"],
      dirs: [],
    };
  }

  getRelevantConfig(config: Config): object {
    return { enrich: config.enrich };
  }

  async doWork(ctx: PhaseContext): Promise<PhaseResult> {
    const { config, outputDir, configDir } = ctx;
    const enrichConfig = config.enrich;
    const graphJsonPath = join(outputDir, "graph.json");
    const graphEnrichedPath = join(outputDir, "graph-enriched.json");
    const descriptionsPath = join(outputDir, "node_descriptions.json");
    const summariesPath = join(outputDir, "community_summaries.json");

    if (!enrichConfig.enabled) {
      // Passthrough: downstream phases always need graph-enriched.json to exist
      copyFileSync(graphJsonPath, graphEnrichedPath);
      atomicWriteJson(descriptionsPath, []);
      atomicWriteJson(summariesPath, []);
      return { processed: 0, skipped: true, skipReason: "disabled in config" };
    }

    // --- INTELLIGENT MODE (provider configured) ---
    if (enrichConfig.provider) {
      const { runFullEnrichment } = await import("../enrich/orchestrator.js");
      const result = await runFullEnrichment({
        config,
        outputDir,
        configDir,
        providerRegistry: ctx.providerRegistry,
      });
      return { processed: result.totalLlmCalls, skipped: false };
    }

    // --- ALGORITHMIC MODE (no provider) ---
    const graphRaw = readFileSync(graphJsonPath, "utf-8");
    const graphData = JSON.parse(graphRaw) as GraphData;
    const edgeCounts = computeEdgeCounts(graphData);
    const descriptions = buildNodeDescriptions(graphData, edgeCounts, enrichConfig.threshold);
    const summaries = buildCommunitySummaries(graphData, enrichConfig.max_communities);

    copyFileSync(graphJsonPath, graphEnrichedPath);
    atomicWriteJson(descriptionsPath, descriptions);
    atomicWriteJson(summariesPath, summaries);

    return { processed: descriptions.length + summaries.length, skipped: false };
  }
}

function buildNodeDescriptions(graphData: GraphData, edgeCounts: Map<string, number>, threshold: number): NodeDescription[] {
  const targetNodes = selectTargetNodes(graphData.nodes, edgeCounts, threshold);
  return targetNodes.map((node) => ({
    id: node.id,
    description: algorithmicDescription(node, edgeCounts.get(node.id) ?? 0),
  }));
}

function buildCommunitySummaries(graphData: GraphData, maxCommunities: number): CommunitySummary[] {
  return buildCommunityData(graphData, maxCommunities).map((community) => {
    const hubs = findHubs(community.nodes);
    const primaryPath = findPrimaryPath(community.nodes);
    const repos = [...new Set(community.nodes.filter((node) => node.repo).map((node) => node.repo!))];

    return {
      id: community.id,
      label: `Community ${community.id}`,
      nodeCount: community.nodes.length,
      summary: buildAlgorithmicSummary(community.nodes.length, hubs, primaryPath, repos),
      hub_nodes: hubs.map((node) => node.label),
      primary_path: primaryPath,
      repos,
    };
  });
}

export const enrichPhase = new EnrichPhase();
