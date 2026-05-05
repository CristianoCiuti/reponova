import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { runEmbeddingsStep, loadNodeTextCache, saveNodeTextCache } from "../src/build/steps/embeddings-step.js";
import type { StepContext } from "../src/build/types.js";
import type { Config, GraphData } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";

// Force VectorStore into fast in-memory fallback (no native lancedb loading)
vi.mock("@lancedb/lancedb", () => ({
  connect: async () => { throw new Error("mock: lancedb unavailable"); },
}));

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("PROP-I3: incremental embeddings", () => {
  // ─── Case 1: Nothing changed → early return ────────────────────────────────

  it("skips regeneration when texts are unchanged (all outputs stable)", async () => {
    const { outputDir, graphJsonPath, makeContext } = setup();
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta")]);

    const firstResult = await runEmbeddingsStep(makeContext());
    const firstVectors = loadVectors(outputDir);
    const firstIdf = readFileSync(join(outputDir, "tfidf_idf.json"), "utf-8");

    const secondResult = await runEmbeddingsStep(makeContext());
    const secondVectors = loadVectors(outputDir);
    const secondIdf = readFileSync(join(outputDir, "tfidf_idf.json"), "utf-8");

    expect(firstResult.processed).toBe(2);
    expect(firstResult.skipped).toBe(false);
    expect(secondResult.processed).toBe(0);
    expect(secondResult.skipped).toBe(true);
    // All outputs identical
    expect(secondVectors).toEqual(firstVectors);
    expect(secondIdf).toEqual(firstIdf);
    expect(loadNodeTextCache(outputDir).size).toBe(2);
    assertOutputIds(outputDir, ["node-a", "node-b"]);
  });

  // ─── Case 2: Text changed → re-embed only changed ──────────────────────────

  it("regenerates only changed node embeddings and preserves unchanged vectors", async () => {
    const { outputDir, graphJsonPath, makeContext } = setup();
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta")]);
    await runEmbeddingsStep(makeContext());
    const firstVectors = loadVectors(outputDir);

    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha updated"), makeNode("node-b", "Beta")]);
    const result = await runEmbeddingsStep(makeContext());
    const secondVectors = loadVectors(outputDir);

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(false);
    expect(vectorFor(firstVectors, "node-b")).toEqual(vectorFor(secondVectors, "node-b"));
    expect(vectorFor(firstVectors, "node-a")).not.toEqual(vectorFor(secondVectors, "node-a"));
    assertOutputIds(outputDir, ["node-a", "node-b"]);
  });

  // ─── Case 3: Node added + node removed (normal incremental) ────────────────

  it("adds new nodes and removes deleted nodes from ALL outputs", async () => {
    const { outputDir, graphJsonPath, makeContext } = setup();
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta")]);
    await runEmbeddingsStep(makeContext());

    writeGraph(graphJsonPath, [makeNode("node-b", "Beta"), makeNode("node-c", "Gamma")]);
    const result = await runEmbeddingsStep(makeContext());

    expect(result.processed).toBe(1);
    assertOutputIds(outputDir, ["node-b", "node-c"]);
    // tfidf_idf.json rebuilt with new vocabulary
    expect(existsSync(join(outputDir, "tfidf_idf.json"))).toBe(true);
  });

  // ─── Case 4: Stale vectors only (text cache already clean) ─────────────────

  it("removes stale vectors without regenerating any embeddings", async () => {
    const { outputDir, graphJsonPath, makeContext } = setup();

    // Build with 3 nodes
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta"), makeNode("node-c", "Gamma")]);
    await runEmbeddingsStep(makeContext());
    const idfBefore = JSON.parse(readFileSync(join(outputDir, "tfidf_idf.json"), "utf-8")) as Record<string, unknown>;
    expect(loadVectors(outputDir)).toHaveLength(3);

    // Simulate: text cache already updated (no node-c) but VectorStore still has it
    const cache = loadNodeTextCache(outputDir);
    cache.delete("node-c");
    saveNodeTextCache(outputDir, cache);

    // Run with 2-node graph — VectorStore has stale node-c
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta")]);
    const result = await runEmbeddingsStep(makeContext());

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(true);
    assertOutputIds(outputDir, ["node-a", "node-b"]);
    // tfidf_idf.json REBUILT with vocabulary from only current 2 nodes (N changed)
    const idfAfter = JSON.parse(readFileSync(join(outputDir, "tfidf_idf.json"), "utf-8")) as Record<string, unknown>;
    expect(idfAfter).not.toEqual(idfBefore);
  });

  // ─── Case 5: Stale text cache only (no stale vectors) ─────────────────────

  it("cleans stale text cache entries without touching vectors (TF-IDF vocabulary still rebuilt)", async () => {
    const { outputDir, graphJsonPath, makeContext } = setup();

    // Build with 2 nodes
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta")]);
    await runEmbeddingsStep(makeContext());
    const vectorsBefore = loadVectors(outputDir);

    // Simulate: text cache has a ghost entry (node-ghost) but NO corresponding vector
    const cache = loadNodeTextCache(outputDir);
    cache.set("node-ghost", "ghost text that should not exist");
    saveNodeTextCache(outputDir, cache);

    // Run with same 2-node graph — text cache has stale "node-ghost" but VectorStore is clean
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta")]);
    const result = await runEmbeddingsStep(makeContext());

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(true);
    assertOutputIds(outputDir, ["node-a", "node-b"]);
    // Vectors untouched (no stale vectors to remove)
    expect(loadVectors(outputDir)).toEqual(vectorsBefore);
    // Ghost text entry cleaned from cache
    expect(loadNodeTextCache(outputDir).has("node-ghost")).toBe(false);
    // tfidf_idf.json still exists (rebuilt from current 2 nodes — same content since docs didn't change)
    expect(existsSync(join(outputDir, "tfidf_idf.json"))).toBe(true);
  });

  // ─── Case 6: Both stale vectors AND stale text cache (different nodes) ─────

  it("handles simultaneous stale vectors and stale text entries", async () => {
    const { outputDir, graphJsonPath, makeContext } = setup();

    // Build with 3 nodes
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta"), makeNode("node-c", "Gamma")]);
    await runEmbeddingsStep(makeContext());

    // Simulate: node-c removed from text cache (stale text) + add ghost text entry (stale text without vector)
    // VectorStore still has node-c (stale vector)
    const cache = loadNodeTextCache(outputDir);
    cache.delete("node-c");
    cache.set("node-ghost", "phantom text");
    saveNodeTextCache(outputDir, cache);

    // Run with 2-node graph
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta")]);
    const result = await runEmbeddingsStep(makeContext());

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(true);
    assertOutputIds(outputDir, ["node-a", "node-b"]);
  });

  // ─── Case 7: Stale vectors + new embeddings needed simultaneously ──────────

  it("handles stale vector cleanup together with new embeddings via full pipeline", async () => {
    const { outputDir, graphJsonPath, makeContext } = setup();

    // Build with 3 nodes
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta"), makeNode("node-c", "Gamma")]);
    await runEmbeddingsStep(makeContext());

    // Simulate: text cache already cleaned of node-c, but VectorStore still has it
    const cache = loadNodeTextCache(outputDir);
    cache.delete("node-c");
    saveNodeTextCache(outputDir, cache);

    // Run with graph that has node-a, node-b (unchanged) + node-d (NEW)
    // This triggers: staleVectorIds={node-c}, itemsNeedingEmbeddings=[node-d]
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta"), makeNode("node-d", "Delta")]);
    const result = await runEmbeddingsStep(makeContext());

    // node-d is the only NEW embedding
    expect(result.processed).toBe(1);
    assertOutputIds(outputDir, ["node-a", "node-b", "node-d"]);
    // tfidf_idf.json rebuilt (full pipeline ran)
    expect(existsSync(join(outputDir, "tfidf_idf.json"))).toBe(true);
  });

  // ─── Case 8: Multiple nodes removed at once ───────────────────────────────

  it("removes multiple stale vectors in a single cleanup pass", async () => {
    const { outputDir, graphJsonPath, makeContext } = setup();

    // Build with 5 nodes
    writeGraph(graphJsonPath, [
      makeNode("node-a", "Alpha"),
      makeNode("node-b", "Beta"),
      makeNode("node-c", "Gamma"),
      makeNode("node-d", "Delta"),
      makeNode("node-e", "Epsilon"),
    ]);
    await runEmbeddingsStep(makeContext());
    expect(loadVectors(outputDir)).toHaveLength(5);

    // Simulate: remove 3 nodes from text cache but VectorStore still has them
    const cache = loadNodeTextCache(outputDir);
    cache.delete("node-c");
    cache.delete("node-d");
    cache.delete("node-e");
    saveNodeTextCache(outputDir, cache);

    // Run with only 2 nodes
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta")]);
    const result = await runEmbeddingsStep(makeContext());

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(true);
    assertOutputIds(outputDir, ["node-a", "node-b"]);
  });

  // ─── Case 9: Complete graph replacement ────────────────────────────────────

  it("handles complete graph replacement (all old nodes removed, all new nodes added)", async () => {
    const { outputDir, graphJsonPath, makeContext } = setup();

    writeGraph(graphJsonPath, [makeNode("old-a", "OldAlpha"), makeNode("old-b", "OldBeta")]);
    await runEmbeddingsStep(makeContext());

    writeGraph(graphJsonPath, [makeNode("new-x", "NewX"), makeNode("new-y", "NewY")]);
    const result = await runEmbeddingsStep(makeContext());

    expect(result.processed).toBe(2);
    assertOutputIds(outputDir, ["new-x", "new-y"]);
  });

  // ─── Case 10: Empty graph after populated build ────────────────────────────

  it("cleans all vectors when graph becomes empty", async () => {
    const { outputDir, graphJsonPath, makeContext } = setup();

    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta")]);
    await runEmbeddingsStep(makeContext());
    expect(loadVectors(outputDir)).toHaveLength(2);

    // Empty graph
    writeGraph(graphJsonPath, []);
    const result = await runEmbeddingsStep(makeContext());

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(true);
    expect(loadNodeTextCache(outputDir).size).toBe(0);
    // vectors.json should not exist or be empty (upsert with 0 records is a no-op)
    const vectorsPath = join(outputDir, "vectors", "vectors.json");
    if (existsSync(vectorsPath)) {
      const vectors = JSON.parse(readFileSync(vectorsPath, "utf-8")) as unknown[];
      expect(vectors).toHaveLength(0);
    }
  });

  // ─── Case 11: Switching from TF-IDF to ONNX removes tfidf_idf.json ────────

  it("removes tfidf_idf.json when method is onnx (method-exclusive artifacts)", async () => {
    const { config, outputDir, graphJsonPath, makeContext } = setup();

    // Build with TF-IDF first
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta")]);
    await runEmbeddingsStep(makeContext());
    expect(existsSync(join(outputDir, "tfidf_idf.json"))).toBe(true);

    // Switch to ONNX — note: ONNX engine won't initialize in test (mocked lancedb), but
    // the tfidf_idf.json cleanup happens BEFORE embedding generation, unconditionally.
    config.build.embeddings.method = "onnx";
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta")]);
    // ONNX will fail gracefully (no model), but artifact cleanup must still happen
    await runEmbeddingsStep(makeContext());

    expect(existsSync(join(outputDir, "tfidf_idf.json"))).toBe(false);
  });

  // ─── Case 12: tfidf_idf.json stays when method is tfidf ───────────────────

  it("preserves tfidf_idf.json when method remains tfidf", async () => {
    const { outputDir, graphJsonPath, makeContext } = setup();

    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta")]);
    await runEmbeddingsStep(makeContext());
    expect(existsSync(join(outputDir, "tfidf_idf.json"))).toBe(true);

    // Run again still in tfidf mode
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta"), makeNode("node-c", "Gamma")]);
    await runEmbeddingsStep(makeContext());

    expect(existsSync(join(outputDir, "tfidf_idf.json"))).toBe(true);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setup(): {
  config: Config;
  outputDir: string;
  graphJsonPath: string;
  makeContext: (overrides?: Partial<StepContext>) => StepContext;
} {
  const root = join(tmpdir(), `rn-test-prop-i3-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(root);
  const outputDir = join(root, "out");
  mkdirSync(outputDir, { recursive: true });

  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
  config.build.embeddings = {
    enabled: true,
    method: "tfidf",
    model: "all-MiniLM-L6-v2",
    dimensions: 32,
    batch_size: 128,
  };
  config.build.community_summaries.enabled = false;
  config.build.node_descriptions.enabled = false;

  return {
    config,
    outputDir,
    graphJsonPath: join(outputDir, "graph.json"),
    makeContext: (overrides = {}) => ({
      config,
      outputDir,
      graphJsonPath: join(outputDir, "graph.json"),
      force: false,
      graphChanged: true,
      previousConfig: null,
      ...overrides,
    }),
  };
}

function writeGraph(graphJsonPath: string, nodes: GraphData["nodes"]): void {
  const graph: GraphData = {
    nodes,
    edges: [],
    metadata: {
      build_config: {
        embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 32 },
        outlines: { enabled: true, patterns: [], exclude: [], exclude_common: true },
        community_summaries: { enabled: false, max_number: 0, model: null, context_size: 512 },
        node_descriptions: { enabled: false, threshold: 0.8, model: null, context_size: 512 },
      },
    },
  };
  writeFileSync(graphJsonPath, JSON.stringify(graph, null, 2));
}

function makeNode(id: string, label: string): GraphData["nodes"][number] {
  return {
    id,
    label,
    type: "function",
    source_file: `${id}.py`,
    repo: "repo",
    properties: {
      signature: `(${label.toLowerCase()}: str) -> str`,
      docstring: `${label} documentation`,
    },
  };
}

function loadVectors(outputDir: string): Array<{ id: string; text: string; vector: number[] }> {
  const path = join(outputDir, "vectors", "vectors.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf-8")) as Array<{ id: string; text: string; vector: number[] }>;
}

function vectorFor(records: Array<{ id: string; vector: number[] }>, id: string): number[] {
  const record = records.find((entry) => entry.id === id);
  if (!record) throw new Error(`Missing vector for ${id}`);
  return record.vector;
}

/**
 * Assert ALL outputs (vectors.json, node-texts.json) contain exactly these IDs and nothing else.
 */
function assertOutputIds(outputDir: string, expectedIds: string[]): void {
  const sorted = [...expectedIds].sort();

  // vectors.json
  const vectors = loadVectors(outputDir);
  expect(vectors.map((r) => r.id).sort(), "vectors.json IDs mismatch").toEqual(sorted);

  // node-texts.json
  const textCache = loadNodeTextCache(outputDir);
  expect([...textCache.keys()].sort(), "node-texts.json IDs mismatch").toEqual(sorted);
}
