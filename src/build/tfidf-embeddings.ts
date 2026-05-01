/**
 * TF-IDF embedding engine using feature hashing.
 *
 * Produces fixed-size dense vectors (default 384-dim) compatible with
 * the same vector store and cosine similarity used by the ONNX embedder.
 *
 * Two-pass approach:
 * 1. First pass: compute document frequencies (DF) across all texts
 * 2. Second pass: compute TF-IDF weighted feature-hashed vectors
 *
 * No external dependencies. Runs in milliseconds for 10k+ nodes.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../shared/utils.js";
import type { EmbeddingsConfig } from "../shared/types.js";
import type { EmbeddingResult } from "./embeddings.js";

// ─── TF-IDF Engine ──────────────────────────────────────────────────────────

export class TfidfEmbeddingEngine {
  private dimensions: number;
  private idf: Map<string, number> = new Map();
  private ready = false;

  constructor(config: EmbeddingsConfig) {
    this.dimensions = config.dimensions;
  }

  /**
   * Build the IDF table from all texts. Must be called before embedBatch.
   */
  buildVocabulary(texts: string[]): void {
    const docCount = texts.length;
    const df = new Map<string, number>();

    for (const text of texts) {
      const uniqueTerms = new Set(tokenize(text));
      for (const term of uniqueTerms) {
        df.set(term, (df.get(term) ?? 0) + 1);
      }
    }

    // IDF = log(N / df) + 1 (smoothed)
    for (const [term, count] of df) {
      this.idf.set(term, Math.log(docCount / count) + 1);
    }

    this.ready = true;
    log.info(`TF-IDF vocabulary: ${this.idf.size} terms from ${docCount} documents`);
  }

  /**
   * Generate embeddings for a batch of items.
   * Returns 384-dim dense vectors via feature hashing + TF-IDF weighting.
   */
  embedBatch(items: Array<{ id: string; text: string }>): EmbeddingResult[] {
    if (!this.ready) throw new Error("Call buildVocabulary() before embedBatch()");

    const results: EmbeddingResult[] = [];

    for (const item of items) {
      const vector = this.tfidfVector(item.text);
      results.push({
        id: item.id,
        text: item.text,
        vector: new Float32Array(vector),
      });
    }

    return results;
  }

  /**
   * Embed a single query string (for search-time).
   * Uses the pre-built IDF table.
   */
  embedQuery(text: string): number[] {
    if (!this.ready) throw new Error("Call buildVocabulary() before embedQuery()");
    return this.tfidfVector(text);
  }

  private tfidfVector(text: string): number[] {
    const terms = tokenize(text);
    const vec = new Array<number>(this.dimensions).fill(0);

    // Term frequency
    const tf = new Map<string, number>();
    for (const term of terms) {
      tf.set(term, (tf.get(term) ?? 0) + 1);
    }

    // TF-IDF weighted feature hashing
    const termCount = terms.length || 1;
    for (const [term, count] of tf) {
      const idfWeight = this.idf.get(term) ?? 1;
      const tfidf = (count / termCount) * idfWeight;

      // Feature hashing: map term to bucket via FNV-1a hash
      const bucket = fnv1aHash(term) % this.dimensions;
      // Sign hashing to reduce collision bias
      const sign = fnv1aHash(term + "_sign") % 2 === 0 ? 1 : -1;
      vec[bucket]! += sign * tfidf;
    }

    // L2 normalize
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i]! /= norm;

    return vec;
  }

  dispose(): void {
    this.idf.clear();
    this.ready = false;
  }

  /**
   * Save IDF table to disk so it can be loaded at query time.
   */
  saveVocabulary(outputDir: string): void {
    const data = Object.fromEntries(this.idf);
    writeFileSync(join(outputDir, "tfidf_idf.json"), JSON.stringify(data));
  }

  /**
   * Load a pre-built IDF table from disk (for query-time embedding).
   */
  loadVocabulary(outputDir: string): boolean {
    const path = join(outputDir, "tfidf_idf.json");
    if (!existsSync(path)) return false;

    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, number>;
      this.idf = new Map(Object.entries(data));
      this.ready = true;
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────

/**
 * Simple tokenizer: lowercase, split on non-alphanumeric, filter short tokens.
 * Also splits camelCase and snake_case.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // Split camelCase: "HivePathBuilder" → "hive path builder"
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    // Split snake_case: "create_spark_session" → "create spark session"
    .replace(/_/g, " ")
    // Remove non-alphanumeric
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

// ─── FNV-1a Hash ─────────────────────────────────────────────────────────────

/**
 * FNV-1a 32-bit hash (unsigned). Fast, good distribution for feature hashing.
 */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
