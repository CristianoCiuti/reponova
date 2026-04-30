/**
 * Phase 2 tests: Intelligence Layer (Embeddings + LLM)
 */
import { describe, it, expect, beforeAll } from "vitest";
import { EmbeddingEngine, composeNodeText, type NodeEmbeddingInput } from "../src/build/embeddings.js";
import { VectorStore, type VectorRecord } from "../src/core/vector-store.js";
import { SummaryGenerator, type CommunityData } from "../src/build/community-summaries.js";
import { LlmEngine } from "../src/build/llm-engine.js";
import type { GraphNode } from "../src/shared/types.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, existsSync } from "node:fs";

// ─── composeNodeText ─────────────────────────────────────────────────────────

describe("composeNodeText", () => {
  it("composes function text from label + signature + docstring", () => {
    const node: NodeEmbeddingInput = {
      id: "fn:load_config",
      label: "load_config",
      type: "function",
      signature: "(path: str, env: str = 'prod') -> Config",
      docstring: "Load configuration from YAML file",
    };
    const text = composeNodeText(node);
    expect(text).toContain("load_config");
    expect(text).toContain("path: str");
    expect(text).toContain("Load configuration");
  });

  it("composes class text from label + bases + docstring", () => {
    const node: NodeEmbeddingInput = {
      id: "cls:UserService",
      label: "UserService",
      type: "class",
      bases: ["BaseService", "AuthMixin"],
      docstring: "Handles user authentication and profile management",
    };
    const text = composeNodeText(node);
    expect(text).toContain("UserService");
    expect(text).toContain("BaseService");
    expect(text).toContain("authentication");
  });

  it("composes module text from source_file", () => {
    const node: NodeEmbeddingInput = {
      id: "mod:auth",
      label: "auth",
      type: "module",
      source_file: "src/services/auth.py",
    };
    const text = composeNodeText(node);
    expect(text).toContain("src/services/auth.py");
  });

  it("composes document text from label + docstring", () => {
    const node: NodeEmbeddingInput = {
      id: "doc:README",
      label: "README.md",
      type: "document",
      docstring: "Project documentation with setup instructions",
    };
    const text = composeNodeText(node);
    expect(text).toContain("README.md");
    expect(text).toContain("setup instructions");
  });

  it("truncates to 512 chars", () => {
    const node: NodeEmbeddingInput = {
      id: "fn:long",
      label: "x",
      type: "function",
      docstring: "a".repeat(1000),
    };
    const text = composeNodeText(node);
    expect(text.length).toBeLessThanOrEqual(512);
  });
});

// ─── VectorStore (in-memory fallback) ────────────────────────────────────────

describe("VectorStore (fallback mode)", () => {
  let store: VectorStore;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `gmt-test-vectors-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    store = new VectorStore(tmpDir);
    // Force fallback mode (no lancedb)
    await store.initialize();
  }, 30000);

  it("should store and query vectors", async () => {
    const records: VectorRecord[] = [
      { id: "1", label: "authenticate_user", type: "function", repo: "api", source_file: "auth.py", community: "0", text: "authenticate user with JWT", vector: makeVector(384, 0.1) },
      { id: "2", label: "UserModel", type: "class", repo: "api", source_file: "models.py", community: "0", text: "user database model", vector: makeVector(384, 0.5) },
      { id: "3", label: "validate_token", type: "function", repo: "api", source_file: "auth.py", community: "1", text: "validate JWT token signature", vector: makeVector(384, 0.15) },
    ];

    await store.upsert(records);

    // Query with a vector close to record 1 and 3 (auth-related)
    const queryVector = makeVector(384, 0.12);
    const results = await store.query(queryVector, { top_k: 2 });

    expect(results.length).toBe(2);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("should apply type filter", async () => {
    const records: VectorRecord[] = [
      { id: "a", label: "fn1", type: "function", repo: "r", source_file: "f.py", community: "0", text: "t", vector: makeVector(384, 0.2) },
      { id: "b", label: "cls1", type: "class", repo: "r", source_file: "f.py", community: "0", text: "t", vector: makeVector(384, 0.21) },
    ];

    await store.upsert(records);

    const results = await store.query(makeVector(384, 0.2), { top_k: 10, type_filter: "class" });
    expect(results.every(r => r.type === "class")).toBe(true);
  });

  it("should apply repo filter", async () => {
    const records: VectorRecord[] = [
      { id: "x", label: "fn1", type: "function", repo: "frontend", source_file: "f.ts", community: "0", text: "t", vector: makeVector(384, 0.3) },
      { id: "y", label: "fn2", type: "function", repo: "backend", source_file: "f.py", community: "0", text: "t", vector: makeVector(384, 0.31) },
    ];

    await store.upsert(records);

    const results = await store.query(makeVector(384, 0.3), { top_k: 10, repo_filter: "frontend" });
    expect(results.every(r => r.repo === "frontend")).toBe(true);
  });
});

// ─── SummaryGenerator (algorithmic mode) ──────────────────────────────────────

describe("SummaryGenerator (algorithmic)", () => {
  it("generates algorithmic community summaries", async () => {
    const generator = new SummaryGenerator(
      { enabled: true, generate_node_descriptions: true, node_description_threshold: 0.8, max_communities: 50 },
      null, // no LLM
    );

    const communities: CommunityData[] = [
      {
        id: "0",
        nodes: [
          { id: "1", label: "AuthService", type: "class", source_file: "src/auth/service.py" },
          { id: "2", label: "login", type: "function", source_file: "src/auth/handlers.py" },
          { id: "3", label: "validate_token", type: "function", source_file: "src/auth/token.py" },
          { id: "4", label: "UserModel", type: "class", source_file: "src/auth/models.py" },
        ] as GraphNode[],
      },
    ];

    const summaries = await generator.generateCommunitySummaries(communities);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].nodeCount).toBe(4);
    expect(summaries[0].summary).toContain("4 nodes cluster");
    expect(summaries[0].hub_nodes.length).toBeGreaterThan(0);
    expect(summaries[0].repos).toEqual([]);
  });

  it("generates algorithmic node descriptions", async () => {
    const generator = new SummaryGenerator(
      { enabled: true, generate_node_descriptions: true, node_description_threshold: 0.5, max_communities: 50 },
      null,
    );

    const nodes: GraphNode[] = [
      { id: "1", label: "main_function", type: "function", source_file: "main.py" },
      { id: "2", label: "helper", type: "function", source_file: "util.py" },
    ];

    const edgeCounts = new Map([["1", 10], ["2", 2]]);
    const descriptions = await generator.generateNodeDescriptions(nodes, edgeCounts);

    // With threshold 0.5, top 50% = 1 node (the highest degree)
    expect(descriptions.length).toBe(1);
    expect(descriptions[0].id).toBe("1");
    expect(descriptions[0].description).toContain("Function");
    expect(descriptions[0].description).toContain("10 connections");
  });

  it("respects disabled config", async () => {
    const generator = new SummaryGenerator(
      { enabled: false, generate_node_descriptions: true, node_description_threshold: 0.8, max_communities: 50 },
      null,
    );

    const summaries = await generator.generateCommunitySummaries([{ id: "0", nodes: [] }]);
    expect(summaries).toHaveLength(0);
  });
});

// ─── EmbeddingEngine (graceful degradation) ──────────────────────────────────

describe("EmbeddingEngine", () => {
  it("should report unavailable when disabled", async () => {
    const engine = new EmbeddingEngine({
      enabled: false,
      model: "all-MiniLM-L6-v2",
      dimensions: 384,
      batch_size: 128,
      cache_dir: "~/.cache/graphify-mcp-tools/models",
    });

    const ready = await engine.initialize();
    expect(ready).toBe(false);
    expect(engine.isAvailable).toBe(false);
    await engine.dispose();
  });

  it("should gracefully handle missing onnxruntime-node", { timeout: 30000 }, async () => {
    // This test validates that if onnxruntime-node IS available but model is not downloaded,
    // the engine handles it without crashing. In CI without the model, it will fail gracefully.
    const engine = new EmbeddingEngine({
      enabled: true,
      model: "all-MiniLM-L6-v2",
      dimensions: 384,
      batch_size: 128,
      cache_dir: join(tmpdir(), `gmt-test-nonexistent-${Date.now()}`),
    });

    // This should not throw — it should return false gracefully
    const ready = await engine.initialize();
    // ready could be true (if onnxruntime is installed and model downloads)
    // or false (if model download fails in CI)
    expect(typeof ready).toBe("boolean");
    await engine.dispose();
  });
});

// ─── LlmEngine (graceful degradation) ────────────────────────────────────────

describe("LlmEngine", () => {
  it("should report unavailable when disabled", async () => {
    const engine = new LlmEngine({
      enabled: false,
      model: "qwen2.5-3b-instruct",
      quantization: "Q4_K_M",
      gpu: "auto",
      context_size: 4096,
      threads: 0,
      download_on_first_use: false,
      cache_dir: "~/.cache/graphify-mcp-tools/models",
    });

    const ready = await engine.initialize();
    expect(ready).toBe(false);
    expect(engine.isAvailable).toBe(false);
    await engine.dispose();
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeVector(dim: number, seed: number): number[] {
  const vec = new Array(dim);
  for (let i = 0; i < dim; i++) {
    vec[i] = Math.sin(seed * (i + 1)) * 0.5 + 0.5;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}
