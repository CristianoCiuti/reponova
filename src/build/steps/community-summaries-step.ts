/**
 * Incremental community summaries step.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../../shared/atomic-write.js";
import { log } from "../../shared/utils.js";
import type { GraphData, GraphNode } from "../../shared/types.js";
import type { BuildStep, StepContext, StepResult } from "../types.js";
import {
  CommunitySummaryGenerator,
  type CommunityData,
  type CommunitySummary,
} from "../intelligence/community-summary-generator.js";

export const runCommunitySummariesStep: BuildStep = async (ctx: StepContext): Promise<StepResult> => {
  const config = ctx.config.build.community_summaries;
  const summariesPath = join(ctx.outputDir, "community_summaries.json");
  const cachePath = join(ctx.outputDir, ".cache", "community-summary-fingerprints.json");

  if (!config.enabled) {
    removeFile(summariesPath);
    removeFile(cachePath);
    return { processed: 0, skipped: true, skipReason: "disabled in config" };
  }

  const previous = ctx.previousConfig?.community_summaries;
  const modelChanged = previous != null && (previous.model ?? null) !== (config.model ?? null);
  const contextSizeChanged = previous != null && previous.context_size !== config.context_size;
  const effectiveForce = ctx.force || modelChanged || ((config.model ?? null) != null && contextSizeChanged);

  const graphData = JSON.parse(readFileSync(ctx.graphJsonPath, "utf-8")) as GraphData;
  const communities = buildCommunityData(graphData, config.max_number);
  if (communities.length === 0) {
    atomicWriteJson(summariesPath, []);
    atomicWriteJson(cachePath, {});
    return { processed: 0, skipped: true, skipReason: "no qualifying communities" };
  }

  const previousCache = effectiveForce ? {} : loadFingerprintCache(cachePath);
  const keptSummaries: CommunitySummary[] = [];
  const regenCommunities: CommunityData[] = [];

  for (const community of communities) {
    const fingerprint = computeCommunityFingerprint(community.nodes);
    const cached = previousCache[fingerprint];
    if (cached) {
      keptSummaries.push({ ...cached, id: community.id });
    } else {
      regenCommunities.push(community);
    }
  }

  if (regenCommunities.length === 0) {
    // IDs may have been remapped — only write if output would differ
    const existing = loadExistingSummaries(summariesPath);
    if (!arraysEqual(existing, keptSummaries)) {
      const cache = buildFingerprintCache(communities, keptSummaries);
      atomicWriteJson(summariesPath, keptSummaries);
      atomicWriteJson(cachePath, cache);
    }
    return { processed: 0, skipped: true, skipReason: "up to date" };
  }

  const modelUri = config.model ?? null;
  let llm = null;
  if (modelUri && ctx.llmPool) {
    llm = await ctx.llmPool.acquire(modelUri, config.context_size);
    if (!llm) {
      log.info("  Community summaries LLM not available — using algorithmic");
    }
  }

  const generator = new CommunitySummaryGenerator(config, llm);
  const generated = await generator.generate(regenCommunities);
  const generatedById = new Map(generated.map((summary) => [summary.id, summary]));

  const allSummaries = communities.map((community) => {
    const kept = keptSummaries.find((summary) => summary.id === community.id);
    return kept ?? generatedById.get(community.id);
  }).filter((summary): summary is CommunitySummary => summary != null);

  const cache = buildFingerprintCache(communities, allSummaries);
  atomicWriteJson(summariesPath, allSummaries);
  atomicWriteJson(cachePath, cache);

  return { processed: generated.length, skipped: false };
};

function buildCommunityData(graphData: GraphData, maxNumber: number): CommunityData[] {
  const communityMap = new Map<string, GraphNode[]>();

  for (const node of graphData.nodes) {
    const communityId = node.community != null ? String(node.community) : "unclustered";
    if (!communityMap.has(communityId)) {
      communityMap.set(communityId, []);
    }
    communityMap.get(communityId)!.push(node);
  }

  const communities: CommunityData[] = [];
  for (const [id, nodes] of communityMap) {
    if (id === "unclustered" || nodes.length < 3) continue;
    communities.push({ id, nodes });
  }

  communities.sort((a, b) => b.nodes.length - a.nodes.length || String(a.id).localeCompare(String(b.id)));
  return maxNumber > 0 ? communities.slice(0, maxNumber) : communities;
}

function computeCommunityFingerprint(nodes: GraphNode[]): string {
  const nodeHashes = nodes.map(computeNodeHash).sort();
  return createHash("sha256").update(nodeHashes.join(",")).digest("hex");
}

function computeNodeHash(node: GraphNode): string {
  const input = [
    node.id,
    node.label,
    node.type,
    node.signature ?? "",
    node.docstring ?? "",
    node.source_file ?? "",
  ].join("|");
  return createHash("sha256").update(input).digest("hex");
}

function loadFingerprintCache(path: string): Record<string, CommunitySummary> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, CommunitySummary>;
  } catch {
    return {};
  }
}

function buildFingerprintCache(
  communities: CommunityData[],
  summaries: CommunitySummary[],
): Record<string, CommunitySummary> {
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  const cache: Record<string, CommunitySummary> = {};

  for (const community of communities) {
    const summary = summaryById.get(community.id);
    if (!summary) continue;
    cache[computeCommunityFingerprint(community.nodes)] = summary;
  }

  return cache;
}

function removeFile(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function loadExistingSummaries(path: string): CommunitySummary[] {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as CommunitySummary[];
  } catch {
    return [];
  }
}

function arraysEqual(a: CommunitySummary[], b: CommunitySummary[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
