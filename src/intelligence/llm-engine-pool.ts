/**
 * LLM Engine Pool — deduplicates model instances across build phases.
 *
 * When community_summaries and node_descriptions reference the same model,
 * the pool returns the same LlmEngine instance. Avoids loading ~350MB twice.
 *
 * Lifecycle:
 * 1. Build entry point (build.ts) creates pool and injects it into PhaseContext
 * 2. Provider registry calls pool.acquire(uri, contextSize)
 * 3. Pool returns cached engine or creates a new one
 * 4. Build entry point calls pool.disposeAll() after all phases complete
 *
 * Context size promotion: if a second acquire() requests a larger context
 * than the cached engine, the pool re-creates with the larger size.
 */
import { log } from "../shared/utils.js";
import { LlmEngine, areModelsEquivalent, type LlmEngineOptions } from "./local-llm-engine.js";
import type { ModelsConfig } from "../shared/types.js";
import type { LlmProvider } from "./llm-provider.js";

interface PoolEntry {
  engine: LlmEngine;
  modelUri: string;
  contextSize: number;
  resolvedKey: string;
}

export class LlmEnginePool {
  private entries: PoolEntry[] = [];
  private modelsConfig: ModelsConfig;
  private inFlightAcquires = new Map<string, Promise<LlmProvider | null>>();

  constructor(modelsConfig: ModelsConfig) {
    this.modelsConfig = modelsConfig;
  }

  /**
   * Acquire an LLM engine for the given model URI.
   * Returns a cached instance if an equivalent model is already loaded.
   * Deduplicates concurrent callers: if another acquire() for the same URI
   * is in-flight, the second caller awaits the same Promise instead of
   * creating a duplicate engine.
   * Returns null if the engine fails to initialize.
   */
  async acquire(modelUri: string, contextSize: number): Promise<LlmProvider | null> {
    // Check if we already have an equivalent engine
    for (const entry of this.entries) {
      const same = await areModelsEquivalent(modelUri, entry.modelUri, this.modelsConfig.cache_dir);
      if (!same) continue;

      // Context size promotion: re-create if requested context is larger
      if (contextSize > entry.contextSize) {
        log.info(`LLM pool: promoting context size ${entry.contextSize} → ${contextSize} for ${modelUri}`);
        await entry.engine.dispose();
        const promoted = this.createEngine(modelUri, contextSize);
        const ready = await promoted.initialize();
        if (!ready) {
          this.entries = this.entries.filter((e) => e !== entry);
          return null;
        }
        entry.engine = promoted;
        entry.contextSize = contextSize;
      }

      return entry.engine;
    }

    // Deduplicate concurrent acquires for the same model URI.
    // Without this, two phases calling acquire() before either completes
    // initialization would each create their own engine (double memory).
    const inFlight = this.inFlightAcquires.get(modelUri);
    if (inFlight) {
      return inFlight;
    }

    // No cached engine — create new with in-flight tracking
    const promise = (async (): Promise<LlmProvider | null> => {
      const engine = this.createEngine(modelUri, contextSize);
      const ready = await engine.initialize();
      if (!ready) return null;

      this.entries.push({
        engine,
        modelUri,
        contextSize,
        resolvedKey: modelUri,
      });

      return engine;
    })();

    this.inFlightAcquires.set(modelUri, promise);
    try {
      return await promise;
    } finally {
      this.inFlightAcquires.delete(modelUri);
    }
  }

  /**
   * Dispose all cached engines. Call after all intelligence steps complete.
   */
  async disposeAll(): Promise<void> {
    for (const entry of this.entries) {
      await entry.engine.dispose();
    }
    this.entries = [];
  }

  private createEngine(modelUri: string, contextSize: number): LlmEngine {
    const options: LlmEngineOptions = {
      modelUri,
      cacheDir: this.modelsConfig.cache_dir,
      gpu: this.modelsConfig.gpu,
      contextSize,
      threads: this.modelsConfig.threads,
      downloadOnFirstUse: this.modelsConfig.download_on_first_use,
    };
    return new LlmEngine(options);
  }
}
