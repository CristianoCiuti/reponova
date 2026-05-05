/**
 * Embeddings step — incrementally generates vector representations for graph nodes.
 */
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../../shared/atomic-write.js";
import { log } from "../../shared/utils.js";
import type { GraphData } from "../../shared/types.js";
import type { BuildStep, StepContext, StepResult } from "../types.js";
import { EmbeddingEngine, composeNodeText } from "../intelligence/embeddings.js";
import { TfidfEmbeddingEngine } from "../intelligence/tfidf-embeddings.js";
import { VectorStore, type VectorRecord } from "../../core/vector-store.js";
import { resolveCacheDir } from "../intelligence/cache-dir.js";

export const runEmbeddingsStep: BuildStep = async (ctx: StepContext): Promise<StepResult> => {
  const config = ctx.config.build.embeddings;
  const vectorsPath = join(ctx.outputDir, "vectors");
  const tfidfPath = join(ctx.outputDir, "tfidf_idf.json");
  const cachePath = join(ctx.outputDir, ".cache", "node-texts.json");

  if (!config.enabled) {
    removeDirectory(vectorsPath);
    removeFile(tfidfPath);
    removeFile(cachePath);
    return { processed: 0, skipped: true, skipReason: "disabled in config" };
  }

  const previous = ctx.previousConfig?.embeddings;
  const methodChanged = previous != null && previous.method !== config.method;
  const modelChanged = previous != null && previous.model !== config.model;
  const dimensionsChanged = previous != null && previous.dimensions !== config.dimensions;
  const effectiveForce = ctx.force || methodChanged || modelChanged || dimensionsChanged;

  if (config.method === "onnx") {
    removeFile(tfidfPath);
  }
  if (methodChanged || modelChanged || dimensionsChanged) {
    removeDirectory(vectorsPath);
  }

  const graphData = JSON.parse(readFileSync(ctx.graphJsonPath, "utf-8")) as GraphData;
  return generateEmbeddings(ctx, graphData, effectiveForce);
};

async function generateEmbeddings(ctx: StepContext, graphData: GraphData, effectiveForce: boolean): Promise<StepResult> {
  const config = ctx.config;
  const method = config.build.embeddings.method;
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
  const previousTexts = effectiveForce ? new Map<string, string>() : loadNodeTextCache(ctx.outputDir);
  const changedIds = effectiveForce
    ? new Set(items.map((item) => item.id))
    : getChangedNodeIds(currentTexts, previousTexts);
  const removedIds = effectiveForce ? new Set<string>() : getRemovedNodeIds(currentTexts, previousTexts);

  const vectorStore = new VectorStore(ctx.outputDir);
  await vectorStore.initialize();

  try {
    const existingRecords = effectiveForce ? [] : await vectorStore.loadAllRecords();
    const existingVectors = new Map(existingRecords.map((record) => [record.id, record.vector]));
    const itemsNeedingEmbeddings = effectiveForce
      ? items
      : items.filter((item) => changedIds.has(item.id) || !existingVectors.has(item.id));

    const staleVectorIds = new Set<string>();
    for (const id of existingVectors.keys()) {
      if (!currentTexts.has(id)) {
        staleVectorIds.add(id);
      }
    }

    if (itemsNeedingEmbeddings.length === 0 && removedIds.size === 0 && staleVectorIds.size === 0) {
      atomicWriteJson(getNodeTextCachePath(ctx.outputDir), Object.fromEntries(currentTexts));
      return { processed: 0, skipped: true, skipReason: "up to date" };
    }

    if (itemsNeedingEmbeddings.length === 0) {
      const cleanedRecords = existingRecords.filter((record) => !staleVectorIds.has(record.id));
      await vectorStore.upsert(cleanedRecords);

      if (method === "tfidf") {
        const engine = new TfidfEmbeddingEngine(config.build.embeddings);
        try {
          engine.buildVocabulary(items.map((item) => item.text));
          atomicWriteJson(join(ctx.outputDir, "tfidf_idf.json"), engine.serializeVocabulary());
        } finally {
          engine.dispose();
        }
      }

      atomicWriteJson(getNodeTextCachePath(ctx.outputDir), Object.fromEntries(currentTexts));
      return { processed: 0, skipped: true, skipReason: "up to date" };
    }

    if (method === "tfidf") {
      return generateTfidf(ctx, graphData, items, itemsNeedingEmbeddings, existingRecords, currentTexts, vectorStore);
    }

    return generateOnnx(ctx, graphData, itemsNeedingEmbeddings, existingRecords, currentTexts, vectorStore);
  } finally {
    await vectorStore.dispose();
  }
}

async function generateTfidf(
  ctx: StepContext,
  graphData: GraphData,
  allItems: Array<{ id: string; text: string }>,
  itemsToEmbed: Array<{ id: string; text: string }>,
  existingRecords: VectorRecord[],
  currentTexts: Map<string, string>,
  vectorStore: VectorStore,
): Promise<StepResult> {
  const engine = new TfidfEmbeddingEngine(ctx.config.build.embeddings);

  try {
    log.info("Generating TF-IDF embeddings...");
    engine.buildVocabulary(allItems.map((item) => item.text));
    const embeddings = itemsToEmbed.length > 0 ? engine.embedBatch(itemsToEmbed) : [];

    await storeEmbeddings({
      graphData,
      embeddings,
      existingRecords,
      currentTexts,
      vectorStore,
      outputDir: ctx.outputDir,
      vocabulary: engine.serializeVocabulary(),
    });

    return { processed: embeddings.length, skipped: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`TF-IDF embeddings failed (non-blocking): ${msg}`);
    return { processed: 0, skipped: true, skipReason: msg };
  } finally {
    engine.dispose();
  }
}

async function generateOnnx(
  ctx: StepContext,
  graphData: GraphData,
  items: Array<{ id: string; text: string }>,
  existingRecords: VectorRecord[],
  currentTexts: Map<string, string>,
  vectorStore: VectorStore,
): Promise<StepResult> {
  const cacheDir = resolveCacheDir(ctx.config.models.cache_dir);
  const engine = new EmbeddingEngine(ctx.config.build.embeddings, cacheDir, ctx.config.models.download_on_first_use);

  try {
    const ready = await engine.initialize();
    if (!ready) {
      return { processed: 0, skipped: true, skipReason: "embedding engine unavailable" };
    }

    log.info("Generating ONNX embeddings...");
    const embeddings = await engine.embedBatch(items);
    await storeEmbeddings({
      graphData,
      embeddings,
      existingRecords,
      currentTexts,
      vectorStore,
      outputDir: ctx.outputDir,
    });

    return { processed: embeddings.length, skipped: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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
  const {
    graphData,
    embeddings,
    existingRecords,
    currentTexts,
    vectorStore,
    outputDir,
    vocabulary,
  } = options;

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
  atomicWriteJson(getNodeTextCachePath(outputDir), Object.fromEntries(currentTexts));

  if (vocabulary) {
    atomicWriteJson(join(outputDir, "tfidf_idf.json"), vocabulary);
  }

  log.info(`  ✓ ${embeddings.length} embeddings generated and indexed`);
}

export function loadNodeTextCache(outputDir: string): Map<string, string> {
  const path = getNodeTextCachePath(outputDir);
  if (!existsSync(path)) return new Map();

  try {
    return new Map(Object.entries(JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>));
  } catch {
    return new Map();
  }
}

export function saveNodeTextCache(outputDir: string, texts: Map<string, string>): void {
  atomicWriteJson(getNodeTextCachePath(outputDir), Object.fromEntries(texts));
}

function getNodeTextCachePath(outputDir: string): string {
  return join(outputDir, ".cache", "node-texts.json");
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

function removeDirectory(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}

function removeFile(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
