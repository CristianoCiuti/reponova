/**
 * enrich phase — generates graph-enriched.json, node descriptions, and community summaries.
 *
 * Algorithmic mode only in M1.
 * Contract handles coarse cache checks; phase keeps business logic for disabled mode.
 */
import { copyFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Phase, PhaseContext, PhaseResult } from "../engine/phase.js";
import { enrichContract } from "../cache/contracts/enrich.js";
import { checkPhaseCache, sealPhaseCache } from "../cache/contract.js";
import type { GraphData } from "../../shared/types.js";
import { atomicWriteJson } from "../../shared/atomic-write.js";
import { log, errorMessage } from "../../shared/utils.js";
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

export const enrichPhase: Phase = {
  id: "enrich",
  label: "Enrich",
  dependencies: ["communities"],

  async execute(ctx: PhaseContext): Promise<PhaseResult> {
    const cached = checkPhaseCache(ctx, enrichContract);
    if (cached) return cached;

    const { config, outputDir } = ctx;
    const startedAt = new Date();
    ctx.manifest.record(this.id, { status: "running", startedAt: startedAt.toISOString(), finishedAt: null, durationMs: null });
    log.info(`  [${this.id}] ${this.label}...`);

    try {
      const enrichConfig = config.enrich;
      const graphJsonPath = join(outputDir, "graph.json");
      const graphEnrichedPath = join(outputDir, "graph-enriched.json");
      const descriptionsPath = join(outputDir, "node_descriptions.json");
      const summariesPath = join(outputDir, "community_summaries.json");
      const inputHashPath = join(outputDir, ".cache", "enrich-input-hash.txt");
      const configHashPath = join(outputDir, ".cache", "enrich-config-hash.txt");

      if (!enrichConfig.enabled) {
        removeFile(graphEnrichedPath);
        removeFile(descriptionsPath);
        removeFile(summariesPath);
        removeFile(inputHashPath);
        removeFile(configHashPath);
        const finishedAt = new Date();
        const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
        ctx.manifest.record(this.id, { status: "skipped", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
        log.info(`  [${this.id}] Skipped: disabled in config (${elapsed}s)`);
        return { processed: 0, skipped: true, skipReason: "disabled in config" };
      }

      const graphRaw = readFileSync(graphJsonPath, "utf-8");
      const graphData = JSON.parse(graphRaw) as GraphData;
      const edgeCounts = computeEdgeCounts(graphData);
      const descriptions = buildNodeDescriptions(graphData, edgeCounts, enrichConfig.threshold);
      const summaries = buildCommunitySummaries(graphData, enrichConfig.max_communities);

      copyFileSync(graphJsonPath, graphEnrichedPath);
      atomicWriteJson(descriptionsPath, descriptions);
      atomicWriteJson(summariesPath, summaries);

      const result: PhaseResult = { processed: descriptions.length + summaries.length, skipped: false };
      const finishedAt = new Date();
      const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
      ctx.manifest.record(this.id, { status: "completed", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
      log.info(`  [${this.id}] Done: ${result.processed} processed (${elapsed}s)`);

      sealPhaseCache(ctx, enrichContract);
      return result;
    } catch (err) {
      const finishedAt = new Date();
      const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
      const message = errorMessage(err);
      ctx.manifest.record(this.id, { status: "failed", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
      log.warn(`  [${this.id}] Failed: ${message} (${elapsed}s)`);
      return { processed: 0, skipped: true, skipReason: `error: ${message}` };
    }
  },
};

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

function removeFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
