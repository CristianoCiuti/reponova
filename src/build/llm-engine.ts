/**
 * LLM engine for generating text completions via node-llama-cpp.
 *
 * Lifecycle: load model → generate N completions → dispose.
 * Never holds the model in memory persistently.
 * Falls back to algorithmic templates if node-llama-cpp is not available.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../shared/utils.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Options for creating an LLM engine instance. */
export interface LlmEngineOptions {
  /** Model URI: HF URI (hf:user/repo:quant) or local file path */
  modelUri: string;
  /** Root cache directory for model downloads */
  cacheDir: string;
  /** GPU backend */
  gpu: "auto" | "cpu" | "cuda" | "metal" | "vulkan";
  /** Context window size in tokens */
  contextSize: number;
  /** CPU threads (0 = auto-detect) */
  threads: number;
  /** Auto-download model on first use */
  downloadOnFirstUse: boolean;
}

export interface LlmCompletionOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

interface LlamaInstance {
  loadModel(opts: unknown): Promise<LlamaModel>;
  dispose(): Promise<void>;
}

interface LlamaModel {
  createContext(opts: unknown): Promise<LlamaContext>;
  dispose(): Promise<void>;
}

interface LlamaContext {
  getSequence(): LlamaSequence;
  dispose(): Promise<void>;
}

interface LlamaSequence {
  clearHistory(): void;
}

interface LlamaChatSessionInstance {
  prompt(text: string, opts: unknown): Promise<string>;
  dispose(): Promise<void>;
}

type LlamaChatSessionConstructor = new (opts: unknown) => LlamaChatSessionInstance;

// ─── LLM Engine ──────────────────────────────────────────────────────────────

export class LlmEngine {
  private llama: LlamaInstance | null = null;
  private model: LlamaModel | null = null;
  private context: LlamaContext | null = null;
  private sequence: LlamaSequence | null = null;
  private ChatSession: LlamaChatSessionConstructor | null = null;
  private options: LlmEngineOptions;
  private cacheDir: string;
  private available = false;

  constructor(options: LlmEngineOptions) {
    this.options = options;
    this.cacheDir = resolveCacheDir(options.cacheDir);
  }

  /**
   * Initialize the LLM: download model if needed, load into memory.
   * Returns false if node-llama-cpp is not available.
   */
  async initialize(): Promise<boolean> {
    let nodeLlamaCpp: {
      getLlama(opts: unknown): Promise<LlamaInstance>;
      resolveModelFile(uri: string, dir: string, opts?: unknown): Promise<string>;
      LlamaChatSession: LlamaChatSessionConstructor;
    };

    try {
      nodeLlamaCpp = await import("node-llama-cpp") as unknown as typeof nodeLlamaCpp;
    } catch {
      log.warn("node-llama-cpp not available — LLM features disabled (install with: npm install node-llama-cpp)");
      return false;
    }

    // Determine GPU setting
    const gpuSetting = this.options.gpu === "auto" ? "auto" : this.options.gpu === "cpu" ? false : this.options.gpu;

    try {
      // Initialize llama backend
      this.llama = await nodeLlamaCpp.getLlama({
        gpu: gpuSetting as "auto" | false,
        logLevel: "warn",
      });

      // Ensure models directory exists
      const modelsDir = join(this.cacheDir, "llm");
      if (!existsSync(modelsDir)) mkdirSync(modelsDir, { recursive: true });

      const modelUri = this.options.modelUri;
      log.info(`Loading LLM model: ${modelUri}...`);

      let modelPath: string;
      try {
        modelPath = await nodeLlamaCpp.resolveModelFile(modelUri, modelsDir, {
          cli: false,
        });
      } catch {
        if (!this.options.downloadOnFirstUse) {
          log.warn("LLM model not found and download_on_first_use is false");
          await this.dispose();
          return false;
        }
        // Try with download enabled
        log.info("  Downloading LLM model (this may take a few minutes)...");
        modelPath = await nodeLlamaCpp.resolveModelFile(modelUri, modelsDir, {
          cli: true,
        });
      }

      // Load model
      this.model = await this.llama.loadModel({
        modelPath,
        gpuLayers: "auto",
      });

      // Create context + single reusable sequence
      const threads = this.options.threads > 0 ? { ideal: this.options.threads } : undefined;
      this.context = await this.model.createContext({
        contextSize: this.options.contextSize,
        threads,
      });
      this.sequence = this.context.getSequence();
      this.ChatSession = nodeLlamaCpp.LlamaChatSession;

      this.available = true;
      log.info("LLM engine initialized");
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to initialize LLM: ${msg}`);
      await this.dispose();
      return false;
    }
  }

  /**
   * Generate a text completion.
   * Reuses the single context sequence — clears history between calls.
   */
  async generate(options: LlmCompletionOptions): Promise<string | null> {
    if (!this.available || !this.sequence || !this.ChatSession) {
      return null;
    }

    try {
      // Clear sequence history so each prompt starts fresh
      this.sequence.clearHistory();

      // Create session on the reused sequence (autoDisposeSequence: false)
      const session = new this.ChatSession({
        contextSequence: this.sequence,
        autoDisposeSequence: false,
        systemPrompt: options.systemPrompt,
      });

      const result = await session.prompt(options.userPrompt, {
        maxTokens: options.maxTokens ?? 200,
        temperature: options.temperature ?? 0.7,
      });

      await session.dispose();
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`LLM generation failed: ${msg}`);
      return null;
    }
  }

  /**
   * Dispose all resources (context → model → llama).
   */
  async dispose(): Promise<void> {
    try {
      this.sequence = null;
      this.ChatSession = null;
      if (this.context) { await this.context.dispose(); this.context = null; }
      if (this.model) { await this.model.dispose(); this.model = null; }
      if (this.llama) { await this.llama.dispose(); this.llama = null; }
    } catch {
      // Suppress errors during cleanup
    }
    this.available = false;
  }

  get isAvailable(): boolean {
    return this.available;
  }
}

// ─── Model Resolution Utilities ──────────────────────────────────────────────

/**
 * Try to resolve a model URI to its local absolute path without downloading.
 * Returns null if node-llama-cpp is unavailable or model is not cached locally.
 */
export async function resolveModelPath(modelUri: string, cacheDir: string): Promise<string | null> {
  try {
    const nodeLlamaCpp = await import("node-llama-cpp") as unknown as {
      resolveModelFile(uri: string, dir: string, opts?: unknown): Promise<string>;
    };
    const modelsDir = join(resolveCacheDir(cacheDir), "llm");
    if (!existsSync(modelsDir)) return null;
    // cli: false throws if model is not cached — no download triggered
    return await nodeLlamaCpp.resolveModelFile(modelUri, modelsDir, { cli: false });
  } catch {
    return null;
  }
}

/**
 * Compare two model URIs for equivalence using resolve-then-compare.
 *
 * Strategy:
 * 1. String equality (covers identical URIs)
 * 2. Both local paths → resolve absolute paths and compare
 * 3. Try node-llama-cpp resolveModelFile for cached HF URIs
 * 4. Fallback: treat as different
 */
export async function areModelsEquivalent(uriA: string, uriB: string, cacheDir: string): Promise<boolean> {
  // 1. String equality
  if (uriA === uriB) return true;

  // 2. Both local paths → resolve and compare absolute paths
  if (!uriA.startsWith("hf:") && !uriB.startsWith("hf:")) {
    return resolve(uriA) === resolve(uriB);
  }

  // 3. Try resolve-then-compare for cached models
  const [pathA, pathB] = await Promise.all([
    resolveModelPath(uriA, cacheDir),
    resolveModelPath(uriB, cacheDir),
  ]);

  if (pathA && pathB) return pathA === pathB;

  return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveCacheDir(configPath: string): string {
  if (configPath.startsWith("~")) {
    return resolve(homedir(), configPath.slice(2));
  }
  return resolve(configPath);
}
