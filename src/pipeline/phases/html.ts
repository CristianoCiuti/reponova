/**
 * html phase — generates interactive HTML visualizations.
 *
 * Loads graph from graph-enriched.json via loadGraphAsGraphology.
 */
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../shared/types.js";
import { loadGraphAsGraphology } from "../../graph/graphology.js";
import { detectCommunities } from "../../graph/community.js";
import { exportHtml, exportCommunityHtml, type CommunitySummaryInfo } from "../../graph/export-html.js";
import { readJsonSafe } from "../../shared/fs.js";
import { BasePhase, type PhaseContext, type PhaseResult } from "../engine/phase.js";

class HtmlPhase extends BasePhase {
  readonly id = "html";
  readonly label = "HTML Visualizations";
  readonly dependencies = ["enrich"];
  readonly inputs = ["graph-enriched.json"];

  getExpectedOutputs(_config: Config): { files: string[]; dirs: string[] } {
    return { files: ["graph.html", "graph_communities.html"], dirs: [] };
  }

  getRelevantConfig(config: Config): object {
    return { html: config.html, html_min_degree: config.html_min_degree };
  }

  async doWork(ctx: PhaseContext): Promise<PhaseResult> {
    const { config, outputDir } = ctx;
    const htmlPath = join(outputDir, "graph.html");
    const communityHtmlPath = join(outputDir, "graph_communities.html");
    const graphJsonPath = join(outputDir, "graph-enriched.json");

    if (!config.html) {
      removeFile(htmlPath);
      removeFile(communityHtmlPath);
      return { processed: 0, skipped: true, skipReason: "disabled in config" };
    }

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

    return { processed: 2, skipped: false };
  }
}

function loadCommunitySummaries(outputDir: string): CommunitySummaryInfo[] | undefined {
  const summariesPath = join(outputDir, "community_summaries.json");
  return readJsonSafe<CommunitySummaryInfo[]>(summariesPath);
}

function removeFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

export const htmlPhase = new HtmlPhase();
