/**
 * LLM Engine Pool — deduplicates model instances across build steps.
 *
 * When community_summaries and node_descriptions reference the same model,
 * the pool returns the same LlmEngine instance. Avoids loading ~350MB twice.
 *
 * Lifecycle:
 * 1. Orchestrator creates pool before intelligence steps
 * 2. Each step calls pool.acquire(uri, contextSize, modelsConfig)
 * 3. Pool returns cached engine or creates a new one
 * 4. Orchestrator calls pool.disposeAll() after all steps complete
 *
 * Context size promotion: if a second acquire() requests a larger context
 * than the cached engine, the pool re-creates with the larger size.
 */
import { log } from "../shared/utils.js";
import { LlmEngine, areModelsEquivalent, type LlmEngineOptions } from "./llm-engine.js";
import type { ModelsConfig } from "../shared/types.js";

interface PoolEntry {
  engine: LlmEngine;
  modelUri: string;
  contextSize: number;
  resolvedKey: string;
}

export class LlmEnginePool {
  private entries: PoolEntry[] = [];
  private modelsConfig: ModelsConfig;

  constructor(modelsConfig: ModelsConfig) {
    this.modelsConfig = modelsConfig;
  }

  /**
   * Acquire an LLM engine for the given model URI.
   * Returns a cached instance if an equivalent model is already loaded.
   * Returns null if the engine fails to initialize.
   */
  async acquire(modelUri: string, contextSize: number): Promise<LlmEngine | null> {
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

    // No cached engine — create new
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
