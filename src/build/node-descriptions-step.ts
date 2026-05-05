/**
 * Node descriptions step — generates natural-language descriptions for high-degree nodes.
 *
 * Orchestrates:
 * 1. Load graph data
 * 2. Compute edge counts for degree selection
 * 3. Acquire LLM from pool (if model configured)
 * 4. Run NodeDescriptionGenerator
 * 5. Write node_descriptions.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../shared/utils.js";
import type { Config, GraphData } from "../shared/types.js";
import { NodeDescriptionGenerator } from "./node-description-generator.js";
import type { LlmEnginePool } from "./llm-engine-pool.js";

/**
 * Run the node descriptions step.
 * Returns the number of descriptions generated (0 if disabled or no qualifying nodes).
 */
export async function runNodeDescriptionsStep(
  config: Config,
  outputDir: string,
  graphJsonPath: string,
  llmPool?: LlmEnginePool,
): Promise<number> {
  if (!config.build.node_descriptions.enabled) return 0;

  const graphData = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as GraphData;
  const edgeCounts = computeEdgeCounts(graphData);

  if (edgeCounts.size === 0) {
    log.info("Node descriptions skipped: graph has no edges");
    return 0;
  }

  const descriptionsCfg = config.build.node_descriptions;
  const modelUri = descriptionsCfg.model ?? null;

  let llm = null;
  if (modelUri && llmPool) {
    llm = await llmPool.acquire(modelUri, descriptionsCfg.context_size);
    if (!llm) {
      log.info("  Node descriptions LLM not available — using algorithmic");
    }
  }

  const generator = new NodeDescriptionGenerator(descriptionsCfg, llm);
  const descriptions = await generator.generate(graphData.nodes, edgeCounts);

  if (descriptions.length > 0) {
    const descriptionsPath = join(outputDir, "node_descriptions.json");
    writeFileSync(descriptionsPath, JSON.stringify(descriptions, null, 2));
    log.info(`  Saved ${descriptions.length} node descriptions → node_descriptions.json`);
  } else {
    log.info("  No node descriptions generated (no qualifying nodes)");
  }

  return descriptions.length;
}

function computeEdgeCounts(graphData: GraphData): Map<string, number> {
  const counts = new Map<string, number>();

  for (const edge of graphData.edges) {
    counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
  }

  return counts;
}
