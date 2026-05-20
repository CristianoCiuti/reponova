/**
 * html phase — generates interactive HTML visualizations.
 *
 * Loads graph from graph-enriched.json via loadGraphAsGraphology.
 */
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Phase, PhaseContext, PhaseResult } from "../engine/phase.js";
import { htmlContract } from "../cache/contracts/html.js";
import { checkPhaseCache, sealPhaseCache } from "../cache/contract.js";
import { loadGraphAsGraphology } from "../../graph/graphology.js";
import { detectCommunities } from "../../graph/community.js";
import { exportHtml, exportCommunityHtml, type CommunitySummaryInfo } from "../../graph/export-html.js";
import { readJsonSafe } from "../../shared/fs.js";
import { log, errorMessage } from "../../shared/utils.js";

export const htmlPhase: Phase = {
  id: "html",
  label: "HTML Visualizations",
  dependencies: ["enrich"],

  async execute(ctx: PhaseContext): Promise<PhaseResult> {
    const cached = checkPhaseCache(ctx, htmlContract);
    if (cached) return cached;

    const startedAt = new Date();
    ctx.manifest.record(this.id, { status: "running", startedAt: startedAt.toISOString(), finishedAt: null, durationMs: null });
    log.info(`  [${this.id}] ${this.label}...`);

    try {
      const { config, outputDir } = ctx;
      const htmlPath = join(outputDir, "graph.html");
      const communityHtmlPath = join(outputDir, "graph_communities.html");
      const graphJsonPath = join(outputDir, "graph-enriched.json");
      const inputHashPath = join(outputDir, ".cache", "html-input-hash.txt");
      const configHashPath = join(outputDir, ".cache", "html-config-hash.txt");

      if (!config.html) {
        removeFile(htmlPath);
        removeFile(communityHtmlPath);
        removeFile(inputHashPath);
        removeFile(configHashPath);
        const finishedAt = new Date();
        const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
        ctx.manifest.record(this.id, { status: "skipped", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
        log.info(`  [${this.id}] Skipped: disabled in config (${elapsed}s)`);
        return { processed: 0, skipped: true, skipReason: "disabled in config" };
      }

      // Load graph from filesystem
      const graph = loadGraphAsGraphology(graphJsonPath);
      const communities = detectCommunities(graph);
      const communitySummaries = loadCommunitySummaries(outputDir);

      exportHtml({
        graph,
        communities,
        outputPath: htmlPath,
        minDegree: config.html_min_degree,
        communitySummaries,
      });

      exportCommunityHtml({
        graph,
        communities,
        outputPath: communityHtmlPath,
        communitySummaries,
      });

      const result: PhaseResult = { processed: 2, skipped: false };
      const finishedAt = new Date();
      const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
      ctx.manifest.record(this.id, { status: "completed", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
      log.info(`  [${this.id}] Done: ${result.processed} processed (${elapsed}s)`);

      sealPhaseCache(ctx, htmlContract);
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

function loadCommunitySummaries(outputDir: string): CommunitySummaryInfo[] | undefined {
  const summariesPath = join(outputDir, "community_summaries.json");
  return readJsonSafe<CommunitySummaryInfo[]>(summariesPath);
}

function removeFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
