/**
 * Embedding engine for generating vector representations of graph nodes.
 *
 * Uses onnxruntime-node with all-MiniLM-L6-v2 ONNX model (384-dim).
 * Includes a minimal BertTokenizer implementation (no external tokenizer dep).
 * Gracefully degrades if onnxruntime-node is not available.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../shared/utils.js";
import type { EmbeddingsConfig } from "../shared/types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EmbeddingResult {
  id: string;
  text: string;
  vector: Float32Array;
}

interface OnnxSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | BigInt64Array; dims: number[] }>>;
  release(): Promise<void>;
}

interface OrtModule {
  InferenceSession: { create(path: string, opts?: unknown): Promise<OnnxSession> };
  Tensor: unknown;
}

// ─── Model URLs ──────────────────────────────────────────────────────────────

const MODEL_BASE_URL = "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main";
const MODEL_FILES = {
  model: "onnx/model.onnx",
  vocab: "vocab.txt",
  tokenizer_config: "tokenizer_config.json",
};

const MAX_SEQ_LENGTH = 256;
const EMBEDDING_DIM = 384;

// ─── BertTokenizer (minimal implementation) ──────────────────────────────────

class BertTokenizer {
  private vocab: Map<string, number> = new Map();
  private unkId = 0;
  private clsId = 101;
  private sepId = 102;
  private padId = 0;

  constructor(vocabText: string) {
    const lines = vocabText.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const token = lines[i]!.trim();
      if (token) this.vocab.set(token, i);
    }
    this.unkId = this.vocab.get("[UNK]") ?? 0;
    this.clsId = this.vocab.get("[CLS]") ?? 101;
    this.sepId = this.vocab.get("[SEP]") ?? 102;
    this.padId = this.vocab.get("[PAD]") ?? 0;
  }

  encode(text: string, maxLength: number = MAX_SEQ_LENGTH): { inputIds: bigint[]; attentionMask: bigint[]; tokenTypeIds: bigint[] } {
    // Basic normalization: lowercase, strip accents, clean whitespace
    const normalized = text.toLowerCase().replace(/[\u0300-\u036f]/g, "").trim();

    // Basic tokenization: split on whitespace and punctuation
    const words = this.basicTokenize(normalized);

    // WordPiece tokenization
    const tokens: number[] = [this.clsId];
    for (const word of words) {
      const subTokens = this.wordPieceTokenize(word);
      if (tokens.length + subTokens.length >= maxLength - 1) break;
      tokens.push(...subTokens);
    }
    tokens.push(this.sepId);

    // Pad to maxLength
    const inputIds: bigint[] = new Array(maxLength).fill(BigInt(this.padId));
    const attentionMask: bigint[] = new Array(maxLength).fill(0n);
    const tokenTypeIds: bigint[] = new Array(maxLength).fill(0n);

    for (let i = 0; i < tokens.length; i++) {
      inputIds[i] = BigInt(tokens[i]!);
      attentionMask[i] = 1n;
    }

    return { inputIds, attentionMask, tokenTypeIds };
  }

  private basicTokenize(text: string): string[] {
    // Insert space around punctuation, then split
    const spaced = text.replace(/([^\w\s])/g, " $1 ");
    return spaced.split(/\s+/).filter(Boolean);
  }

  private wordPieceTokenize(word: string): number[] {
    const tokens: number[] = [];
    let start = 0;

    while (start < word.length) {
      let end = word.length;
      let found = false;

      while (start < end) {
        const substr = start === 0 ? word.slice(start, end) : `##${word.slice(start, end)}`;
        if (this.vocab.has(substr)) {
          tokens.push(this.vocab.get(substr)!);
          found = true;
          break;
        }
        end--;
      }

      if (!found) {
        tokens.push(this.unkId);
        break;
      }
      start = end;
    }

    return tokens;
  }
}

// ─── Embedding Engine ────────────────────────────────────────────────────────

export class EmbeddingEngine {
  private session: OnnxSession | null = null;
  private tokenizer: BertTokenizer | null = null;
  private config: EmbeddingsConfig;
  private cacheDir: string;
  private available = false;

  constructor(config: EmbeddingsConfig) {
    this.config = config;
    this.cacheDir = resolveCacheDir(config.cache_dir);
  }

  /**
   * Initialize the engine: load ONNX runtime, download model if needed, init tokenizer.
   * Returns false if onnxruntime-node is not available (graceful degradation).
   */
  async initialize(): Promise<boolean> {
    if (!this.config.enabled) {
      log.info("Embeddings disabled in config");
      return false;
    }

    // Try to import onnxruntime-node
    let ort: OrtModule;
    try {
      ort = await import("onnxruntime-node") as unknown as OrtModule;
    } catch {
      log.warn("onnxruntime-node not available — embeddings disabled (install with: npm install onnxruntime-node)");
      return false;
    }

    // Ensure model is downloaded
    const modelDir = join(this.cacheDir, "all-MiniLM-L6-v2");
    const modelPath = join(modelDir, "model.onnx");
    const vocabPath = join(modelDir, "vocab.txt");

    if (!existsSync(modelPath) || !existsSync(vocabPath)) {
      log.info("Downloading embedding model (all-MiniLM-L6-v2)...");
      try {
        await this.downloadModel(modelDir);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Failed to download embedding model: ${msg}`);
        return false;
      }
    }

    // Load tokenizer
    const vocabText = readFileSync(vocabPath, "utf-8");
    this.tokenizer = new BertTokenizer(vocabText);

    // Create ONNX session
    try {
      this.session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
      }) as unknown as OnnxSession;
      this.available = true;
      log.info("Embedding engine initialized (all-MiniLM-L6-v2, 384-dim)");
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to load ONNX model: ${msg}`);
      return false;
    }
  }

  /**
   * Generate embeddings for a batch of texts.
   */
  async embedBatch(items: Array<{ id: string; text: string }>): Promise<EmbeddingResult[]> {
    if (!this.available || !this.session || !this.tokenizer) return [];

    const results: EmbeddingResult[] = [];
    const batchSize = this.config.batch_size;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await this.embedBatchInternal(batch);
      results.push(...batchResults);

      if (i > 0 && i % (batchSize * 10) === 0) {
        log.info(`  Embedded ${i}/${items.length} nodes...`);
      }
    }

    return results;
  }

  private async embedBatchInternal(items: Array<{ id: string; text: string }>): Promise<EmbeddingResult[]> {
    if (!this.session || !this.tokenizer) return [];

    // We process one at a time (onnxruntime-node on CPU is fast enough)
    // Batching adds complexity with padding alignment — single inference is simpler
    const results: EmbeddingResult[] = [];
    let ort: { Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown };

    try {
      ort = await import("onnxruntime-node") as unknown as typeof ort;
    } catch {
      return [];
    }

    for (const item of items) {
      const { inputIds, attentionMask, tokenTypeIds } = this.tokenizer.encode(item.text, MAX_SEQ_LENGTH);

      const feeds = {
        input_ids: new ort.Tensor("int64", new BigInt64Array(inputIds), [1, MAX_SEQ_LENGTH]),
        attention_mask: new ort.Tensor("int64", new BigInt64Array(attentionMask), [1, MAX_SEQ_LENGTH]),
        token_type_ids: new ort.Tensor("int64", new BigInt64Array(tokenTypeIds), [1, MAX_SEQ_LENGTH]),
      };

      const output = await this.session.run(feeds as Record<string, unknown>);
      const lastHidden = output.last_hidden_state;
      if (!lastHidden) continue;

      // Mean pooling over non-padded tokens
      const seqLen = Number(attentionMask.filter(m => m === 1n).length);
      const vector = this.meanPool(lastHidden.data as Float32Array, seqLen, lastHidden.dims);

      // L2 normalize
      const normalized = this.l2Normalize(vector);
      results.push({ id: item.id, text: item.text, vector: normalized });
    }

    return results;
  }

  private meanPool(data: Float32Array, seqLen: number, dims: number[]): Float32Array {
    const embDim = dims[2] || EMBEDDING_DIM;
    const result = new Float32Array(embDim);

    // data shape: [1, seq_length, emb_dim]
    for (let t = 0; t < seqLen; t++) {
      for (let d = 0; d < embDim; d++) {
        result[d] = (result[d] as number) + (data[t * embDim + d] as number);
      }
    }

    for (let d = 0; d < embDim; d++) {
      result[d] = (result[d] as number) / seqLen;
    }

    return result;
  }

  private l2Normalize(vector: Float32Array): Float32Array {
    let norm = 0;
    for (let i = 0; i < vector.length; i++) {
      norm += (vector[i] as number) * (vector[i] as number);
    }
    norm = Math.sqrt(norm);
    if (norm === 0) return vector;

    const result = new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i++) {
      result[i] = (vector[i] as number) / norm;
    }
    return result;
  }

  private async downloadModel(modelDir: string): Promise<void> {
    if (!existsSync(modelDir)) mkdirSync(modelDir, { recursive: true });

    for (const [key, relativePath] of Object.entries(MODEL_FILES)) {
      const url = `${MODEL_BASE_URL}/${relativePath}`;
      const localPath = join(modelDir, key === "model" ? "model.onnx" : relativePath.split("/").pop()!);

      if (existsSync(localPath)) continue;

      log.info(`  Downloading ${key}...`);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} downloading ${url}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(localPath, buffer);
      log.info(`  ✓ ${key} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
    }
  }

  /**
   * Release ONNX session resources.
   */
  async dispose(): Promise<void> {
    if (this.session) {
      await this.session.release();
      this.session = null;
    }
    this.available = false;
  }

  get isAvailable(): boolean {
    return this.available;
  }
}

// ─── Text composition for graph nodes ────────────────────────────────────────

export interface NodeEmbeddingInput {
  id: string;
  label: string;
  type: string;
  signature?: string;
  docstring?: string;
  bases?: string[];
  source_file?: string;
}

/**
 * Compose embedding text for a graph node based on its type.
 * Truncated to 512 chars to fit model's effective window.
 */
export function composeNodeText(node: NodeEmbeddingInput): string {
  let text: string;

  switch (node.type) {
    case "function":
    case "method":
      text = `${node.label} ${node.signature ?? ""} ${node.docstring ?? ""}`;
      break;
    case "class":
      text = `${node.label} bases:${(node.bases ?? []).join(",")} ${node.docstring ?? ""}`;
      break;
    case "document":
    case "section":
      text = `${node.label} ${node.docstring ?? ""}`;
      break;
    case "module":
      text = `${node.source_file ?? node.label} ${node.docstring ?? ""}`;
      break;
    default:
      text = `${node.label} ${node.signature ?? ""} ${node.docstring ?? ""}`;
  }

  return text.replace(/\s+/g, " ").trim().slice(0, 512);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveCacheDir(configPath: string): string {
  if (configPath.startsWith("~")) {
    return resolve(homedir(), configPath.slice(2));
  }
  return resolve(configPath);
}
