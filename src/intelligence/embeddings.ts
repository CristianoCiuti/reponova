/**
 * Embedding engine for generating vector representations of graph nodes.
 *
 * Uses onnxruntime-node with all-MiniLM-L6-v2 ONNX model (384-dim).
 * Includes a minimal BertTokenizer implementation (no external tokenizer dep).
 * Gracefully degrades if onnxruntime-node is not available.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { posixBasename } from "../shared/paths.js";
import { log, errorMessage, ProgressTimer } from "../shared/utils.js";
import { resolveCacheDir } from "./cache-dir.js";
import type { EmbeddingProvider } from "./llm-provider.js";

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
    const normalized = text.toLowerCase().replace(/[\u0300-\u036f]/g, "").trim();
    const words = this.basicTokenize(normalized);
    const tokens: number[] = [this.clsId];
    for (const word of words) {
      const subTokens = this.wordPieceTokenize(word);
      if (tokens.length + subTokens.length >= maxLength - 1) break;
      tokens.push(...subTokens);
    }
    tokens.push(this.sepId);

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
  private modelName: string;
  private cacheDir: string;
  private downloadOnFirstUse: boolean;
  private available = false;

  constructor(modelName: string, cacheDir: string, downloadOnFirstUse = true) {
    this.modelName = modelName;
    this.cacheDir = resolveCacheDir(cacheDir);
    this.downloadOnFirstUse = downloadOnFirstUse;
  }

  async initialize(): Promise<boolean> {
    let ort: OrtModule;
    try {
      ort = await import("onnxruntime-node") as unknown as OrtModule;
    } catch {
      log.warn("onnxruntime-node not available — embeddings disabled (install with: npm install onnxruntime-node)");
      return false;
    }

    const modelDir = join(this.cacheDir, this.modelName);
    const modelPath = join(modelDir, "model.onnx");
    const vocabPath = join(modelDir, "vocab.txt");

    if (!existsSync(modelPath) || !existsSync(vocabPath)) {
      if (!this.downloadOnFirstUse) {
        log.warn(`Embedding model "${this.modelName}" not found and download_on_first_use is false`);
        return false;
      }
      log.info(`Downloading embedding model (${this.modelName})...`);
      try {
        await this.downloadModel(modelDir);
      } catch (err) {
        const msg = errorMessage(err);
        log.warn(`Failed to download embedding model: ${msg}`);
        return false;
      }
    }

    const vocabText = readFileSync(vocabPath, "utf-8");
    this.tokenizer = new BertTokenizer(vocabText);

    try {
      this.session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
      }) as unknown as OnnxSession;
      this.available = true;
      log.info(`Embedding engine initialized (${this.modelName}, ${EMBEDDING_DIM}-dim)`);
      return true;
    } catch (err) {
      const msg = errorMessage(err);
      log.warn(`Failed to load ONNX model: ${msg}`);
      return false;
    }
  }

  async embedBatch(items: Array<{ id: string; text: string }>): Promise<EmbeddingResult[]> {
    if (!this.available || !this.session || !this.tokenizer) return [];

    const results: EmbeddingResult[] = [];
    const batchSize = items.length > 0 ? items.length : 1;
    const total = items.length;
    const timer = new ProgressTimer(total);
    const progressInterval = Math.max(batchSize * 10, Math.floor(total / 10));

    for (let i = 0; i < total; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await this.embedBatchInternal(batch);
      results.push(...batchResults);

      const processed = Math.min(i + batchSize, total);
      if (processed >= total || (i > 0 && i % progressInterval < batchSize)) {
        const { elapsed } = timer.tick(processed - 1);
        const elapsedNum = parseFloat(elapsed);
        const rate = elapsedNum > 0 ? processed / elapsedNum : 0;
        const remaining = rate > 0 ? Math.ceil((total - processed) / rate) : 0;
        if (processed < total) {
          log.info(`  Embedded ${processed}/${total} nodes (${rate.toFixed(1)}/s, ~${formatEta(remaining)} remaining)`);
        }
      }
    }

    return results;
  }

  private async embedBatchInternal(items: Array<{ id: string; text: string }>): Promise<EmbeddingResult[]> {
    if (!this.session || !this.tokenizer) return [];

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

      const seqLen = Number(attentionMask.filter(m => m === 1n).length);
      const vector = this.meanPool(lastHidden.data as Float32Array, seqLen, lastHidden.dims);
      const normalized = this.l2Normalize(vector);
      results.push({ id: item.id, text: item.text, vector: normalized });
    }

    return results;
  }

  private meanPool(data: Float32Array, seqLen: number, dims: number[]): Float32Array {
    const embDim = dims[2] || EMBEDDING_DIM;
    const result = new Float32Array(embDim);

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

    const baseUrl = `https://huggingface.co/sentence-transformers/${this.modelName}/resolve/main`;

    for (const [key, relativePath] of Object.entries(MODEL_FILES)) {
      const url = `${baseUrl}/${relativePath}`;
      const localPath = join(modelDir, key === "model" ? "model.onnx" : posixBasename(relativePath));

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

export class OnnxEmbeddingAdapter implements EmbeddingProvider {
  private engine: EmbeddingEngine;

  constructor(modelName: string, cacheDir: string, downloadOnFirstUse: boolean) {
    this.engine = new EmbeddingEngine(modelName, cacheDir, downloadOnFirstUse);
  }

  get isAvailable(): boolean {
    return this.engine.isAvailable;
  }

  async initialize(): Promise<boolean> {
    return this.engine.initialize();
  }

  async embedBatch(items: Array<{ id: string; text: string }>): Promise<EmbeddingResult[]> {
    return this.engine.embedBatch(items);
  }

  async dispose(): Promise<void> {
    return this.engine.dispose();
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
 * Enriched: includes community summary + node description when available.
 * Truncated to 512 chars to fit model's effective window.
 */
export function composeNodeText(
  node: NodeEmbeddingInput,
  communitySummary?: string,
  nodeDescription?: string,
): string {
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
    case "diagram":
    case "section":
      text = `${node.label} ${node.docstring ?? ""}`;
      break;
    case "module":
      text = `${node.source_file ?? node.label} ${node.docstring ?? ""}`;
      break;
    default:
      text = `${node.label} ${node.signature ?? ""} ${node.docstring ?? ""}`;
  }

  if (nodeDescription) text += ` ${nodeDescription}`;
  if (communitySummary) text += ` context: ${communitySummary}`;

  return text.replace(/\s+/g, " ").trim().slice(0, 512);
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}
