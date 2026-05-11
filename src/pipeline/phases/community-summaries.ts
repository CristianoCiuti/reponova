/**
 * community-summaries phase — generates natural-language community summaries.
 *
 * Uses per-community content fingerprinting for incremental regeneration.
 * Config invalidation via .cache/community-summaries-config-hash.txt.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Phase, PhaseContext, PhaseResult } from "../engine/phase.js";
import type { GraphData, GraphNode } from "../../shared/types.js";
import { atomicWriteJson, atomicWriteText } from "../../shared/atomic-write.js";
import { readJsonOr } from "../../shared/fs.js";
import { log, errorMessage } from "../../shared/utils.js";
import {
  CommunitySummaryGenerator,
  type CommunityData,
  type CommunitySummary,
} from "../../intelligence/community-summary-generator.js";

export const communitySummariesPhase: Phase = {
  id: "community-summaries",
  label: "Community Summaries",
  dependencies: ["communities"],

  async execute(ctx: PhaseContext): Promise<PhaseResult> {
    const { config, outputDir, force } = ctx;
    const startedAt = new Date();
    ctx.manifest.record(this.id, { status: "running", startedAt: startedAt.toISOString(), finishedAt: null, durationMs: null });
    log.info(`  [${this.id}] ${this.label}...`);

    try {
      const csConfig = config.community_summaries;
      const summariesPath = join(outputDir, "community_summaries.json");
      const cachePath = join(outputDir, ".cache", "community-summary-fingerprints.json");
      const configHashPath = join(outputDir, ".cache", "community-summaries-config-hash.txt");

      if (!csConfig.enabled) {
        removeFile(summariesPath);
        removeFile(cachePath);
        removeFile(configHashPath);
        const finishedAt = new Date();
        const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
        ctx.manifest.record(this.id, { status: "skipped", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
        log.info(`  [${this.id}] Skipped: disabled in config (${elapsed}s)`);
        return { processed: 0, skipped: true, skipReason: "disabled in config" };
      }

      // Config invalidation
      const currentConfigHash = hashConfigFields(csConfig.provider);
      const configChanged = checkConfigChanged(configHashPath, currentConfigHash);
      const effectiveForce = force || configChanged;

      const graphJsonPath = join(outputDir, "graph.json");
      const graphData = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as GraphData;
      const communities = buildCommunityData(graphData, csConfig.max_number);

      if (communities.length === 0) {
        atomicWriteJson(summariesPath, []);
        atomicWriteJson(cachePath, {});
        atomicWriteText(configHashPath, currentConfigHash);
        const finishedAt = new Date();
        const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
        ctx.manifest.record(this.id, { status: "skipped", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
        log.info(`  [${this.id}] Skipped: no qualifying communities (${elapsed}s)`);
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
        const existing = loadExistingSummaries(summariesPath);
        if (!arraysEqual(existing, keptSummaries)) {
          const cache = buildFingerprintCache(communities, keptSummaries);
          atomicWriteJson(summariesPath, keptSummaries);
          atomicWriteJson(cachePath, cache);
        }
        atomicWriteText(configHashPath, currentConfigHash);
        const finishedAt = new Date();
        const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
        ctx.manifest.record(this.id, { status: "skipped", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
        log.info(`  [${this.id}] Skipped: up to date (${elapsed}s)`);
        return { processed: 0, skipped: true, skipReason: "up to date" };
      }

      const llm = await ctx.providerRegistry.acquireLlm(csConfig.provider);
      if (csConfig.provider && !llm) {
        log.info("  Community summaries LLM not available — using algorithmic");
      }

      const generator = new CommunitySummaryGenerator(csConfig, llm);
      const generated = await generator.generate(regenCommunities);
      const generatedById = new Map(generated.map((s) => [s.id, s]));

      const allSummaries = communities
        .map((c) => keptSummaries.find((s) => s.id === c.id) ?? generatedById.get(c.id))
        .filter((s): s is CommunitySummary => s != null);

      const cache = buildFingerprintCache(communities, allSummaries);
      atomicWriteJson(summariesPath, allSummaries);
      atomicWriteJson(cachePath, cache);
      atomicWriteText(configHashPath, currentConfigHash);

      const result: PhaseResult = { processed: generated.length, skipped: false };
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

function buildCommunityData(graphData: GraphData, maxNumber: number): CommunityData[] {
  const communityMap = new Map<string, GraphNode[]>();
  for (const node of graphData.nodes) {
    const communityId = node.community != null ? String(node.community) : "unclustered";
    if (!communityMap.has(communityId)) communityMap.set(communityId, []);
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
  const nodeHashes = nodes.map((node) => {
    const input = [node.id, node.label, node.type, node.signature ?? "", node.docstring ?? "", node.source_file ?? ""].join("|");
    return createHash("sha256").update(input).digest("hex");
  }).sort();
  return createHash("sha256").update(nodeHashes.join(",")).digest("hex");
}

function hashConfigFields(provider?: string): string {
  return createHash("sha256").update(JSON.stringify({ provider: provider ?? null })).digest("hex");
}

function checkConfigChanged(hashPath: string, currentHash: string): boolean {
  if (!existsSync(hashPath)) return false;
  try {
    return readFileSync(hashPath, "utf-8").trim() !== currentHash;
  } catch {
    return false;
  }
}

function loadFingerprintCache(path: string): Record<string, CommunitySummary> {
  return readJsonOr<Record<string, CommunitySummary>>(path, {});
}

function buildFingerprintCache(communities: CommunityData[], summaries: CommunitySummary[]): Record<string, CommunitySummary> {
  const summaryById = new Map(summaries.map((s) => [s.id, s]));
  const cache: Record<string, CommunitySummary> = {};
  for (const c of communities) {
    const s = summaryById.get(c.id);
    if (s) cache[computeCommunityFingerprint(c.nodes)] = s;
  }
  return cache;
}

function loadExistingSummaries(path: string): CommunitySummary[] {
  return readJsonOr<CommunitySummary[]>(path, []);
}

function arraysEqual(a: CommunitySummary[], b: CommunitySummary[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function removeFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
