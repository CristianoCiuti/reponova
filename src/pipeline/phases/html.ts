/**
 * html phase — generates interactive HTML visualizations.
 *
 * Loads graph from graph.json via loadGraphAsGraphology (filesystem, no in-memory passing).
 * Skip logic: mtime comparison of inputs vs outputs.
 * Config invalidation: html toggle and html_min_degree.
 */
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Phase, PhaseContext, PhaseResult } from "../engine/phase.js";
import { loadGraphAsGraphology } from "../../graph/graphology.js";
import { detectCommunities } from "../../graph/community.js";
import { exportHtml, exportCommunityHtml, type CommunitySummaryInfo } from "../../graph/export-html.js";
import { atomicWriteText } from "../../shared/atomic-write.js";
import { readJsonSafe } from "../../shared/fs.js";
import { log, errorMessage } from "../../shared/utils.js";

export const htmlPhase: Phase = {
  id: "html",
  label: "HTML Visualizations",
  dependencies: ["community-summaries", "node-descriptions"],

  async execute(ctx: PhaseContext): Promise<PhaseResult> {
    const startedAt = new Date();
    ctx.manifest.record(this.id, { status: "running", startedAt: startedAt.toISOString(), finishedAt: null, durationMs: null });
    log.info(`  [${this.id}] ${this.label}...`);

    try {
      const { config, outputDir, force } = ctx;
      const htmlPath = join(outputDir, "graph.html");
      const communityHtmlPath = join(outputDir, "graph_communities.html");
      const graphJsonPath = join(outputDir, "graph.json");
      const summariesPath = join(outputDir, "community_summaries.json");
      const descriptionsPath = join(outputDir, "node_descriptions.json");
      const configHashPath = join(outputDir, ".cache", "html-config-hash.txt");

      if (!config.html) {
        removeFile(htmlPath);
        removeFile(communityHtmlPath);
        removeFile(configHashPath);
        const finishedAt = new Date();
        const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
        ctx.manifest.record(this.id, { status: "skipped", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
        log.info(`  [${this.id}] Skipped: disabled in config (${elapsed}s)`);
        return { processed: 0, skipped: true, skipReason: "disabled in config" };
      }

      // Config invalidation: regenerate if html_min_degree changed
      const currentConfigHash = hashHtmlConfig(config.html_min_degree);
      const configChanged = checkConfigChanged(configHashPath, currentConfigHash);
      const effectiveForce = force || configChanged;

      if (!shouldRun(graphJsonPath, summariesPath, descriptionsPath, htmlPath, communityHtmlPath, effectiveForce)) {
        const finishedAt = new Date();
        const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
        ctx.manifest.record(this.id, { status: "skipped", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
        log.info(`  [${this.id}] Skipped: up to date (${elapsed}s)`);
        return { processed: 0, skipped: true, skipReason: "up to date" };
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

      atomicWriteText(configHashPath, currentConfigHash);

      const result: PhaseResult = { processed: 2, skipped: false };
      const finishedAt = new Date();
      const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
      ctx.manifest.record(this.id, { status: "completed", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
      log.info(`  [${this.id}] Done: ${result.processed} processed (${elapsed}s)`);

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

function shouldRun(
  graphJsonPath: string,
  summariesPath: string,
  descriptionsPath: string,
  htmlPath: string,
  communityHtmlPath: string,
  force: boolean,
): boolean {
  if (force) return true;
  if (!existsSync(htmlPath) || !existsSync(communityHtmlPath)) return true;

  const outputMtime = Math.min(
    statSync(htmlPath).mtimeMs,
    statSync(communityHtmlPath).mtimeMs,
  );

  let inputMtime = existsSync(graphJsonPath) ? statSync(graphJsonPath).mtimeMs : 0;
  if (existsSync(summariesPath)) inputMtime = Math.max(inputMtime, statSync(summariesPath).mtimeMs);
  if (existsSync(descriptionsPath)) inputMtime = Math.max(inputMtime, statSync(descriptionsPath).mtimeMs);

  return inputMtime > outputMtime;
}

function loadCommunitySummaries(outputDir: string): CommunitySummaryInfo[] | undefined {
  const summariesPath = join(outputDir, "community_summaries.json");
  return readJsonSafe<CommunitySummaryInfo[]>(summariesPath);
}

function removeFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function hashHtmlConfig(minDegree?: number): string {
  return createHash("sha256").update(JSON.stringify({ html_min_degree: minDegree ?? null })).digest("hex");
}

function checkConfigChanged(hashPath: string, currentHash: string): boolean {
  if (!existsSync(hashPath)) return true;
  try { return readFileSync(hashPath, "utf-8").trim() !== currentHash; }
  catch { return true; }
}
