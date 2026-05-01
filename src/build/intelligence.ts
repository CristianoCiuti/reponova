/**
 * Intelligence layer orchestration.
 *
 * Runs after graph extraction and indexing:
 * 1. Generates embeddings for all graph nodes → stores in vector DB
 * 2. Generates community summaries (LLM or algorithmic fallback)
 * 3. Generates node descriptions for high-degree nodes
 *
 * All steps are best-effort: failures don't block the build.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../shared/utils.js";
import type { Config, GraphData, GraphNode } from "../shared/types.js";
import { EmbeddingEngine, composeNodeText } from "./embeddings.js";
import { TfidfEmbeddingEngine } from "./tfidf-embeddings.js";
import { VectorStore, type VectorRecord } from "../core/vector-store.js";
import { LlmEngine } from "./llm-engine.js";
import { SummaryGenerator, type CommunityData } from "./community-summaries.js";

export interface IntelligenceResult {
  embeddingsGenerated: number;
  communitySummaries: number;
  nodeDescriptions: number;
}

/**
 * Run the full intelligence layer pipeline.
 */
export async function runIntelligenceLayer(
  config: Config,
  outputDir: string,
  graphJsonPath: string,
): Promise<IntelligenceResult> {
  const result: IntelligenceResult = {
    embeddingsGenerated: 0,
    communitySummaries: 0,
    nodeDescriptions: 0,
  };

  // Load graph data
  const graphData = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as GraphData;

  // ─── Phase 2.1: Embeddings ─────────────────────────────────────────────────

  if (config.build.embeddings.enabled) {
    const embCount = await runEmbeddings(config, outputDir, graphData);
    result.embeddingsGenerated = embCount;
  }

  // ─── Phase 2.2: Summaries ──────────────────────────────────────────────────

  if (config.build.summaries.enabled) {
    const { summaries, descriptions } = await runSummaries(config, outputDir, graphData);
    result.communitySummaries = summaries;
    result.nodeDescriptions = descriptions;
  }

  return result;
}

// ─── Embeddings ──────────────────────────────────────────────────────────────

async function runEmbeddings(config: Config, outputDir: string, graphData: GraphData): Promise<number> {
  const method = config.build.embeddings.method;

  // Compose text for each node (shared by both methods)
  const items = graphData.nodes.map(node => ({
    id: node.id,
    text: composeNodeText({
      id: node.id,
      label: node.label,
      type: node.type,
      signature: node.properties?.signature as string | undefined,
      docstring: node.properties?.docstring as string | undefined,
      bases: node.properties?.bases as string[] | undefined,
      source_file: node.source_file,
    }),
  }));

  if (method === "tfidf") {
    return runTfidfEmbeddings(config, outputDir, graphData, items);
  }
  return runOnnxEmbeddings(config, outputDir, graphData, items);
}

async function runTfidfEmbeddings(
  config: Config,
  outputDir: string,
  graphData: GraphData,
  items: Array<{ id: string; text: string }>,
): Promise<number> {
  try {
    const engine = new TfidfEmbeddingEngine(config.build.embeddings);

    log.info("Generating TF-IDF embeddings...");
    engine.buildVocabulary(items.map(i => i.text));

    const embeddings = engine.embedBatch(items);
    engine.saveVocabulary(outputDir);
    engine.dispose();

    if (embeddings.length === 0) {
      log.warn("  No embeddings generated");
      return 0;
    }

    return storeEmbeddings(outputDir, graphData, embeddings);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`TF-IDF embeddings failed (non-blocking): ${msg}`);
    return 0;
  }
}

async function runOnnxEmbeddings(
  config: Config,
  outputDir: string,
  graphData: GraphData,
  items: Array<{ id: string; text: string }>,
): Promise<number> {
  const engine = new EmbeddingEngine(config.build.embeddings);

  try {
    const ready = await engine.initialize();
    if (!ready) return 0;

    log.info("Generating ONNX embeddings...");
    const embeddings = await engine.embedBatch(items);

    if (embeddings.length === 0) {
      log.warn("  No embeddings generated");
      return 0;
    }

    return storeEmbeddings(outputDir, graphData, embeddings);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`ONNX embeddings failed (non-blocking): ${msg}`);
    return 0;
  } finally {
    await engine.dispose();
  }
}

async function storeEmbeddings(
  outputDir: string,
  graphData: GraphData,
  embeddings: Array<{ id: string; text: string; vector: Float32Array }>,
): Promise<number> {
  const vectorStore = new VectorStore(outputDir);
  await vectorStore.initialize();

  const records: VectorRecord[] = embeddings.map(emb => {
    const node = graphData.nodes.find(n => n.id === emb.id);
    return {
      id: emb.id,
      label: node?.label ?? "",
      type: node?.type ?? "",
      repo: node?.repo ?? "",
      source_file: node?.source_file ?? "",
      community: node?.community ?? "",
      text: emb.text,
      vector: Array.from(emb.vector),
    };
  });

  await vectorStore.upsert(records);
  await vectorStore.dispose();

  log.info(`  ✓ ${embeddings.length} embeddings generated and indexed`);
  return embeddings.length;
}

// ─── Summaries ───────────────────────────────────────────────────────────────

async function runSummaries(
  config: Config,
  outputDir: string,
  graphData: GraphData,
): Promise<{ summaries: number; descriptions: number }> {
  let llm: LlmEngine | null = null;

  try {
    // Try to initialize LLM (optional enhancement)
    if (config.build.llm.enabled) {
      llm = new LlmEngine(config.build.llm);
      const llmReady = await llm.initialize();
      if (!llmReady) {
        llm = null;
        log.info("  LLM not available — using algorithmic summaries");
      }
    }

    const generator = new SummaryGenerator(config.build.summaries, llm);

    // Build community data from graph
    const communities = buildCommunityData(graphData);

    // ── Phase 1: Community summaries ──────────────────────────────────────
    const communitySummaries = await generator.generateCommunitySummaries(communities);

    // Save community summaries immediately (don't lose them if node descriptions fail)
    if (communitySummaries.length > 0) {
      const summariesPath = join(outputDir, "community_summaries.json");
      writeFileSync(summariesPath, JSON.stringify(communitySummaries, null, 2));
      log.info(`  Saved ${communitySummaries.length} community summaries → community_summaries.json`);
    }

    // ── Phase 2: Node descriptions ────────────────────────────────────────
    log.info("Computing edge counts for node selection...");
    const edgeCounts = computeEdgeCounts(graphData);
    log.info(`  Edge counts computed: ${edgeCounts.size} nodes with edges`);

    const nodeDescriptions = await generator.generateNodeDescriptions(graphData.nodes, edgeCounts);

    if (nodeDescriptions.length > 0) {
      const descriptionsPath = join(outputDir, "node_descriptions.json");
      writeFileSync(descriptionsPath, JSON.stringify(nodeDescriptions, null, 2));
      log.info(`  Saved ${nodeDescriptions.length} node descriptions → node_descriptions.json`);
    } else {
      log.info("  No node descriptions generated (disabled or no qualifying nodes)");
    }

    return {
      summaries: communitySummaries.length,
      descriptions: nodeDescriptions.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    log.warn(`Summaries failed (non-blocking): ${msg}`);
    if (stack) log.warn(`  Stack: ${stack.split("\n").slice(1, 4).join(" → ")}`);
    return { summaries: 0, descriptions: 0 };
  } finally {
    if (llm) await llm.dispose();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildCommunityData(graphData: GraphData): CommunityData[] {
  // Group nodes by community
  const communityMap = new Map<string, GraphNode[]>();

  for (const node of graphData.nodes) {
    const communityId = node.community ?? "unclustered";
    if (!communityMap.has(communityId)) {
      communityMap.set(communityId, []);
    }
    communityMap.get(communityId)!.push(node);
  }

  // Convert to CommunityData array (skip "unclustered" and tiny communities)
  const communities: CommunityData[] = [];
  for (const [id, nodes] of communityMap) {
    if (id === "unclustered" || nodes.length < 3) continue;
    communities.push({ id, nodes });
  }

  return communities;
}

function computeEdgeCounts(graphData: GraphData): Map<string, number> {
  const counts = new Map<string, number>();

  for (const edge of graphData.edges) {
    counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
  }

  return counts;
}
