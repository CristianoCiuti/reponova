import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { exportHtml, exportCommunityHtml, type CommunitySummaryInfo } from "../../extract/export-html.js";
import type { BuildStep } from "../types.js";

export const runHtmlStep: BuildStep = async (ctx) => {
  if (!ctx.config.build.html) {
    return { processed: 0, skipped: true, skipReason: "disabled in config" };
  }

  const htmlPath = join(ctx.outputDir, "graph.html");
  const communityHtmlPath = join(ctx.outputDir, "graph_communities.html");
  const summariesPath = join(ctx.outputDir, "community_summaries.json");

  if (!shouldRunHtml(ctx.graphJsonPath, htmlPath, communityHtmlPath, summariesPath, ctx.force)) {
    return { processed: 0, skipped: true, skipReason: "up to date" };
  }

  if (!ctx.graph || !ctx.communities) {
    throw new Error("HTML step requires graph and communities in StepContext");
  }

  const communitySummaries = loadCommunitySummaries(ctx.outputDir);
  exportHtml({
    graph: ctx.graph,
    communities: ctx.communities,
    outputPath: htmlPath,
    minDegree: ctx.config.build.html_min_degree,
  });
  exportCommunityHtml({
    graph: ctx.graph,
    communities: ctx.communities,
    outputPath: communityHtmlPath,
    communitySummaries,
  });

  return { processed: 2, skipped: false };
};

function shouldRunHtml(
  graphJsonPath: string,
  htmlPath: string,
  communityHtmlPath: string,
  summariesPath: string,
  force: boolean,
): boolean {
  if (force) return true;
  if (!existsSync(htmlPath) || !existsSync(communityHtmlPath)) return true;
  if (statSync(graphJsonPath).mtimeMs > statSync(htmlPath).mtimeMs) return true;
  return existsSync(summariesPath) && statSync(summariesPath).mtimeMs > statSync(communityHtmlPath).mtimeMs;
}

function loadCommunitySummaries(outputDir: string): CommunitySummaryInfo[] | undefined {
  const summariesPath = join(outputDir, "community_summaries.json");
  if (!existsSync(summariesPath)) return undefined;

  try {
    return JSON.parse(readFileSync(summariesPath, "utf-8")) as CommunitySummaryInfo[];
  } catch {
    return undefined;
  }
}
