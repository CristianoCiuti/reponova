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
import type { LlmConfig } from "../shared/types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

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
  private config: LlmConfig;
  private cacheDir: string;
  private available = false;

  constructor(config: LlmConfig) {
    this.config = config;
    this.cacheDir = resolveCacheDir(config.cache_dir);
  }

  /**
   * Initialize the LLM: download model if needed, load into memory.
   * Returns false if node-llama-cpp is not available.
   */
  async initialize(): Promise<boolean> {
    if (!this.config.enabled) {
      log.info("LLM disabled in config");
      return false;
    }

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
    const gpuSetting = this.config.gpu === "auto" ? "auto" : this.config.gpu === "cpu" ? false : this.config.gpu;

    try {
      // Initialize llama backend
      this.llama = await nodeLlamaCpp.getLlama({
        gpu: gpuSetting as "auto" | false,
        logLevel: "warn",
      });

      // Download model if needed
      const modelsDir = join(this.cacheDir, "llm");
      if (!existsSync(modelsDir)) mkdirSync(modelsDir, { recursive: true });

      const modelUri = this.buildModelUri();
      log.info(`Loading LLM model: ${this.config.model} (${this.config.quantization})...`);

      let modelPath: string;
      try {
        modelPath = await nodeLlamaCpp.resolveModelFile(modelUri, modelsDir, {
          cli: false,
        });
      } catch {
        if (!this.config.download_on_first_use) {
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
      const threads = this.config.threads > 0 ? { ideal: this.config.threads } : undefined;
      this.context = await this.model.createContext({
        contextSize: this.config.context_size,
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
    if (!this.available || !this.sequence || !this.ChatSession) return null;

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
   * Generate multiple completions in batch.
   */
  async generateBatch(prompts: LlmCompletionOptions[]): Promise<Array<string | null>> {
    const results: Array<string | null> = [];
    let failures = 0;

    for (let i = 0; i < prompts.length; i++) {
      const result = await this.generate(prompts[i]!);
      results.push(result);

      if (result === null) failures++;

      // If too many consecutive failures, abort early (model is broken)
      if (failures > 5 && results.every(r => r === null)) {
        log.warn(`  LLM producing no results — aborting batch after ${i + 1} attempts`);
        // Fill remaining with null
        for (let j = i + 1; j < prompts.length; j++) results.push(null);
        return results;
      }

      if (i > 0 && i % 10 === 0) {
        log.info(`  Generated ${i}/${prompts.length} summaries...`);
      }
    }
    return results;
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

  /**
   * Build the HuggingFace GGUF URI from config model name.
   * Maps shorthand model names to HF repo paths.
   */
  private buildModelUri(): string {
    const model = this.config.model.toLowerCase();
    const quant = this.config.quantization;

    // Map common shorthand names to HF GGUF repos
    if (model.includes("qwen2.5-0.5b")) {
      return `hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:${quant}`;
    }
    if (model.includes("qwen2.5-1.5b")) {
      return `hf:Qwen/Qwen2.5-1.5B-Instruct-GGUF:${quant}`;
    }
    if (model.includes("qwen2.5-3b")) {
      return `hf:Qwen/Qwen2.5-3B-Instruct-GGUF:${quant}`;
    }
    if (model.includes("qwen2.5-7b")) {
      return `hf:Qwen/Qwen2.5-7B-Instruct-GGUF:${quant}`;
    }

    // If it already looks like a HF URI, use as-is
    if (model.startsWith("hf:")) {
      return model;
    }

    // Default fallback: treat as qwen2.5 0.5B
    return `hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:${quant}`;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveCacheDir(configPath: string): string {
  if (configPath.startsWith("~")) {
    return resolve(homedir(), configPath.slice(2));
  }
  return resolve(configPath);
}
