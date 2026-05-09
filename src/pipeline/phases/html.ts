/**
 * html phase — generates interactive HTML visualizations.
 *
 * Loads graph from graph.json via loadGraphAsGraphology (filesystem, no in-memory passing).
 * Skip logic: mtime comparison of inputs vs outputs.
 * Config invalidation: html toggle and html_min_degree.
 */
import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Phase, PhaseContext, PhaseResult } from "../engine/phase.js";
import { loadGraphAsGraphology } from "../../graph/graphology.js";
import { detectCommunities } from "../../graph/community.js";
import { exportHtml, exportCommunityHtml, type CommunitySummaryInfo } from "../../graph/export-html.js";
import { readJsonSafe } from "../../shared/fs.js";

export const htmlPhase: Phase = {
  id: "html",
  label: "HTML Visualizations",
  dependencies: ["community-summaries", "node-descriptions"],

  async execute(ctx: PhaseContext): Promise<PhaseResult> {
    const { config, outputDir, force } = ctx;
    const htmlPath = join(outputDir, "graph.html");
    const communityHtmlPath = join(outputDir, "graph_communities.html");
    const graphJsonPath = join(outputDir, "graph.json");
    const summariesPath = join(outputDir, "community_summaries.json");
    const descriptionsPath = join(outputDir, "node_descriptions.json");

    if (!config.html) {
      removeFile(htmlPath);
      removeFile(communityHtmlPath);
      return { processed: 0, skipped: true, skipReason: "disabled in config" };
    }

    if (!shouldRun(graphJsonPath, summariesPath, descriptionsPath, htmlPath, communityHtmlPath, force)) {
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
    });

    exportCommunityHtml({
      graph,
      communities,
      outputPath: communityHtmlPath,
      communitySummaries,
    });

    return { processed: 2, skipped: false };
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
