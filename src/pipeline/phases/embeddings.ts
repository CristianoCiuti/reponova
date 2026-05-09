/**
 * embeddings phase — generates vector representations for graph nodes.
 *
 * Enriched composeNodeText includes community summaries and node descriptions.
 * Per-node composed text comparison for incremental regeneration.
 * Config invalidation via .cache/embeddings-config-hash.txt.
 */
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Phase, PhaseContext, PhaseResult } from "../engine/phase.js";
import type { GraphData } from "../../shared/types.js";
import { atomicWriteJson, atomicWriteText } from "../../shared/atomic-write.js";
import { readJsonSafe } from "../../shared/fs.js";
import { log, errorMessage } from "../../shared/utils.js";
import { EmbeddingEngine, composeNodeText } from "../../intelligence/embeddings.js";
import { TfidfEmbeddingEngine } from "../../intelligence/tfidf-embeddings.js";
import { VectorStore, type VectorRecord } from "../../query/vector-store.js";
import { resolveCacheDir } from "../../intelligence/cache-dir.js";

export const embeddingsPhase: Phase = {
  id: "embeddings",
  label: "Embeddings",
  dependencies: ["community-summaries", "node-descriptions"],

  async execute(ctx: PhaseContext): Promise<PhaseResult> {
    const { config, outputDir, force } = ctx;
    const embConfig = config.embeddings;
    const vectorsPath = join(outputDir, "vectors");
    const tfidfPath = join(outputDir, "tfidf_idf.json");
    const cachePath = join(outputDir, ".cache", "node-texts.json");
    const configHashPath = join(outputDir, ".cache", "embeddings-config-hash.txt");

    if (!embConfig.enabled) {
      removeDirectory(vectorsPath);
      removeFile(tfidfPath);
      removeFile(cachePath);
      removeFile(configHashPath);
      return { processed: 0, skipped: true, skipReason: "disabled in config" };
    }

    // Config invalidation
    const currentConfigHash = hashConfigFields(embConfig.method, embConfig.model, embConfig.dimensions);
    const configChanged = checkConfigChanged(configHashPath, currentConfigHash);
    const effectiveForce = force || configChanged;

    const graphJsonPath = join(outputDir, "graph.json");
    const graphData = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as GraphData;

    // Load community summaries and node descriptions for enriched text
    const communitySummaries = loadCommunitySummaries(outputDir);
    const nodeDescriptions = loadNodeDescriptions(outputDir);

    // Compose text for each node (enriched with community summary + description)
    const items = graphData.nodes.map((node) => {
      const communityId = node.community != null ? String(node.community) : undefined;
      const summary = communityId ? communitySummaries.get(communityId) : undefined;
      const description = nodeDescriptions.get(node.id);

      return {
        id: node.id,
        text: composeNodeText(
          {
            id: node.id,
            label: node.label,
            type: node.type,
            signature: node.signature,
            docstring: node.docstring,
            bases: node.bases,
            source_file: node.source_file,
          },
          summary,
          description,
        ),
      };
    });

    const currentTexts = new Map(items.map((item) => [item.id, item.text]));
    const previousTexts = effectiveForce ? new Map<string, string>() : loadNodeTextCache(outputDir);
    const changedIds = effectiveForce
      ? new Set(items.map((item) => item.id))
      : getChangedNodeIds(currentTexts, previousTexts);
    const removedIds = effectiveForce ? new Set<string>() : getRemovedNodeIds(currentTexts, previousTexts);

    const vectorStore = new VectorStore(outputDir);
    await vectorStore.initialize();

    try {
      const existingRecords = effectiveForce ? [] : await vectorStore.loadAllRecords();
      const existingVectors = new Map(existingRecords.map((r) => [r.id, r.vector]));
      const itemsNeedingEmbeddings = effectiveForce
        ? items
        : items.filter((item) => changedIds.has(item.id) || !existingVectors.has(item.id));

      const staleVectorIds = new Set<string>();
      for (const id of existingVectors.keys()) {
        if (!currentTexts.has(id)) staleVectorIds.add(id);
      }

      if (itemsNeedingEmbeddings.length === 0 && removedIds.size === 0 && staleVectorIds.size === 0) {
        atomicWriteJson(getNodeTextCachePath(outputDir), Object.fromEntries(currentTexts));
        atomicWriteText(configHashPath, currentConfigHash);
        return { processed: 0, skipped: true, skipReason: "up to date" };
      }

      if (itemsNeedingEmbeddings.length === 0) {
        if (embConfig.method === "tfidf" && staleVectorIds.size > 0 && items.length > 0) {
          const result = await generateTfidf(ctx, graphData, items, items, [], currentTexts, vectorStore);
          atomicWriteText(configHashPath, currentConfigHash);
          return result;
        }

        const cleanedRecords = existingRecords.filter((r) => !staleVectorIds.has(r.id));
        await vectorStore.upsert(cleanedRecords);
        atomicWriteJson(getNodeTextCachePath(outputDir), Object.fromEntries(currentTexts));
        atomicWriteText(configHashPath, currentConfigHash);
        return { processed: 0, skipped: true, skipReason: "stale cleanup only" };
      }

      let result: PhaseResult;
      if (embConfig.method === "tfidf") {
        result = await generateTfidf(ctx, graphData, items, itemsNeedingEmbeddings, existingRecords, currentTexts, vectorStore);
      } else {
        result = await generateOnnx(ctx, graphData, itemsNeedingEmbeddings, existingRecords, currentTexts, vectorStore);
      }

      atomicWriteText(configHashPath, currentConfigHash);
      return result;
    } finally {
      await vectorStore.dispose();
    }
  },
};

async function generateTfidf(
  ctx: PhaseContext,
  graphData: GraphData,
  allItems: Array<{ id: string; text: string }>,
  itemsToEmbed: Array<{ id: string; text: string }>,
  existingRecords: VectorRecord[],
  currentTexts: Map<string, string>,
  vectorStore: VectorStore,
): Promise<PhaseResult> {
  const engine = new TfidfEmbeddingEngine(ctx.config.embeddings);
  try {
    log.info(`Generating TF-IDF embeddings (${itemsToEmbed.length} nodes)...`);
    engine.buildVocabulary(allItems.map((item) => item.text));
    const embeddings = itemsToEmbed.length > 0 ? engine.embedBatch(itemsToEmbed) : [];
    await storeEmbeddings({ graphData, embeddings, existingRecords, currentTexts, vectorStore, outputDir: ctx.outputDir, vocabulary: engine.serializeVocabulary() });
    return { processed: embeddings.length, skipped: false };
  } catch (err) {
    const msg = errorMessage(err);
    log.warn(`TF-IDF embeddings failed (non-blocking): ${msg}`);
    return { processed: 0, skipped: true, skipReason: msg };
  } finally {
    engine.dispose();
  }
}

async function generateOnnx(
  ctx: PhaseContext,
  graphData: GraphData,
  items: Array<{ id: string; text: string }>,
  existingRecords: VectorRecord[],
  currentTexts: Map<string, string>,
  vectorStore: VectorStore,
): Promise<PhaseResult> {
  const cacheDir = resolveCacheDir(ctx.config.models.cache_dir);
  const engine = new EmbeddingEngine(ctx.config.embeddings, cacheDir, ctx.config.models.download_on_first_use);
  try {
    const ready = await engine.initialize();
    if (!ready) return { processed: 0, skipped: true, skipReason: "embedding engine unavailable" };

    log.info(`Generating ONNX embeddings (${items.length} nodes)...`);
    const embeddings = await engine.embedBatch(items);
    await storeEmbeddings({ graphData, embeddings, existingRecords, currentTexts, vectorStore, outputDir: ctx.outputDir });
    return { processed: embeddings.length, skipped: false };
  } catch (err) {
    const msg = errorMessage(err);
    log.warn(`ONNX embeddings failed (non-blocking): ${msg}`);
    return { processed: 0, skipped: true, skipReason: msg };
  } finally {
    await engine.dispose();
  }
}

async function storeEmbeddings(options: {
  graphData: GraphData;
  embeddings: Array<{ id: string; text: string; vector: Float32Array }>;
  existingRecords: VectorRecord[];
  currentTexts: Map<string, string>;
  vectorStore: VectorStore;
  outputDir: string;
  vocabulary?: Record<string, number>;
}): Promise<void> {
  const { graphData, embeddings, existingRecords, currentTexts, vectorStore, outputDir, vocabulary } = options;

  const updatedVectors = new Map(embeddings.map((e) => [e.id, Array.from(e.vector)]));
  const existingVectorMap = new Map(existingRecords.map((r) => [r.id, r.vector]));

  const records: VectorRecord[] = graphData.nodes.flatMap((node) => {
    const vector = updatedVectors.get(node.id) ?? existingVectorMap.get(node.id);
    if (!vector) return [];
    return {
      id: node.id,
      label: node.label,
      type: node.type,
      repo: node.repo ?? "",
      source_file: node.source_file ?? "",
      community: String(node.community ?? ""),
      text: currentTexts.get(node.id) ?? "",
      vector,
    };
  });

  await vectorStore.upsert(records);
  atomicWriteJson(getNodeTextCachePath(outputDir), Object.fromEntries(currentTexts));

  if (vocabulary) {
    atomicWriteJson(join(outputDir, "tfidf_idf.json"), vocabulary);
  } else {
    removeFile(join(outputDir, "tfidf_idf.json"));
  }

  log.info(`  ${embeddings.length} embeddings stored`);
}

function loadNodeTextCache(outputDir: string): Map<string, string> {
  const path = getNodeTextCachePath(outputDir);
  const raw = readJsonSafe<Record<string, string>>(path);
  return raw ? new Map(Object.entries(raw)) : new Map();
}

function getNodeTextCachePath(outputDir: string): string {
  return join(outputDir, ".cache", "node-texts.json");
}

function getChangedNodeIds(currentTexts: Map<string, string>, previousTexts: Map<string, string>): Set<string> {
  const changed = new Set<string>();
  for (const [id, text] of currentTexts) {
    if (previousTexts.get(id) !== text) changed.add(id);
  }
  return changed;
}

function getRemovedNodeIds(currentTexts: Map<string, string>, previousTexts: Map<string, string>): Set<string> {
  const removed = new Set<string>();
  for (const id of previousTexts.keys()) {
    if (!currentTexts.has(id)) removed.add(id);
  }
  return removed;
}

function loadCommunitySummaries(outputDir: string): Map<string, string> {
  const path = join(outputDir, "community_summaries.json");
  const summaries = readJsonSafe<Array<{ id: string; summary: string }>>(path);
  return summaries ? new Map(summaries.map((s) => [String(s.id), s.summary])) : new Map();
}

function loadNodeDescriptions(outputDir: string): Map<string, string> {
  const path = join(outputDir, "node_descriptions.json");
  const descs = readJsonSafe<Array<{ id: string; description: string }>>(path);
  return descs ? new Map(descs.map((d) => [d.id, d.description])) : new Map();
}

function hashConfigFields(method: string, model: string, dimensions: number): string {
  return createHash("sha256").update(JSON.stringify({ method, model, dimensions })).digest("hex");
}

function checkConfigChanged(hashPath: string, currentHash: string): boolean {
  if (!existsSync(hashPath)) return false;
  try { return readFileSync(hashPath, "utf-8").trim() !== currentHash; }
  catch { return false; }
}

function removeDirectory(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

function removeFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
