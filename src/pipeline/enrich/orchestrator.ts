/**
 * All-in-one orchestrator for the intelligent enrichment pipeline (Steps 0-7).
 *
 * Handles resumption: checks which final files already exist and skips completed steps.
 * Called from both the enrich phase (during `build`) and the standalone `enrich` CLI command.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config, GraphData } from "../../shared/types.js";
import type { ProviderRegistry } from "../../intelligence/provider-registry.js";
import { log } from "../../shared/utils.js";
import { atomicWriteJson } from "../../shared/atomic-write.js";
import { runMetrics } from "./metrics.js";
import { runMerge } from "./merge.js";
import { runApply } from "./apply.js";
import { runFinalize } from "./finalize.js";
import { packBatches } from "./batcher.js";
import { buildDescriptionPrompt, buildProfilePrompt, buildRoutingPrompt, buildRestructurePrompt } from "./prompts.js";
import { executeBatches, executeSingle, parseLlmJson, type BatchJob, type ExecutorConfig } from "./llm-executor.js";
import type { CommunityProfile, DescriptionEntry, RoutingDecision, RestructureFile } from "./types.js";

export interface EnrichOrchestratorOptions {
  config: Config;
  outputDir: string;
  configDir: string;
  providerRegistry: ProviderRegistry;
}

/**
 * Full enrichment pipeline (Steps 0-7).
 * Handles resumption: checks which final files already exist and skips completed steps.
 */
export async function runFullEnrichment(options: EnrichOrchestratorOptions): Promise<{ totalLlmCalls: number }> {
  const { config, outputDir, configDir, providerRegistry } = options;
  const enrichDir = join(outputDir, ".enrich");
  const enrichConfig = config.enrich;
  let totalLlmCalls = 0;

  if (!enrichConfig.provider) {
    throw new Error("enrich.provider is required for intelligent enrichment mode");
  }

  // Acquire LLM provider
  const provider = await providerRegistry.acquireLlm(enrichConfig.provider);
  if (!provider) {
    throw new Error(`Failed to acquire LLM provider "${enrichConfig.provider}". Check provider configuration.`);
  }

  const executorConfig: ExecutorConfig = {
    provider,
    concurrency: enrichConfig.concurrency,
    maxRetryDepth: enrichConfig.max_retry_depth,
  };

  // Step 0: Metrics
  log.info("  [enrich] Step 0: Computing graph metrics...");
  const metrics = runMetrics({ outputDir, candidateThreshold: enrichConfig.candidate_threshold });
  log.info(`  [enrich] Step 0 done: ${metrics.candidateCount}/${metrics.totalNodes} candidates`);

  // Step 1: Node descriptions
  if (!existsSync(join(enrichDir, "descriptions.json"))) {
    log.info("  [enrich] Step 1: Generating node descriptions...");
    const graphData = JSON.parse(readFileSync(join(outputDir, "graph.json"), "utf-8")) as GraphData;
    const repoRoots = resolveRepoRoots(config, configDir);
    const batches = packBatches(graphData.nodes, repoRoots, enrichConfig.description_batch_tokens);

    const outputStepDir = join(enrichDir, "output", "descriptions");
    const jobs: BatchJob<DescriptionEntry[]>[] = batches.map((batch) => ({
      batchId: batch.id,
      prompt: buildDescriptionPrompt(batch.items),
      outputPath: join(outputStepDir, `batch-${String(batch.id).padStart(3, "0")}.json`),
      parse: (raw) => parseLlmJson<DescriptionEntry[]>(raw),
    }));

    mkdirSync(outputStepDir, { recursive: true });
    const result = await executeBatches(executorConfig, jobs, outputStepDir);
    totalLlmCalls += result.completed + result.failed;
    log.info(`  [enrich] Step 1 done: ${result.completed} batches (${result.failed} failed)`);

    runMerge(outputDir, "descriptions");
  } else {
    log.info("  [enrich] Step 1: Skipped (descriptions.json exists)");
  }

  // Step 2: Community profiling
  if (!existsSync(join(enrichDir, "profiles.json"))) {
    log.info("  [enrich] Step 2: Profiling communities...");
    const graphData = JSON.parse(readFileSync(join(outputDir, "graph.json"), "utf-8")) as GraphData;
    const descriptions: DescriptionEntry[] = JSON.parse(readFileSync(join(enrichDir, "descriptions.json"), "utf-8"));
    const descMap = new Map(descriptions.map((d) => [d.id, d.description]));

    // Group nodes by community
    const communities = new Map<string, Array<{ id: string; description: string }>>();
    for (const node of graphData.nodes) {
      const comm = node.community ?? "unclustered";
      if (!communities.has(comm)) communities.set(comm, []);
      communities.get(comm)!.push({ id: node.id, description: descMap.get(node.id) ?? "" });
    }

    // Internal edges per community
    const commEdges = new Map<string, Array<{ source: string; target: string; type: string }>>();
    const nodeCommMap = new Map(graphData.nodes.map((n) => [n.id, n.community ?? "unclustered"]));
    for (const edge of graphData.edges) {
      const srcComm = nodeCommMap.get(edge.source);
      const tgtComm = nodeCommMap.get(edge.target);
      if (srcComm && tgtComm && srcComm === tgtComm) {
        if (!commEdges.has(srcComm)) commEdges.set(srcComm, []);
        commEdges.get(srcComm)!.push({ source: edge.source, target: edge.target, type: edge.type });
      }
    }

    const outputStepDir = join(enrichDir, "output", "profiles");
    const jobs: BatchJob<CommunityProfile>[] = [];
    let batchId = 0;
    for (const [commId, members] of communities) {
      if (commId === "unclustered" || members.length < 3) continue;
      batchId++;
      const edges = commEdges.get(commId) ?? [];
      jobs.push({
        batchId,
        prompt: buildProfilePrompt(commId, members, edges),
        outputPath: join(outputStepDir, `community-${String(batchId).padStart(3, "0")}.json`),
        parse: (raw) => parseLlmJson<CommunityProfile>(raw),
      });
    }

    mkdirSync(outputStepDir, { recursive: true });
    const result = await executeBatches(executorConfig, jobs, outputStepDir);
    totalLlmCalls += result.completed + result.failed;
    log.info(`  [enrich] Step 2 done: ${result.completed} communities profiled`);

    runMerge(outputDir, "profiles");
  } else {
    log.info("  [enrich] Step 2: Skipped (profiles.json exists)");
  }

  // Step 3: Candidate routing
  if (!existsSync(join(enrichDir, "routing.json"))) {
    log.info("  [enrich] Step 3: Routing candidates...");
    const candidates = JSON.parse(readFileSync(join(enrichDir, "candidates.json"), "utf-8")) as { candidates: Array<{ status: string; nodeId: string }> };
    const profiles: CommunityProfile[] = JSON.parse(readFileSync(join(enrichDir, "profiles.json"), "utf-8"));
    const descriptions: DescriptionEntry[] = JSON.parse(readFileSync(join(enrichDir, "descriptions.json"), "utf-8"));
    const profileMap = new Map(profiles.map((p) => [p.communityId, p]));
    const descMap = new Map(descriptions.map((d) => [d.id, d.description]));

    // Also add misfits from Step 2
    const allCandidateIds = new Set(
      candidates.candidates
        .filter((c) => c.status === "candidate")
        .map((c) => c.nodeId),
    );
    for (const p of profiles) {
      for (const misfit of p.misfits) {
        allCandidateIds.add(misfit.nodeId);
      }
    }

    // Build routing batches
    const graphData = JSON.parse(readFileSync(join(outputDir, "graph.json"), "utf-8")) as GraphData;
    const nodeCommMap = new Map(graphData.nodes.map((n) => [n.id, n.community ?? "unclustered"]));

    // Compute adjacent communities per candidate
    const nodeAdjacent = new Map<string, Map<string, number>>();
    for (const edge of graphData.edges) {
      for (const [src, tgt] of [[edge.source, edge.target], [edge.target, edge.source]] as [string, string][]) {
        if (allCandidateIds.has(src)) {
          const tgtComm = nodeCommMap.get(tgt) ?? "unclustered";
          const srcComm = nodeCommMap.get(src) ?? "unclustered";
          if (tgtComm !== srcComm) {
            if (!nodeAdjacent.has(src)) nodeAdjacent.set(src, new Map());
            const adj = nodeAdjacent.get(src)!;
            adj.set(tgtComm, (adj.get(tgtComm) ?? 0) + 1);
          }
        }
      }
    }

    // Build candidate list with context
    const candidateList = [...allCandidateIds].map((nodeId) => ({
      nodeId,
      description: descMap.get(nodeId) ?? "",
      currentCommunity: nodeCommMap.get(nodeId) ?? "unclustered",
      adjacentCommunities: [...(nodeAdjacent.get(nodeId)?.entries() ?? [])]
        .map(([id, count]) => ({ id, edgeCount: count }))
        .sort((a, b) => b.edgeCount - a.edgeCount)
        .slice(0, 5),
    }));

    const batchSize = enrichConfig.routing_batch_size;
    const outputStepDir = join(enrichDir, "output", "routing");
    const jobs: BatchJob<RoutingDecision[]>[] = [];
    for (let i = 0; i < candidateList.length; i += batchSize) {
      const batch = candidateList.slice(i, i + batchSize);
      const batchId = Math.floor(i / batchSize) + 1;
      jobs.push({
        batchId,
        prompt: buildRoutingPrompt(batch, profileMap),
        outputPath: join(outputStepDir, `batch-${String(batchId).padStart(3, "0")}.json`),
        parse: (raw) => parseLlmJson<RoutingDecision[]>(raw),
      });
    }

    mkdirSync(outputStepDir, { recursive: true });
    const result = await executeBatches(executorConfig, jobs, outputStepDir);
    totalLlmCalls += result.completed + result.failed;
    log.info(`  [enrich] Step 3 done: ${result.completed} batches (${allCandidateIds.size} candidates)`);

    runMerge(outputDir, "routing");
  } else {
    log.info("  [enrich] Step 3: Skipped (routing.json exists)");
  }

  // Step 4: Merge/Split detection
  if (!existsSync(join(enrichDir, "restructure.json"))) {
    log.info("  [enrich] Step 4: Detecting merges/splits...");
    const profiles: CommunityProfile[] = JSON.parse(readFileSync(join(enrichDir, "profiles.json"), "utf-8"));
    const edgeDensity = JSON.parse(readFileSync(join(enrichDir, "edge-density.json"), "utf-8")) as { pairs: Array<{ communityA: string; communityB: string; edgeCount: number }> };
    const routing: RoutingDecision[] = JSON.parse(readFileSync(join(enrichDir, "routing.json"), "utf-8"));

    // Compute which communities gained nodes
    const gainedNodes = new Map<string, number>();
    for (const r of routing) {
      if (r.action === "move" && r.to) {
        gainedNodes.set(r.to, (gainedNodes.get(r.to) ?? 0) + 1);
      }
    }

    // Size outliers: communities > 2x median size
    const graphData = JSON.parse(readFileSync(join(outputDir, "graph.json"), "utf-8")) as GraphData;
    const commSizes = new Map<string, number>();
    for (const node of graphData.nodes) {
      const c = node.community ?? "unclustered";
      commSizes.set(c, (commSizes.get(c) ?? 0) + 1);
    }
    const sizeValues = [...commSizes.values()].sort((a, b) => a - b);
    const median = sizeValues[Math.floor(sizeValues.length / 2)] ?? 10;
    const sizeOutliers = [...commSizes.entries()]
      .filter(([_, size]) => size > median * 2)
      .map(([id, size]) => ({ communityId: id, nodeCount: size }));

    const prompt = buildRestructurePrompt(
      profiles,
      edgeDensity.pairs.slice(0, 20),
      gainedNodes,
      sizeOutliers,
    );

    const raw = await executeSingle(executorConfig, prompt);
    const restructure = parseLlmJson<RestructureFile>(raw);
    totalLlmCalls++;

    atomicWriteJson(join(enrichDir, "restructure.json"), restructure);
    log.info(`  [enrich] Step 4 done: ${restructure.merges.length} merges, ${restructure.splits.length} splits`);
  } else {
    log.info("  [enrich] Step 4: Skipped (restructure.json exists)");
  }

  // Step 5: Apply decisions
  if (!existsSync(join(enrichDir, "graph-applied.json"))) {
    log.info("  [enrich] Step 5: Applying decisions...");
    const result = runApply(outputDir);
    log.info(`  [enrich] Step 5 done: ${result.moved} moved, ${result.merged} merged, ${result.split} split`);
  } else {
    log.info("  [enrich] Step 5: Skipped (graph-applied.json exists)");
  }

  // Step 6: Regenerate modified profiles
  if (!existsSync(join(enrichDir, "updated-profiles.json"))) {
    log.info("  [enrich] Step 6: Regenerating modified profiles...");
    const modified = JSON.parse(readFileSync(join(enrichDir, "modified-communities.json"), "utf-8")) as { created: string[]; modified: string[] };
    const allModified = new Set([...modified.created, ...modified.modified]);

    if (allModified.size === 0) {
      atomicWriteJson(join(enrichDir, "updated-profiles.json"), []);
      log.info("  [enrich] Step 6 done: no communities modified");
    } else {
      const graphApplied = JSON.parse(readFileSync(join(enrichDir, "graph-applied.json"), "utf-8")) as GraphData;
      const descriptions: DescriptionEntry[] = JSON.parse(readFileSync(join(enrichDir, "descriptions.json"), "utf-8"));
      const descMap = new Map(descriptions.map((d) => [d.id, d.description]));
      const nodeCommMap = new Map(graphApplied.nodes.map((n) => [n.id, n.community ?? "unclustered"]));

      const outputStepDir = join(enrichDir, "output", "updated-profiles");
      const jobs: BatchJob<CommunityProfile>[] = [];
      let batchId = 0;
      for (const commId of allModified) {
        const members = graphApplied.nodes
          .filter((n) => (n.community ?? "unclustered") === commId)
          .map((n) => ({ id: n.id, description: descMap.get(n.id) ?? "" }));
        if (members.length < 3) continue;

        batchId++;
        const commEdges = graphApplied.edges
          .filter((e) => {
            const srcComm = nodeCommMap.get(e.source);
            const tgtComm = nodeCommMap.get(e.target);
            return srcComm === commId && tgtComm === commId;
          })
          .map((e) => ({ source: e.source, target: e.target, type: e.type }));

        jobs.push({
          batchId,
          prompt: buildProfilePrompt(commId, members, commEdges),
          outputPath: join(outputStepDir, `community-${String(batchId).padStart(3, "0")}.json`),
          parse: (raw) => parseLlmJson<CommunityProfile>(raw),
        });
      }

      mkdirSync(outputStepDir, { recursive: true });
      const result = await executeBatches(executorConfig, jobs, outputStepDir);
      totalLlmCalls += result.completed + result.failed;
      log.info(`  [enrich] Step 6 done: ${result.completed} profiles regenerated`);

      runMerge(outputDir, "updated-profiles");
    }
  } else {
    log.info("  [enrich] Step 6: Skipped (updated-profiles.json exists)");
  }

  // Step 7: Finalize
  log.info("  [enrich] Step 7: Finalizing...");
  runFinalize(outputDir);
  log.info("  [enrich] Step 7 done: final files written");

  return { totalLlmCalls };
}

function resolveRepoRoots(config: Config, configDir: string): Map<string, string> {
  const roots = new Map<string, string>();
  for (const repo of config.repos) {
    roots.set(repo.name, resolve(configDir, repo.path));
  }
  return roots;
}
