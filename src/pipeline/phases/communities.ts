/**
 * communities phase — runs Louvain community detection.
 *
 * Loads graph-nodes.json into graphology, runs Louvain, writes graph.json
 * (the canonical graph file with community assignments for all downstream phases).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Phase, PhaseContext, PhaseResult } from "../engine/phase.js";
import { communitiesContract } from "../cache/contracts/communities.js";
import { checkPhaseCache, sealPhaseCache } from "../cache/contract.js";
import { loadGraphAsGraphology } from "../../graph/graphology.js";
import { detectCommunities } from "../../graph/community.js";
import { exportJson } from "../../graph/export-json.js";
import { log, errorMessage } from "../../shared/utils.js";

export const communitiesPhase: Phase = {
  id: "communities",
  label: "Community Detection",
  dependencies: ["graph"],

  async execute(ctx: PhaseContext): Promise<PhaseResult> {
    const cached = checkPhaseCache(ctx, communitiesContract);
    if (cached) return cached;

    const startedAt = new Date();
    ctx.manifest.record(this.id, { status: "running", startedAt: startedAt.toISOString(), finishedAt: null, durationMs: null });
    log.info(`  [${this.id}] ${this.label}...`);

    try {
      const { config, outputDir } = ctx;
      const graphNodesPath = join(outputDir, "graph-nodes.json");
      const graphJsonPath = join(outputDir, "graph.json");

      if (!existsSync(graphNodesPath)) {
        throw new Error("graph-nodes.json not found — graph phase must run first");
      }

      // Load graph, run Louvain, export
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

      const result: PhaseResult = { processed: communities.count, skipped: false };
      const finishedAt = new Date();
      const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
      ctx.manifest.record(this.id, { status: "completed", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
      log.info(`  [${this.id}] Done: ${result.processed} processed (${elapsed}s)`);

      sealPhaseCache(ctx, communitiesContract);
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
