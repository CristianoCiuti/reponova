/**
 * Local LLM engine for generating text completions via node-llama-cpp.
 * Implements the LlmProvider interface for use by the provider registry.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { log, errorMessage } from "../shared/utils.js";
import { resolveCacheDir } from "./cache-dir.js";
import type { LlmProvider, LlmCompletionOptions } from "./llm-provider.js";

export type { LlmCompletionOptions };

export interface LlmEngineOptions {
  modelUri: string;
  cacheDir: string;
  gpu: "auto" | "cpu" | "cuda" | "metal" | "vulkan";
  contextSize: number;
  threads: number;
  downloadOnFirstUse: boolean;
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

export class LlmEngine implements LlmProvider {
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

    const gpuSetting = this.options.gpu === "auto" ? "auto" : this.options.gpu === "cpu" ? false : this.options.gpu;

    try {
      this.llama = await nodeLlamaCpp.getLlama({
        gpu: gpuSetting as "auto" | false,
        logLevel: "warn",
      });

      const modelsDir = join(this.cacheDir, "llm");
      if (!existsSync(modelsDir)) mkdirSync(modelsDir, { recursive: true });

      const modelUri = this.options.modelUri;
      log.info(`Loading LLM model: ${modelUri}...`);

      let modelPath: string;
      try {
        modelPath = await nodeLlamaCpp.resolveModelFile(modelUri, modelsDir, { cli: false });
      } catch {
        if (!this.options.downloadOnFirstUse) {
          log.warn("LLM model not found and download_on_first_use is false");
          await this.dispose();
          return false;
        }
        log.info("  Downloading LLM model (this may take a few minutes)...");
        modelPath = await nodeLlamaCpp.resolveModelFile(modelUri, modelsDir, { cli: true });
      }

      this.model = await this.llama.loadModel({ modelPath, gpuLayers: "auto" });

      const threads = this.options.threads > 0 ? { ideal: this.options.threads } : undefined;
      this.context = await this.model.createContext({ contextSize: this.options.contextSize, threads });
      this.sequence = this.context.getSequence();
      this.ChatSession = nodeLlamaCpp.LlamaChatSession;

      this.available = true;
      log.info("LLM engine initialized");
      return true;
    } catch (err) {
      const msg = errorMessage(err);
      log.warn(`Failed to initialize LLM: ${msg}`);
      await this.dispose();
      return false;
    }
  }

  async generate(options: LlmCompletionOptions): Promise<string | null> {
    if (!this.available || !this.sequence || !this.ChatSession) return null;

    try {
      this.sequence.clearHistory();
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
      const msg = errorMessage(err);
      log.warn(`LLM generation failed: ${msg}`);
      return null;
    }
  }

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

export async function resolveModelPath(modelUri: string, cacheDir: string): Promise<string | null> {
  try {
    const nodeLlamaCpp = await import("node-llama-cpp") as unknown as {
      resolveModelFile(uri: string, dir: string, opts?: unknown): Promise<string>;
    };
    const modelsDir = join(resolveCacheDir(cacheDir), "llm");
    if (!existsSync(modelsDir)) return null;
    return await nodeLlamaCpp.resolveModelFile(modelUri, modelsDir, { cli: false });
  } catch {
    return null;
  }
}

export async function areModelsEquivalent(uriA: string, uriB: string, cacheDir: string): Promise<boolean> {
  if (uriA === uriB) return true;

  if (!uriA.startsWith("hf:") && !uriB.startsWith("hf:")) {
    return resolve(uriA) === resolve(uriB);
  }

  const [pathA, pathB] = await Promise.all([
    resolveModelPath(uriA, cacheDir),
    resolveModelPath(uriB, cacheDir),
  ]);

  if (pathA && pathB) return pathA === pathB;
  return false;
}
