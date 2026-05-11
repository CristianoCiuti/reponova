/**
 * BUG-E2E-002: LlmEnginePool shared across phases.
 *
 * Root cause: community-summaries and node-descriptions (both DAG Level 3)
 * each created their own LlmEnginePool, loading the same GGUF model twice
 * in RAM → OOM → segfault.
 *
 * Fix: single LlmEnginePool injected via PhaseContext.llmPool.
 *
 * These tests verify:
 * 1. Shared pool returns same engine for same model URI (cross-phase dedup)
 * 2. Separate pools create duplicate engines (documents the old bug)
 * 3. Concurrent acquire() calls on shared pool only create one engine
 * 4. Different model URIs get different engines
 * 5. Context size promotion works
 * 6. disposeAll cleans up all engines
 * 7. Failed initialization returns null without polluting the pool
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Mock LlmEngine to track instance creation ──────────────────────────────

let engineInstanceCount = 0;
let initShouldFail = false;

vi.mock("../src/intelligence/local-llm-engine.js", () => {
  class MockLlmEngine {
    instanceId: number;
    disposed = false;
    options: any;

    constructor(options: any) {
      this.instanceId = ++engineInstanceCount;
      this.options = options;
    }

    async initialize(): Promise<boolean> {
      if (initShouldFail) return false;
      // Simulate async work (model loading) — forces yield
      await new Promise((r) => setTimeout(r, 5));
      return true;
    }

    async dispose(): Promise<void> {
      this.disposed = true;
    }

    get isAvailable(): boolean {
      return !this.disposed;
    }
  }

  return {
    LlmEngine: MockLlmEngine,
    areModelsEquivalent: async (a: string, b: string, _cacheDir: string) => a === b,
  };
});

import { LlmEnginePool } from "../src/intelligence/llm-engine-pool.js";
import type { ModelsConfig } from "../src/shared/types.js";

const modelsConfig: ModelsConfig = {
  cache_dir: "~/.cache/reponova/models",
  gpu: "cpu",
  threads: 0,
  download_on_first_use: false,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("BUG-E2E-002: LlmEnginePool shared across phases", () => {
  beforeEach(() => {
    engineInstanceCount = 0;
    initShouldFail = false;
  });

  it("shared pool returns same engine for same model URI (cross-phase dedup)", async () => {
    const pool = new LlmEnginePool(modelsConfig);
    const uri = "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M";

    // Phase 1 (community-summaries) acquires
    const engine1 = await pool.acquire(uri, 512);
    // Phase 2 (node-descriptions) acquires same model
    const engine2 = await pool.acquire(uri, 512);

    expect(engine1).not.toBeNull();
    expect(engine1).toBe(engine2);
    expect(engineInstanceCount).toBe(1);

    await pool.disposeAll();
  });

  it("separate pools create duplicate engines (old bug behavior)", async () => {
    // This documents what happened BEFORE the fix:
    // each phase created its own LlmEnginePool
    const pool1 = new LlmEnginePool(modelsConfig);
    const pool2 = new LlmEnginePool(modelsConfig);
    const uri = "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M";

    const engine1 = await pool1.acquire(uri, 512);
    const engine2 = await pool2.acquire(uri, 512);

    expect(engine1).not.toBeNull();
    expect(engine2).not.toBeNull();
    // Two separate engines — double memory usage!
    expect(engine1).not.toBe(engine2);
    expect(engineInstanceCount).toBe(2);

    await pool1.disposeAll();
    await pool2.disposeAll();
  });

  it("concurrent acquire() calls on shared pool only create one engine", async () => {
    const pool = new LlmEnginePool(modelsConfig);
    const uri = "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M";

    // Simulate both phases calling acquire at the same time (DAG Level 3 parallel)
    const [engine1, engine2] = await Promise.all([
      pool.acquire(uri, 512),
      pool.acquire(uri, 512),
    ]);

    expect(engine1).not.toBeNull();
    expect(engine2).not.toBeNull();
    expect(engine1).toBe(engine2);
    expect(engineInstanceCount).toBe(1);

    await pool.disposeAll();
  });

  it("different model URIs get separate engines", async () => {
    const pool = new LlmEnginePool(modelsConfig);

    const engine1 = await pool.acquire("hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M", 512);
    const engine2 = await pool.acquire("hf:microsoft/Phi-3-mini-4k-instruct-gguf:Q4_K_M", 512);

    expect(engine1).not.toBeNull();
    expect(engine2).not.toBeNull();
    expect(engine1).not.toBe(engine2);
    expect(engineInstanceCount).toBe(2);

    await pool.disposeAll();
  });

  it("context size promotion re-creates engine with larger context", async () => {
    const pool = new LlmEnginePool(modelsConfig);
    const uri = "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M";

    const engine1 = await pool.acquire(uri, 256);
    expect(engine1).not.toBeNull();
    expect(engineInstanceCount).toBe(1);

    // Second phase requests larger context → promotion
    const engine2 = await pool.acquire(uri, 512);
    expect(engine2).not.toBeNull();
    expect(engine2).not.toBe(engine1); // New engine created
    expect(engineInstanceCount).toBe(2);
    expect((engine1 as any).disposed).toBe(true); // Old engine disposed

    await pool.disposeAll();
  });

  it("disposeAll clears all engines", async () => {
    const pool = new LlmEnginePool(modelsConfig);

    const engine1 = await pool.acquire("hf:model-a:Q4_K_M", 512);
    const engine2 = await pool.acquire("hf:model-b:Q4_K_M", 512);

    expect(engine1).not.toBeNull();
    expect(engine2).not.toBeNull();
    expect(engineInstanceCount).toBe(2);

    await pool.disposeAll();

    expect((engine1 as any).disposed).toBe(true);
    expect((engine2 as any).disposed).toBe(true);

    // After disposal, acquiring same URI creates a new engine
    const engine3 = await pool.acquire("hf:model-a:Q4_K_M", 512);
    expect(engine3).not.toBeNull();
    expect(engine3).not.toBe(engine1);
    expect(engineInstanceCount).toBe(3);

    await pool.disposeAll();
  });

  it("failed initialization returns null without polluting the pool", async () => {
    initShouldFail = true;
    const pool = new LlmEnginePool(modelsConfig);
    const uri = "hf:broken-model:Q4_K_M";

    const engine = await pool.acquire(uri, 512);
    expect(engine).toBeNull();

    // After failure, retry should attempt creation again
    initShouldFail = false;
    const engine2 = await pool.acquire(uri, 512);
    expect(engine2).not.toBeNull();
    expect(engineInstanceCount).toBe(2); // Two attempts, one failed, one succeeded

    await pool.disposeAll();
  });

  it("concurrent acquire with failed init returns null to all callers", async () => {
    initShouldFail = true;
    const pool = new LlmEnginePool(modelsConfig);
    const uri = "hf:broken-model:Q4_K_M";

    const [engine1, engine2] = await Promise.all([
      pool.acquire(uri, 512),
      pool.acquire(uri, 512),
    ]);

    expect(engine1).toBeNull();
    expect(engine2).toBeNull();

    await pool.disposeAll();
  });
});
