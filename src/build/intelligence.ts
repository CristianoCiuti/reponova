/**
 * Intelligence layer orchestration.
 *
 * Runs after graph extraction and indexing:
 * 1. Generates embeddings for all graph nodes → stores in vector DB
 * 2. Generates community summaries (LLM or algorithmic fallback)
 * 3. Generates node descriptions for high-degree nodes
 *
 * Community summaries and node descriptions are fully independent features.
 * Each can independently enable/disable LLM enhancement via its own model field.
 *
 * When both features reference the same model, resolve-then-compare deduplicates
 * the engine instance to avoid loading the model twice (~350MB saved).
 *
 * All steps are best-effort: failures don't block the build.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../shared/utils.js";
import type { Config, ModelsConfig, CommunitySummariesConfig, NodeDescriptionsConfig, GraphData, GraphNode } from "../shared/types.js";
import { EmbeddingEngine, composeNodeText } from "./embeddings.js";
import { TfidfEmbeddingEngine } from "./tfidf-embeddings.js";
import { VectorStore, type VectorRecord } from "../core/vector-store.js";
import { LlmEngine, areModelsEquivalent, type LlmEngineOptions } from "./llm-engine.js";
import { SummaryGenerator, type CommunityData } from "./community-summaries.js";

export interface IntelligenceResult {
  embeddingsGenerated: number;
  communitySummaries: number;
  nodeDescriptions: number;
}

export interface IntelligenceRunOptions {
  skipEmbeddings?: boolean;
  skipSummaries?: boolean;
  skipDescriptions?: boolean;
}

/**
 * Run the full intelligence layer pipeline.
 */
export async function runIntelligenceLayer(
  config: Config,
  outputDir: string,
  graphJsonPath: string,
  options: IntelligenceRunOptions = {},
): Promise<IntelligenceResult> {
  const result: IntelligenceResult = {
    embeddingsGenerated: 0,
    communitySummaries: 0,
    nodeDescriptions: 0,
  };

  // Load graph data
  const graphData = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as GraphData;

  // ─── Phase 2.1: Embeddings ─────────────────────────────────────────────────

  if (config.build.embeddings.enabled && !options.skipEmbeddings) {
    const embCount = await runEmbeddings(config, outputDir, graphData);
    result.embeddingsGenerated = embCount;
  }

  // ─── Phase 2.2: Summaries & Descriptions (independent features) ────────────

  const summariesCfg: CommunitySummariesConfig = {
    ...config.build.community_summaries,
    enabled: config.build.community_summaries.enabled && !options.skipSummaries,
  };
  const descriptionsCfg: NodeDescriptionsConfig = {
    ...config.build.node_descriptions,
    enabled: config.build.node_descriptions.enabled && !options.skipDescriptions,
  };

  const summariesEnabled = summariesCfg.enabled;
  const descriptionsEnabled = descriptionsCfg.enabled;

  if (summariesEnabled || descriptionsEnabled) {
    const { summaries, descriptions } = await runSummariesAndDescriptions(
      summariesCfg,
      descriptionsCfg,
      config.models,
      outputDir,
      graphData,
    );
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

  const currentTexts = new Map(items.map((item) => [item.id, item.text]));
  const previousTexts = loadNodeTextCache(outputDir);
  const changedIds = getChangedNodeIds(currentTexts, previousTexts);
  const removedIds = getRemovedNodeIds(currentTexts, previousTexts);
  const vectorStore = new VectorStore(outputDir);
  await vectorStore.initialize();
  const existingRecords = await vectorStore.loadAllRecords();
  await vectorStore.dispose();
  const existingVectors = new Map(existingRecords.map((record) => [record.id, record.vector]));

  const itemsNeedingEmbeddings = items.filter((item) => changedIds.has(item.id) || !existingVectors.has(item.id));

  if (itemsNeedingEmbeddings.length === 0 && removedIds.size === 0) {
    saveNodeTextCache(outputDir, currentTexts);
    return 0;
  }

  if (method === "tfidf") {
    return runTfidfEmbeddings(config, outputDir, graphData, items, itemsNeedingEmbeddings, existingRecords, currentTexts);
  }
  return runOnnxEmbeddings(config, outputDir, graphData, itemsNeedingEmbeddings, existingRecords, currentTexts);
}

async function runTfidfEmbeddings(
  config: Config,
  outputDir: string,
  graphData: GraphData,
  allItems: Array<{ id: string; text: string }>,
  itemsToEmbed: Array<{ id: string; text: string }>,
  existingRecords: VectorRecord[],
  currentTexts: Map<string, string>,
): Promise<number> {
  try {
    const engine = new TfidfEmbeddingEngine(config.build.embeddings);

    log.info("Generating TF-IDF embeddings...");
    engine.buildVocabulary(allItems.map(i => i.text));

    const embeddings = itemsToEmbed.length > 0 ? engine.embedBatch(itemsToEmbed) : [];
    engine.saveVocabulary(outputDir);
    engine.dispose();

    return storeEmbeddings(outputDir, graphData, embeddings, existingRecords, currentTexts);
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
  existingRecords: VectorRecord[],
  currentTexts: Map<string, string>,
): Promise<number> {
  const cacheDir = resolveCacheDir(config.models.cache_dir);
  const engine = new EmbeddingEngine(config.build.embeddings, cacheDir, config.models.download_on_first_use);

  try {
    const ready = await engine.initialize();
    if (!ready) return 0;

    log.info("Generating ONNX embeddings...");
    const embeddings = await engine.embedBatch(items);

    return storeEmbeddings(outputDir, graphData, embeddings, existingRecords, currentTexts);
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
  existingRecords: VectorRecord[],
  currentTexts: Map<string, string>,
): Promise<number> {
  const vectorStore = new VectorStore(outputDir);
  await vectorStore.initialize();

  const updatedVectors = new Map(embeddings.map((embedding) => [embedding.id, Array.from(embedding.vector)]));
  const existingVectorMap = new Map(existingRecords.map((record) => [record.id, record.vector]));

  const records: VectorRecord[] = graphData.nodes.flatMap((node) => {
    const vector = updatedVectors.get(node.id) ?? existingVectorMap.get(node.id);
    if (!vector) return [];

    return {
      id: node.id,
      label: node.label,
      type: node.type,
      repo: node.repo ?? "",
      source_file: node.source_file ?? "",
      community: node.community ?? "",
      text: currentTexts.get(node.id) ?? "",
      vector,
    };
  });

  await vectorStore.upsert(records);
  await vectorStore.dispose();
  saveNodeTextCache(outputDir, currentTexts);

  log.info(`  ✓ ${embeddings.length} embeddings generated and indexed`);
  return embeddings.length;
}

// ─── Summaries & Descriptions ────────────────────────────────────────────────

/**
 * Run community summaries and node descriptions as independent features.
 *
 * Uses resolve-then-compare to deduplicate model instances when both features
 * reference the same model (avoids loading ~350MB twice).
 */
async function runSummariesAndDescriptions(
  summariesCfg: CommunitySummariesConfig,
  descriptionsCfg: NodeDescriptionsConfig,
  modelsCfg: ModelsConfig,
  outputDir: string,
  graphData: GraphData,
): Promise<{ summaries: number; descriptions: number }> {
  const cacheDir = modelsCfg.cache_dir;

  // Determine which models are needed
  const summariesModel = summariesCfg.enabled ? (summariesCfg.model ?? null) : null;
  const descriptionsModel = descriptionsCfg.enabled ? (descriptionsCfg.model ?? null) : null;

  let summariesLlm: LlmEngine | null = null;
  let descriptionsLlm: LlmEngine | null = null;
  let sharedEngine = false;

  try {
    // ── Resolve-then-compare for model dedup ──────────────────────────────
    if (summariesModel && descriptionsModel) {
      const sameModel = await areModelsEquivalent(summariesModel, descriptionsModel, cacheDir);

      if (sameModel) {
        // Same model → create one shared engine with larger context
        log.info("Both features reference the same model — sharing engine instance");
        const maxContext = Math.max(summariesCfg.context_size, descriptionsCfg.context_size);
        summariesLlm = createLlmEngine(summariesModel, maxContext, modelsCfg);
        const ready = await summariesLlm.initialize();
        if (ready) {
          descriptionsLlm = summariesLlm;
          sharedEngine = true;
        } else {
          summariesLlm = null;
          log.info("  LLM not available — using algorithmic for both");
        }
      } else {
        // Different models → create summaries engine now, descriptions engine later
        summariesLlm = createLlmEngine(summariesModel, summariesCfg.context_size, modelsCfg);
        const ready = await summariesLlm.initialize();
        if (!ready) {
          summariesLlm = null;
          log.info("  Summaries LLM not available — using algorithmic");
        }
        // Descriptions engine created after summaries complete (sequential to limit memory)
      }
    } else if (summariesModel) {
      summariesLlm = createLlmEngine(summariesModel, summariesCfg.context_size, modelsCfg);
      const ready = await summariesLlm.initialize();
      if (!ready) {
        summariesLlm = null;
        log.info("  Summaries LLM not available — using algorithmic");
      }
    } else if (descriptionsModel) {
      descriptionsLlm = createLlmEngine(descriptionsModel, descriptionsCfg.context_size, modelsCfg);
      const ready = await descriptionsLlm.initialize();
      if (!ready) {
        descriptionsLlm = null;
        log.info("  Descriptions LLM not available — using algorithmic");
      }
    }

    // ── Create generator with resolved engines ────────────────────────────
    const generator = new SummaryGenerator(summariesCfg, descriptionsCfg, summariesLlm, descriptionsLlm);

    // ── Phase 1: Community summaries ──────────────────────────────────────
    let summaryCount = 0;
    if (summariesCfg.enabled) {
      const communities = buildCommunityData(graphData);
      const communitySummaries = await generator.generateCommunitySummaries(communities);

      if (communitySummaries.length > 0) {
        const summariesPath = join(outputDir, "community_summaries.json");
        writeFileSync(summariesPath, JSON.stringify(communitySummaries, null, 2));
        log.info(`  Saved ${communitySummaries.length} community summaries → community_summaries.json`);
      }
      summaryCount = communitySummaries.length;
    }

    // ── Dispose summaries engine if different from descriptions engine ────
    if (summariesLlm && !sharedEngine) {
      await summariesLlm.dispose();
      summariesLlm = null;
    }

    // ── Create separate descriptions engine if needed (sequential load) ───
    if (descriptionsModel && !descriptionsLlm) {
      descriptionsLlm = createLlmEngine(descriptionsModel, descriptionsCfg.context_size, modelsCfg);
      const ready = await descriptionsLlm.initialize();
      if (!ready) {
        descriptionsLlm = null;
        log.info("  Descriptions LLM not available — using algorithmic");
      }
      // Update generator with the new descriptions engine
      // (generator was created with null descriptionsLlm — create a new one)
      if (descriptionsLlm) {
        const updatedGenerator = new SummaryGenerator(summariesCfg, descriptionsCfg, null, descriptionsLlm);
        return {
          summaries: summaryCount,
          descriptions: await runNodeDescriptions(updatedGenerator, descriptionsCfg, graphData, outputDir),
        };
      }
    }

    // ── Phase 2: Node descriptions ────────────────────────────────────────
    let descriptionCount = 0;
    if (descriptionsCfg.enabled) {
      descriptionCount = await runNodeDescriptions(generator, descriptionsCfg, graphData, outputDir);
    }

    return { summaries: summaryCount, descriptions: descriptionCount };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    log.warn(`Summaries/descriptions failed (non-blocking): ${msg}`);
    if (stack) log.warn(`  Stack: ${stack.split("\n").slice(1, 4).join(" → ")}`);
    return { summaries: 0, descriptions: 0 };
  } finally {
    if (summariesLlm && !sharedEngine) await summariesLlm.dispose();
    if (descriptionsLlm) await descriptionsLlm.dispose();
  }
}

async function runNodeDescriptions(
  generator: SummaryGenerator,
  descriptionsCfg: NodeDescriptionsConfig,
  graphData: GraphData,
  outputDir: string,
): Promise<number> {
  if (!descriptionsCfg.enabled) return 0;

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

  return nodeDescriptions.length;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createLlmEngine(modelUri: string, contextSize: number, modelsCfg: ModelsConfig): LlmEngine {
  const options: LlmEngineOptions = {
    modelUri,
    cacheDir: modelsCfg.cache_dir,
    gpu: modelsCfg.gpu,
    contextSize,
    threads: modelsCfg.threads,
    downloadOnFirstUse: modelsCfg.download_on_first_use,
  };
  return new LlmEngine(options);
}

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

function resolveCacheDir(configPath: string): string {
  if (configPath.startsWith("~")) {
    return resolve(homedir(), configPath.slice(2));
  }
  return resolve(configPath);
}

export function loadNodeTextCache(outputDir: string): Map<string, string> {
  const path = join(outputDir, ".cache", "node-texts.json");
  if (!existsSync(path)) return new Map();

  try {
    return new Map(Object.entries(JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>));
  } catch {
    return new Map();
  }
}

export function saveNodeTextCache(outputDir: string, texts: Map<string, string>): void {
  const cacheDir = join(outputDir, ".cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "node-texts.json"), JSON.stringify(Object.fromEntries(texts), null, 2));
}

function getChangedNodeIds(currentTexts: Map<string, string>, previousTexts: Map<string, string>): Set<string> {
  const changed = new Set<string>();
  for (const [id, text] of currentTexts) {
    if (previousTexts.get(id) !== text) {
      changed.add(id);
    }
  }
  return changed;
}

function getRemovedNodeIds(currentTexts: Map<string, string>, previousTexts: Map<string, string>): Set<string> {
  const removed = new Set<string>();
  for (const id of previousTexts.keys()) {
    if (!currentTexts.has(id)) {
      removed.add(id);
    }
  }
  return removed;
}
