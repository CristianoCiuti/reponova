/**
 * Embeddings step — generates vector representations for all graph nodes.
 *
 * Supports two methods:
 * - TF-IDF: Feature-hashed vectors (fast, no model download)
 * - ONNX: MiniLM-L6-v2 sentence embeddings (more accurate, ~86MB model)
 *
 * Incremental: only re-embeds nodes whose text content changed since last build.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../shared/utils.js";
import type { Config, GraphData } from "../../shared/types.js";
import { EmbeddingEngine, composeNodeText } from "../intelligence/embeddings.js";
import { TfidfEmbeddingEngine } from "../intelligence/tfidf-embeddings.js";
import { VectorStore, type VectorRecord } from "../../core/vector-store.js";
import { resolveCacheDir } from "../intelligence/cache-dir.js";

/**
 * Run the embeddings step.
 * Returns the number of embeddings generated (0 if all up-to-date or disabled).
 */
export async function runEmbeddingsStep(
  config: Config,
  outputDir: string,
  graphJsonPath: string,
): Promise<number> {
  if (!config.build.embeddings.enabled) return 0;
  const graphData = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as GraphData;
  return generateEmbeddings(config, outputDir, graphData);
}

async function generateEmbeddings(config: Config, outputDir: string, graphData: GraphData): Promise<number> {
  const method = config.build.embeddings.method;

  // Ensure only method-specific artifacts exist. tfidf_idf.json is TF-IDF exclusive.
  if (method === "onnx") {
    const tfidfPath = join(outputDir, "tfidf_idf.json");
    if (existsSync(tfidfPath)) {
      unlinkSync(tfidfPath);
      log.info("Removed stale tfidf_idf.json (method is onnx)");
    }
  }

  const items = graphData.nodes.map((node) => ({
    id: node.id,
    text: composeNodeText({
      id: node.id,
      label: node.label,
      type: node.type,
      signature: node.signature,
      docstring: node.docstring,
      bases: node.bases,
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

  const existingVectors = new Map(existingRecords.map((record) => [record.id, record.vector]));
  const itemsNeedingEmbeddings = items.filter((item) => changedIds.has(item.id) || !existingVectors.has(item.id));

  // Detect stale vectors: entries in VectorStore for nodes no longer in the graph
  const staleVectorIds = new Set<string>();
  for (const id of existingVectors.keys()) {
    if (!currentTexts.has(id)) {
      staleVectorIds.add(id);
    }
  }

  if (itemsNeedingEmbeddings.length === 0 && removedIds.size === 0 && staleVectorIds.size === 0) {
    await vectorStore.dispose();
    saveNodeTextCache(outputDir, currentTexts);
    return 0;
  }

  // Cleanup-only path: no new embeddings needed, just remove stale entries from outputs
  if (itemsNeedingEmbeddings.length === 0) {
    if (staleVectorIds.size > 0) {
      const cleanedRecords = existingRecords.filter((r) => !staleVectorIds.has(r.id));
      await vectorStore.upsert(cleanedRecords);
      log.info(`  ✓ removed ${staleVectorIds.size} stale vectors`);
    }
    await vectorStore.dispose();
    // Rebuild TF-IDF vocabulary from current nodes (cheap: just term counting, no embedBatch).
    // The IDF file is used at query time — stale terms degrade search quality.
    if (method === "tfidf" && items.length > 0) {
      const engine = new TfidfEmbeddingEngine(config.build.embeddings);
      engine.buildVocabulary(items.map((i) => i.text));
      engine.saveVocabulary(outputDir);
      engine.dispose();
    }
    // node-texts.json is always written from currentTexts (which only has current graph nodes)
    saveNodeTextCache(outputDir, currentTexts);
    return 0;
  }

  // Full path: new embeddings needed (stale cleanup happens implicitly — storeEmbeddings
  // rebuilds from graphData.nodes only, excluding any stale entries)
  if (method === "tfidf") {
    return generateTfidf(config, outputDir, graphData, items, itemsNeedingEmbeddings, existingRecords, currentTexts, vectorStore);
  }
  return generateOnnx(config, outputDir, graphData, itemsNeedingEmbeddings, existingRecords, currentTexts, vectorStore);
}

async function generateTfidf(
  config: Config,
  outputDir: string,
  graphData: GraphData,
  allItems: Array<{ id: string; text: string }>,
  itemsToEmbed: Array<{ id: string; text: string }>,
  existingRecords: VectorRecord[],
  currentTexts: Map<string, string>,
  vectorStore: VectorStore,
): Promise<number> {
  try {
    const engine = new TfidfEmbeddingEngine(config.build.embeddings);

    log.info("Generating TF-IDF embeddings...");
    engine.buildVocabulary(allItems.map((i) => i.text));

    const embeddings = itemsToEmbed.length > 0 ? engine.embedBatch(itemsToEmbed) : [];
    engine.saveVocabulary(outputDir);
    engine.dispose();

    return storeEmbeddings(graphData, embeddings, existingRecords, currentTexts, vectorStore, outputDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`TF-IDF embeddings failed (non-blocking): ${msg}`);
    await vectorStore.dispose();
    return 0;
  }
}

async function generateOnnx(
  config: Config,
  outputDir: string,
  graphData: GraphData,
  items: Array<{ id: string; text: string }>,
  existingRecords: VectorRecord[],
  currentTexts: Map<string, string>,
  vectorStore: VectorStore,
): Promise<number> {
  const cacheDir = resolveCacheDir(config.models.cache_dir);
  const engine = new EmbeddingEngine(config.build.embeddings, cacheDir, config.models.download_on_first_use);

  try {
    const ready = await engine.initialize();
    if (!ready) {
      await vectorStore.dispose();
      return 0;
    }

    log.info("Generating ONNX embeddings...");
    const embeddings = await engine.embedBatch(items);

    return storeEmbeddings(graphData, embeddings, existingRecords, currentTexts, vectorStore, outputDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`ONNX embeddings failed (non-blocking): ${msg}`);
    await vectorStore.dispose();
    return 0;
  } finally {
    await engine.dispose();
  }
}

async function storeEmbeddings(
  graphData: GraphData,
  embeddings: Array<{ id: string; text: string; vector: Float32Array }>,
  existingRecords: VectorRecord[],
  currentTexts: Map<string, string>,
  vectorStore: VectorStore,
  outputDir: string,
): Promise<number> {
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

// ─── Node Text Cache (exported for tests) ────────────────────────────────────

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
