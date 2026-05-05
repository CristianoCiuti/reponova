/**
 * Community summaries step — generates natural-language summaries for graph communities.
 *
 * Orchestrates:
 * 1. Load graph data
 * 2. Build community data (group nodes, filter small communities)
 * 3. Acquire LLM from pool (if model configured)
 * 4. Run CommunitySummaryGenerator
 * 5. Write community_summaries.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../shared/utils.js";
import type { Config, GraphData, GraphNode } from "../../shared/types.js";
import { CommunitySummaryGenerator, type CommunityData } from "../intelligence/community-summary-generator.js";
import type { LlmEnginePool } from "../intelligence/llm-engine-pool.js";

/**
 * Run the community summaries step.
 * Returns the number of summaries generated (0 if disabled or no qualifying communities).
 */
export async function runCommunitySummariesStep(
  config: Config,
  outputDir: string,
  graphJsonPath: string,
  llmPool?: LlmEnginePool,
): Promise<number> {
  if (!config.build.community_summaries.enabled) return 0;

  const graphData = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as GraphData;
  const communities = buildCommunityData(graphData);

  if (communities.length === 0) {
    log.info("Community summaries skipped: no qualifying communities (min 3 nodes)");
    return 0;
  }

  const summariesCfg = config.build.community_summaries;
  const modelUri = summariesCfg.model ?? null;

  let llm = null;
  if (modelUri && llmPool) {
    llm = await llmPool.acquire(modelUri, summariesCfg.context_size);
    if (!llm) {
      log.info("  Community summaries LLM not available — using algorithmic");
    }
  }

  const generator = new CommunitySummaryGenerator(summariesCfg, llm);
  const summaries = await generator.generate(communities);

  if (summaries.length > 0) {
    const summariesPath = join(outputDir, "community_summaries.json");
    writeFileSync(summariesPath, JSON.stringify(summaries, null, 2));
    log.info(`  Saved ${summaries.length} community summaries → community_summaries.json`);
  }

  return summaries.length;
}

function buildCommunityData(graphData: GraphData): CommunityData[] {
  const communityMap = new Map<string, GraphNode[]>();

  for (const node of graphData.nodes) {
    const communityId = node.community ?? "unclustered";
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

  return communities;
}
