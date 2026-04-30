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
  getSequence(): unknown;
  dispose(): Promise<void>;
}

interface LlamaChatSessionInstance {
  prompt(text: string, opts: unknown): Promise<string>;
  dispose(): Promise<void>;
}

// ─── LLM Engine ──────────────────────────────────────────────────────────────

export class LlmEngine {
  private llama: LlamaInstance | null = null;
  private model: LlamaModel | null = null;
  private context: LlamaContext | null = null;
  private session: LlamaChatSessionInstance | null = null;
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
      LlamaChatSession: new (opts: unknown) => LlamaChatSessionInstance;
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

      const modelUri = `hf:Qwen/Qwen2.5-3B-Instruct-GGUF:${this.config.quantization}`;
      log.info(`Loading LLM model: ${this.config.model} (${this.config.quantization})...`);

      let modelPath: string;
      try {
        modelPath = await nodeLlamaCpp.resolveModelFile(modelUri, modelsDir, {
          cli: false,
        });
      } catch (err) {
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

      // Create context
      const threads = this.config.threads > 0 ? { ideal: this.config.threads } : undefined;
      this.context = await this.model.createContext({
        contextSize: this.config.context_size,
        threads,
      });

      // Create session
      this.session = new nodeLlamaCpp.LlamaChatSession({
        contextSequence: this.context.getSequence(),
      });

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
   */
  async generate(options: LlmCompletionOptions): Promise<string | null> {
    if (!this.available || !this.session) return null;

    try {
      // For each generation, we create a fresh session to avoid context pollution
      let nodeLlamaCpp: { LlamaChatSession: new (opts: unknown) => LlamaChatSessionInstance };
      try {
        nodeLlamaCpp = await import("node-llama-cpp") as unknown as typeof nodeLlamaCpp;
      } catch {
        return null;
      }

      // Create a fresh session with the system prompt
      const freshSession = new nodeLlamaCpp.LlamaChatSession({
        contextSequence: this.context!.getSequence(),
        systemPrompt: options.systemPrompt,
      });

      const result = await freshSession.prompt(options.userPrompt, {
        maxTokens: options.maxTokens ?? 200,
        temperature: options.temperature ?? 0.7,
      });

      await freshSession.dispose();
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
    for (let i = 0; i < prompts.length; i++) {
      const result = await this.generate(prompts[i]!);
      results.push(result);

      if (i > 0 && i % 10 === 0) {
        log.info(`  Generated ${i}/${prompts.length} summaries...`);
      }
    }
    return results;
  }

  /**
   * Dispose all resources (session → context → model → llama).
   */
  async dispose(): Promise<void> {
    try {
      if (this.session) { await this.session.dispose(); this.session = null; }
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveCacheDir(configPath: string): string {
  if (configPath.startsWith("~")) {
    return resolve(homedir(), configPath.slice(2));
  }
  return resolve(configPath);
}
