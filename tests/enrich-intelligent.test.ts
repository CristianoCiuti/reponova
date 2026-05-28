/**
 * Unit tests for the intelligent enrichment pipeline (M4).
 *
 * Covers: metrics, merge, apply, finalize, batcher, prompts, llm-executor.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMetrics } from "../src/pipeline/enrich/metrics.js";
import { runMerge } from "../src/pipeline/enrich/merge.js";
import { runApply } from "../src/pipeline/enrich/apply.js";
import { runFinalize } from "../src/pipeline/enrich/finalize.js";
import { runPrepare } from "../src/pipeline/enrich/prepare.js";
import { packBatches, extractNodeCode } from "../src/pipeline/enrich/batcher.js";
import { buildDescriptionPrompt, buildProfilePrompt, buildRoutingPrompt, buildRestructurePrompt } from "../src/pipeline/enrich/prompts.js";
import { parseLlmJson } from "../src/pipeline/enrich/llm-executor.js";
import type { Config, GraphData } from "../src/shared/types.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `rn-enrich-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, "..").replace(/[/\\][^/\\]+$/, ""), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function makeGraphData(opts?: { addCrossEdges?: boolean }): GraphData {
  return {
    nodes: [
      { id: "A", label: "A", type: "function", community: "0", source_file: "src/a.py", start_line: 1, end_line: 10 },
      { id: "B", label: "B", type: "function", community: "0", source_file: "src/b.py", start_line: 1, end_line: 5 },
      { id: "C", label: "C", type: "function", community: "1", source_file: "src/c.py", start_line: 1, end_line: 8 },
      { id: "D", label: "D", type: "function", community: "1", source_file: "src/d.py", start_line: 1, end_line: 12 },
      { id: "E", label: "E", type: "function", community: "0", source_file: "src/e.py", start_line: 1, end_line: 3 },
    ],
    edges: [
      { source: "A", target: "B", type: "calls" },
      { source: "A", target: "C", type: "calls" }, // cross-community
      { source: "C", target: "D", type: "calls" },
      ...(opts?.addCrossEdges ? [
        { source: "B", target: "C", type: "calls" },
        { source: "B", target: "D", type: "calls" },
        { source: "E", target: "C", type: "calls" },
        { source: "E", target: "D", type: "calls" },
      ] : []),
    ],
  };
}

// ─── METRICS ─────────────────────────────────────────────────────────────────

describe("enrich:metrics", () => {
  it("classifies nodes with high boundary ratio as candidates", () => {
    writeJson(join(testDir, "graph.json"), makeGraphData({ addCrossEdges: true }));
    mkdirSync(join(testDir, ".cache"), { recursive: true });

    const result = runMetrics({ outputDir: testDir, candidateThreshold: 0.3 });
    expect(result.totalNodes).toBe(5);
    expect(result.candidateCount).toBeGreaterThan(0);

    const candidates = JSON.parse(readFileSync(join(testDir, ".enrich", "candidates.json"), "utf-8"));
    // Node A has both internal (→B) and external (→C) edges
    const nodeA = candidates.candidates.find((c: any) => c.nodeId === "A");
    expect(nodeA).toBeDefined();
    expect(nodeA.boundaryRatio).toBeGreaterThan(0);
  });

  it("classifies nodes with low boundary ratio as stable", () => {
    // C and D are all internal (both in community 1)
    const graph = makeGraphData();
    writeJson(join(testDir, "graph.json"), graph);
    mkdirSync(join(testDir, ".cache"), { recursive: true });

    const result = runMetrics({ outputDir: testDir, candidateThreshold: 0.5 });
    const candidates = JSON.parse(readFileSync(join(testDir, ".enrich", "candidates.json"), "utf-8"));
    const nodeD = candidates.candidates.find((c: any) => c.nodeId === "D");
    // D only has internal edge from C → D
    expect(nodeD.status).toBe("stable");
  });

  it("computes inter-community edge density", () => {
    writeJson(join(testDir, "graph.json"), makeGraphData({ addCrossEdges: true }));
    mkdirSync(join(testDir, ".cache"), { recursive: true });

    runMetrics({ outputDir: testDir, candidateThreshold: 0.3 });
    const edgeDensity = JSON.parse(readFileSync(join(testDir, ".enrich", "edge-density.json"), "utf-8"));
    expect(edgeDensity.pairs.length).toBeGreaterThan(0);
    // Community 0 ↔ 1 should have edges
    const pair = edgeDensity.pairs[0];
    expect(pair.edgeCount).toBeGreaterThan(0);
  });

  it("skips if candidates.json already exists", () => {
    writeJson(join(testDir, "graph.json"), makeGraphData());
    mkdirSync(join(testDir, ".cache"), { recursive: true });

    runMetrics({ outputDir: testDir, candidateThreshold: 0.3 });
    const firstMtime = readFileSync(join(testDir, ".enrich", "candidates.json"), "utf-8");

    // Running again should skip (same file contents)
    const result2 = runMetrics({ outputDir: testDir, candidateThreshold: 0.3 });
    const secondContent = readFileSync(join(testDir, ".enrich", "candidates.json"), "utf-8");
    expect(secondContent).toBe(firstMtime);
    expect(result2.totalNodes).toBe(5);
  });

  it("handles nodes with zero edges", () => {
    const graph: GraphData = {
      nodes: [
        { id: "X", label: "X", type: "function", community: "0" },
      ],
      edges: [],
    };
    writeJson(join(testDir, "graph.json"), graph);
    mkdirSync(join(testDir, ".cache"), { recursive: true });

    const result = runMetrics({ outputDir: testDir, candidateThreshold: 0.3 });
    const candidates = JSON.parse(readFileSync(join(testDir, ".enrich", "candidates.json"), "utf-8"));
    const nodeX = candidates.candidates[0];
    expect(nodeX.boundaryRatio).toBe(0);
    expect(nodeX.status).toBe("stable");
    expect(result.candidateCount).toBe(0);
  });

  it("handles unclustered nodes", () => {
    const graph: GraphData = {
      nodes: [
        { id: "X", label: "X", type: "function" }, // no community = "unclustered"
        { id: "Y", label: "Y", type: "function", community: "0" },
      ],
      edges: [
        { source: "X", target: "Y", type: "calls" },
      ],
    };
    writeJson(join(testDir, "graph.json"), graph);
    mkdirSync(join(testDir, ".cache"), { recursive: true });

    runMetrics({ outputDir: testDir, candidateThreshold: 0.3 });
    const candidates = JSON.parse(readFileSync(join(testDir, ".enrich", "candidates.json"), "utf-8"));
    const nodeX = candidates.candidates.find((c: any) => c.nodeId === "X");
    // X is "unclustered", Y is "0" — so edge is cross-community → all external for X
    expect(nodeX.externalDegree).toBe(1);
    expect(nodeX.internalDegree).toBe(0);
    expect(nodeX.status).toBe("candidate");
  });

  it("respects configurable threshold", () => {
    writeJson(join(testDir, "graph.json"), makeGraphData({ addCrossEdges: true }));
    mkdirSync(join(testDir, ".cache"), { recursive: true });

    const result03 = runMetrics({ outputDir: testDir, candidateThreshold: 0.3 });
    rmSync(join(testDir, ".enrich"), { recursive: true, force: true });
    const result09 = runMetrics({ outputDir: testDir, candidateThreshold: 0.9 });

    expect(result03.candidateCount).toBeGreaterThanOrEqual(result09.candidateCount);
  });
});

// ─── PREPARE ─────────────────────────────────────────────────────────────────

describe("enrich:prepare", () => {
  function makeMinimalConfig(repoPath: string): Config {
    return {
      output: ".",
      repos: [{ name: "test-repo", path: repoPath }],
      models: { cache_dir: "~/.cache/reponova/models", gpu: "auto", threads: 0, download_on_first_use: true },
      providers: {},
      patterns: [],
      exclude: [],
      exclude_common: true,
      incremental: true,
      docs: { enabled: true, patterns: [], exclude: [], max_file_size_kb: 500 },
      images: { enabled: true, patterns: [], exclude: [], parse_puml: true, parse_svg_text: true },
      embeddings: { enabled: true, batch_size: 128 },
      enrich: {
        enabled: true,
        threshold: 0.8,
        max_communities: 0,
        candidate_threshold: 0.3,
        description_batch_tokens: 40000,
        routing_batch_size: 30,
        concurrency: 4,
        max_retry_depth: 3,
        max_tokens: { descriptions: 32768, profiles: 2048, routing: 8192, restructure: 4096 },
        profile: { max_nodes: 80, max_edges: 50 },
        restructure_max_pairs: 20,
      },
      html: true,
      outlines: { enabled: true },
      server: {},
    } as Config;
  }

  it("prepares description batches from candidates + graph", () => {
    const repoDir = join(testDir, "repo");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "a.py"), "def login():\n    pass\n");
    writeFileSync(join(repoDir, "src", "b.py"), "def verify():\n    pass\n");
    writeFileSync(join(repoDir, "src", "c.py"), "def query():\n    pass\n");
    writeFileSync(join(repoDir, "src", "d.py"), "def store():\n    pass\n");
    writeFileSync(join(repoDir, "src", "e.py"), "def helper():\n    pass\n");

    // Graph with repo field set so batcher can resolve file paths
    const graphData: GraphData = {
      nodes: [
        { id: "A", label: "A", type: "function", community: "0", repo: "test-repo", source_file: "src/a.py", start_line: 1, end_line: 2 },
        { id: "B", label: "B", type: "function", community: "0", repo: "test-repo", source_file: "src/b.py", start_line: 1, end_line: 2 },
        { id: "C", label: "C", type: "function", community: "1", repo: "test-repo", source_file: "src/c.py", start_line: 1, end_line: 2 },
        { id: "D", label: "D", type: "function", community: "1", repo: "test-repo", source_file: "src/d.py", start_line: 1, end_line: 2 },
        { id: "E", label: "E", type: "function", community: "0", repo: "test-repo", source_file: "src/e.py", start_line: 1, end_line: 2 },
      ],
      edges: [
        { source: "A", target: "B", type: "calls" },
        { source: "A", target: "C", type: "calls" },
        { source: "B", target: "C", type: "calls" },
        { source: "B", target: "D", type: "calls" },
        { source: "E", target: "C", type: "calls" },
        { source: "E", target: "D", type: "calls" },
        { source: "C", target: "D", type: "calls" },
      ],
    };
    writeJson(join(testDir, "graph.json"), graphData);
    mkdirSync(join(testDir, ".cache"), { recursive: true });

    // Run metrics first (creates candidates.json)
    runMetrics({ outputDir: testDir, candidateThreshold: 0.3 });

    const config = makeMinimalConfig(repoDir);
    const result = runPrepare({ outputDir: testDir, config, configDir: repoDir }, "descriptions");

    expect(result.step).toBe("descriptions");
    expect(result.batchCount).toBeGreaterThan(0);
    expect(existsSync(result.inputDir)).toBe(true);

    // Verify batch files exist
    const files = readdirSync(result.inputDir).filter(f => f.endsWith(".json"));
    expect(files.length).toBe(result.batchCount);

    // Verify batch content structure
    const batch = JSON.parse(readFileSync(join(result.inputDir, files[0]), "utf-8"));
    expect(batch.batchId).toBeDefined();
    expect(batch.totalBatches).toBeDefined();
    expect(batch.items).toBeDefined();
    expect(Array.isArray(batch.items)).toBe(true);
  });

  it("cleans stale batch files on repeated call", () => {
    const repoDir = join(testDir, "repo");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "a.py"), "def login():\n    pass\n");
    writeFileSync(join(repoDir, "src", "b.py"), "def verify():\n    pass\n");
    writeFileSync(join(repoDir, "src", "c.py"), "def query():\n    pass\n");
    writeFileSync(join(repoDir, "src", "d.py"), "def store():\n    pass\n");
    writeFileSync(join(repoDir, "src", "e.py"), "def helper():\n    pass\n");

    const graphData: GraphData = {
      nodes: [
        { id: "A", label: "A", type: "function", community: "0", repo: "test-repo", source_file: "src/a.py", start_line: 1, end_line: 2 },
        { id: "B", label: "B", type: "function", community: "0", repo: "test-repo", source_file: "src/b.py", start_line: 1, end_line: 2 },
        { id: "C", label: "C", type: "function", community: "1", repo: "test-repo", source_file: "src/c.py", start_line: 1, end_line: 2 },
        { id: "D", label: "D", type: "function", community: "1", repo: "test-repo", source_file: "src/d.py", start_line: 1, end_line: 2 },
        { id: "E", label: "E", type: "function", community: "0", repo: "test-repo", source_file: "src/e.py", start_line: 1, end_line: 2 },
      ],
      edges: [
        { source: "A", target: "C", type: "calls" },
        { source: "B", target: "D", type: "calls" },
        { source: "E", target: "C", type: "calls" },
        { source: "E", target: "D", type: "calls" },
        { source: "C", target: "D", type: "calls" },
      ],
    };
    writeJson(join(testDir, "graph.json"), graphData);
    mkdirSync(join(testDir, ".cache"), { recursive: true });
    runMetrics({ outputDir: testDir, candidateThreshold: 0.3 });

    const config = makeMinimalConfig(repoDir);

    // First call
    const result1 = runPrepare({ outputDir: testDir, config, configDir: repoDir }, "descriptions");
    expect(result1.batchCount).toBeGreaterThan(0);

    // Plant a stale file that shouldn't survive a second prepare
    writeFileSync(join(result1.inputDir, "batch-999.json"), JSON.stringify({ stale: true }));
    expect(existsSync(join(result1.inputDir, "batch-999.json"))).toBe(true);

    // Second call — should wipe stale files
    const result2 = runPrepare({ outputDir: testDir, config, configDir: repoDir }, "descriptions");

    expect(existsSync(join(result2.inputDir, "batch-999.json"))).toBe(false);
    // Real batch files should still be there
    const files = readdirSync(result2.inputDir).filter(f => f.endsWith(".json"));
    expect(files.length).toBe(result2.batchCount);
  });

  it("throws when prerequisites are missing", () => {
    const repoDir = join(testDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    const config = makeMinimalConfig(repoDir);

    // No candidates.json → descriptions should fail
    expect(() => runPrepare({ outputDir: testDir, config, configDir: repoDir }, "descriptions"))
      .toThrow("Missing prerequisite");

    // No descriptions.json → profiles should fail
    expect(() => runPrepare({ outputDir: testDir, config, configDir: repoDir }, "profiles"))
      .toThrow("Missing prerequisite");
  });

  it("prepares profiles from descriptions + graph", () => {
    const repoDir = join(testDir, "repo");
    mkdirSync(repoDir, { recursive: true });

    // Graph with 2 communities of 3+ members each
    const graphData: GraphData = {
      nodes: [
        { id: "A", label: "A", type: "function", community: "auth", source_file: "a.py", start_line: 1, end_line: 5 },
        { id: "B", label: "B", type: "function", community: "auth", source_file: "b.py", start_line: 1, end_line: 5 },
        { id: "C", label: "C", type: "function", community: "auth", source_file: "c.py", start_line: 1, end_line: 5 },
        { id: "D", label: "D", type: "function", community: "data", source_file: "d.py", start_line: 1, end_line: 5 },
        { id: "E", label: "E", type: "function", community: "data", source_file: "e.py", start_line: 1, end_line: 5 },
        { id: "F", label: "F", type: "function", community: "data", source_file: "f.py", start_line: 1, end_line: 5 },
      ],
      edges: [
        { source: "A", target: "B", type: "calls" },
        { source: "B", target: "C", type: "calls" },
        { source: "D", target: "E", type: "calls" },
        { source: "E", target: "F", type: "calls" },
      ],
    };
    writeJson(join(testDir, "graph.json"), graphData);

    // Create prerequisite: descriptions.json
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(enrichDir, { recursive: true });
    writeFileSync(join(enrichDir, "descriptions.json"), JSON.stringify([
      { id: "A", description: "desc A" },
      { id: "B", description: "desc B" },
      { id: "C", description: "desc C" },
      { id: "D", description: "desc D" },
      { id: "E", description: "desc E" },
      { id: "F", description: "desc F" },
    ]));

    const config = makeMinimalConfig(repoDir);
    const result = runPrepare({ outputDir: testDir, config, configDir: repoDir }, "profiles");

    expect(result.step).toBe("profiles");
    expect(result.batchCount).toBe(2); // 2 communities with 3+ members

    const files = readdirSync(result.inputDir).filter(f => f.endsWith(".json"));
    expect(files.length).toBe(2);

    // Verify structure
    const community = JSON.parse(readFileSync(join(result.inputDir, files[0]), "utf-8"));
    expect(community.communityId).toBeDefined();
    expect(community.members).toBeDefined();
    expect(community.internalEdges).toBeDefined();
  });

  it("prepareRestructure respects config.enrich.restructure_max_pairs", () => {
    const repoDir = join(testDir, "repo");
    mkdirSync(repoDir, { recursive: true });

    const graphData: GraphData = {
      nodes: [
        { id: "A", label: "A", type: "function", community: "0" },
        { id: "B", label: "B", type: "function", community: "0" },
        { id: "C", label: "C", type: "function", community: "0" },
        { id: "D", label: "D", type: "function", community: "1" },
        { id: "E", label: "E", type: "function", community: "1" },
        { id: "F", label: "F", type: "function", community: "1" },
      ],
      edges: [
        { source: "A", target: "D", type: "calls" },
        { source: "B", target: "E", type: "calls" },
      ],
    };
    writeJson(join(testDir, "graph.json"), graphData);

    const enrichDir = join(testDir, ".enrich");
    mkdirSync(enrichDir, { recursive: true });

    // Create prerequisites
    writeJson(join(enrichDir, "profiles.json"), [
      { communityId: "0", label: "Auth", profile: "auth stuff", misfits: [] },
      { communityId: "1", label: "Data", profile: "data stuff", misfits: [] },
    ]);
    // Generate 30 edge-density pairs
    const pairs = Array.from({ length: 30 }, (_, i) => ({
      communityA: `c${i}`, communityB: `c${i + 1}`, edgeCount: 30 - i,
    }));
    writeJson(join(enrichDir, "edge-density.json"), { pairs });
    writeJson(join(enrichDir, "routing.json"), []);

    // Set restructure_max_pairs to 5
    const config = makeMinimalConfig(repoDir);
    config.enrich.restructure_max_pairs = 5;

    const result = runPrepare({ outputDir: testDir, config, configDir: repoDir }, "restructure");
    expect(result.step).toBe("restructure");
    expect(result.batchCount).toBe(1);

    // Verify the input file only contains 5 pairs (not 30)
    const input = JSON.parse(readFileSync(join(result.inputDir, "restructure-input.json"), "utf-8"));
    expect(input.topEdgeDensityPairs).toHaveLength(5);
    expect(input.topEdgeDensityPairs[0].communityA).toBe("c0");
    expect(input.topEdgeDensityPairs[4].communityA).toBe("c4");
  });
});

// ─── MERGE ───────────────────────────────────────────────────────────────────

describe("enrich:merge", () => {
  it("merges description batch files into descriptions.json", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(join(enrichDir, "output", "descriptions"), { recursive: true });

    writeFileSync(join(enrichDir, "output", "descriptions", "batch-001.json"), JSON.stringify([
      { id: "A", description: "desc A" },
      { id: "B", description: "desc B" },
    ]));
    writeFileSync(join(enrichDir, "output", "descriptions", "batch-002.json"), JSON.stringify([
      { id: "C", description: "desc C" },
    ]));

    const result = runMerge(testDir, "descriptions");
    expect(result.merged).toBe(2);

    const merged = JSON.parse(readFileSync(join(enrichDir, "descriptions.json"), "utf-8"));
    expect(merged).toHaveLength(3);
    expect(merged[0].id).toBe("A");
    expect(merged[2].id).toBe("C");
  });

  it("merges profile files into profiles.json", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(join(enrichDir, "output", "profiles"), { recursive: true });

    writeFileSync(join(enrichDir, "output", "profiles", "community-001.json"), JSON.stringify({
      communityId: "0", label: "Auth", profile: "handles auth", misfits: [],
    }));
    writeFileSync(join(enrichDir, "output", "profiles", "community-002.json"), JSON.stringify({
      communityId: "1", label: "Data", profile: "handles data", misfits: [],
    }));

    const result = runMerge(testDir, "profiles");
    expect(result.merged).toBe(2);

    const merged = JSON.parse(readFileSync(join(enrichDir, "profiles.json"), "utf-8"));
    expect(merged).toHaveLength(2);
    expect(merged[0].communityId).toBe("0");
  });

  it("throws when output batch directory doesn't exist", () => {
    expect(() => runMerge(testDir, "descriptions")).toThrow("Output batch directory not found");
  });

  it("throws when no batch files match pattern", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(join(enrichDir, "output", "descriptions"), { recursive: true });
    writeFileSync(join(enrichDir, "output", "descriptions", "garbage.txt"), "not json");

    expect(() => runMerge(testDir, "descriptions")).toThrow("No batch files found");
  });

  it("sorts batch files by name before merging", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(join(enrichDir, "output", "descriptions"), { recursive: true });

    // Write in reverse order
    writeFileSync(join(enrichDir, "output", "descriptions", "batch-003.json"), JSON.stringify([{ id: "C", description: "third" }]));
    writeFileSync(join(enrichDir, "output", "descriptions", "batch-001.json"), JSON.stringify([{ id: "A", description: "first" }]));

    runMerge(testDir, "descriptions");
    const merged = JSON.parse(readFileSync(join(enrichDir, "descriptions.json"), "utf-8"));
    expect(merged[0].id).toBe("A"); // sorted by filename → batch-001 first
    expect(merged[1].id).toBe("C");
  });

  it("merges restructure file as-is (copyRaw, no array wrapping)", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(join(enrichDir, "output", "restructure"), { recursive: true });

    const restructureData = {
      merges: [{ communities: ["0", "1"], newLabel: "Merged", reason: "tightly coupled" }],
      splits: [],
    };
    writeFileSync(join(enrichDir, "output", "restructure", "restructure.json"), JSON.stringify(restructureData));

    const result = runMerge(testDir, "restructure");
    expect(result.merged).toBe(1);

    const final = JSON.parse(readFileSync(join(enrichDir, "restructure.json"), "utf-8"));
    // Must be the object directly, NOT wrapped in an array
    expect(final.merges).toBeDefined();
    expect(final.splits).toBeDefined();
    expect(Array.isArray(final)).toBe(false);
    expect(final.merges[0].communities).toEqual(["0", "1"]);
  });
});

// ─── APPLY ───────────────────────────────────────────────────────────────────

describe("enrich:apply", () => {
  beforeEach(() => {
    writeJson(join(testDir, "graph.json"), makeGraphData());
  });

  it("moves nodes according to routing decisions", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(enrichDir, { recursive: true });

    writeFileSync(join(enrichDir, "routing.json"), JSON.stringify([
      { node: "A", action: "move", to: "1", reason: "better fit" },
    ]));
    writeFileSync(join(enrichDir, "restructure.json"), JSON.stringify({ merges: [], splits: [] }));

    const result = runApply(testDir);
    expect(result.moved).toBe(1);

    const applied = JSON.parse(readFileSync(join(enrichDir, "graph-applied.json"), "utf-8"));
    const nodeA = applied.nodes.find((n: any) => n.id === "A");
    expect(nodeA.community).toBe("1");
  });

  it("ignores stay decisions", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(enrichDir, { recursive: true });

    writeFileSync(join(enrichDir, "routing.json"), JSON.stringify([
      { node: "A", action: "stay", reason: "fine where it is" },
    ]));
    writeFileSync(join(enrichDir, "restructure.json"), JSON.stringify({ merges: [], splits: [] }));

    const result = runApply(testDir);
    expect(result.moved).toBe(0);

    const applied = JSON.parse(readFileSync(join(enrichDir, "graph-applied.json"), "utf-8"));
    const nodeA = applied.nodes.find((n: any) => n.id === "A");
    expect(nodeA.community).toBe("0"); // unchanged
  });

  it("applies merge: all nodes get target community", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(enrichDir, { recursive: true });

    writeFileSync(join(enrichDir, "routing.json"), JSON.stringify([]));
    writeFileSync(join(enrichDir, "restructure.json"), JSON.stringify({
      merges: [{ communities: ["0", "1"], newLabel: "Merged", reason: "too similar" }],
      splits: [],
    }));

    const result = runApply(testDir);
    expect(result.merged).toBe(1);

    const applied = JSON.parse(readFileSync(join(enrichDir, "graph-applied.json"), "utf-8"));
    // All nodes from community 1 should now be in community 0
    const nodeC = applied.nodes.find((n: any) => n.id === "C");
    const nodeD = applied.nodes.find((n: any) => n.id === "D");
    expect(nodeC.community).toBe("0");
    expect(nodeD.community).toBe("0");
  });

  it("applies split: specified nodes get new community IDs", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(enrichDir, { recursive: true });

    writeFileSync(join(enrichDir, "routing.json"), JSON.stringify([]));
    writeFileSync(join(enrichDir, "restructure.json"), JSON.stringify({
      merges: [],
      splits: [{
        community: "0",
        reason: "too large",
        into: [
          { label: "group alpha", nodes: ["A"] },
          { label: "group beta", nodes: ["B", "E"] },
        ],
      }],
    }));

    const result = runApply(testDir);
    expect(result.split).toBe(1);

    const applied = JSON.parse(readFileSync(join(enrichDir, "graph-applied.json"), "utf-8"));
    const nodeA = applied.nodes.find((n: any) => n.id === "A");
    const nodeB = applied.nodes.find((n: any) => n.id === "B");
    // They should have new community IDs containing "split_"
    expect(nodeA.community).toContain("split_");
    expect(nodeB.community).toContain("split_");
    expect(nodeA.community).not.toBe(nodeB.community);
  });

  it("writes modified-communities.json with correct lists", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(enrichDir, { recursive: true });

    writeFileSync(join(enrichDir, "routing.json"), JSON.stringify([
      { node: "A", action: "move", to: "1", reason: "test" },
    ]));
    writeFileSync(join(enrichDir, "restructure.json"), JSON.stringify({ merges: [], splits: [] }));

    runApply(testDir);
    const modified = JSON.parse(readFileSync(join(enrichDir, "modified-communities.json"), "utf-8"));
    expect(modified.modified).toContain("0"); // source community
    expect(modified.modified).toContain("1"); // target community
  });

  it("handles empty routing and restructure", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(enrichDir, { recursive: true });

    writeFileSync(join(enrichDir, "routing.json"), JSON.stringify([]));
    writeFileSync(join(enrichDir, "restructure.json"), JSON.stringify({ merges: [], splits: [] }));

    const result = runApply(testDir);
    expect(result.moved).toBe(0);
    expect(result.merged).toBe(0);
    expect(result.split).toBe(0);
  });
});

// ─── FINALIZE ────────────────────────────────────────────────────────────────

describe("enrich:finalize", () => {
  it("produces all three output files", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(enrichDir, { recursive: true });

    const graphApplied = makeGraphData();
    writeFileSync(join(enrichDir, "graph-applied.json"), JSON.stringify(graphApplied));
    writeFileSync(join(enrichDir, "descriptions.json"), JSON.stringify([
      { id: "A", description: "desc A" },
    ]));
    writeFileSync(join(enrichDir, "profiles.json"), JSON.stringify([
      { communityId: "0", label: "Auth", profile: "handles auth", misfits: [] },
    ]));

    runFinalize(testDir);

    expect(existsSync(join(testDir, "graph-enriched.json"))).toBe(true);
    expect(existsSync(join(testDir, "node_descriptions.json"))).toBe(true);
    expect(existsSync(join(testDir, "community_summaries.json"))).toBe(true);
  });

  it("merges profiles + updated-profiles into community_summaries.json", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(enrichDir, { recursive: true });

    writeFileSync(join(enrichDir, "graph-applied.json"), JSON.stringify(makeGraphData()));
    writeFileSync(join(enrichDir, "descriptions.json"), JSON.stringify([]));
    writeFileSync(join(enrichDir, "profiles.json"), JSON.stringify([
      { communityId: "0", label: "Old Label", profile: "old profile", misfits: [] },
      { communityId: "1", label: "Data", profile: "handles data", misfits: [] },
    ]));
    writeFileSync(join(enrichDir, "updated-profiles.json"), JSON.stringify([
      { communityId: "0", label: "New Label", profile: "updated profile", misfits: [] },
    ]));

    runFinalize(testDir);

    const summaries = JSON.parse(readFileSync(join(testDir, "community_summaries.json"), "utf-8"));
    const comm0 = summaries.find((s: any) => s.id === "0");
    expect(comm0.label).toBe("New Label"); // updated overrides original
    expect(comm0.summary).toBe("updated profile");
  });

  it("computes nodeCount from graph-applied.json", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(enrichDir, { recursive: true });

    writeFileSync(join(enrichDir, "graph-applied.json"), JSON.stringify(makeGraphData()));
    writeFileSync(join(enrichDir, "descriptions.json"), JSON.stringify([]));
    writeFileSync(join(enrichDir, "profiles.json"), JSON.stringify([
      { communityId: "0", label: "Auth", profile: "handles auth", misfits: [] },
    ]));

    runFinalize(testDir);
    const summaries = JSON.parse(readFileSync(join(testDir, "community_summaries.json"), "utf-8"));
    const comm0 = summaries.find((s: any) => s.id === "0");
    expect(comm0.nodeCount).toBe(3); // A, B, E are in community 0
  });

  it("throws when required inputs are missing", () => {
    expect(() => runFinalize(testDir)).toThrow("Missing required input");
  });

  it("handles missing updated-profiles.json gracefully", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(enrichDir, { recursive: true });

    writeFileSync(join(enrichDir, "graph-applied.json"), JSON.stringify(makeGraphData()));
    writeFileSync(join(enrichDir, "descriptions.json"), JSON.stringify([]));
    writeFileSync(join(enrichDir, "profiles.json"), JSON.stringify([
      { communityId: "0", label: "Auth", profile: "handles auth", misfits: [] },
    ]));
    // No updated-profiles.json

    runFinalize(testDir); // should NOT throw
    expect(existsSync(join(testDir, "community_summaries.json"))).toBe(true);
  });
});

// ─── BATCHER ─────────────────────────────────────────────────────────────────

describe("batcher", () => {
  it("packs nodes into batches within token budget", () => {
    // Create temp source files
    const repoDir = join(testDir, "repo");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "a.py"), "x = 1\n".repeat(100)); // ~600 chars = ~150 tokens
    writeFileSync(join(repoDir, "src", "b.py"), "y = 2\n".repeat(100));
    writeFileSync(join(repoDir, "src", "c.py"), "z = 3\n".repeat(100));

    const nodes = [
      { id: "A", label: "A", type: "function", source_file: "src/a.py", start_line: 1, end_line: 100, repo: "test" },
      { id: "B", label: "B", type: "function", source_file: "src/b.py", start_line: 1, end_line: 100, repo: "test" },
      { id: "C", label: "C", type: "function", source_file: "src/c.py", start_line: 1, end_line: 100, repo: "test" },
    ];

    const repoRoots = new Map([["test", repoDir]]);
    const batches = packBatches(nodes, repoRoots, 200); // Very small budget → should split
    expect(batches.length).toBeGreaterThan(1);
  });

  it("handles nodes without source code", () => {
    const nodes = [
      { id: "X", label: "X", type: "function" }, // no source_file
      { id: "Y", label: "Y", type: "function", source_file: "nonexistent.py", start_line: 1, end_line: 10, repo: "test" },
    ];

    const repoRoots = new Map([["test", "/nonexistent"]]);
    const batches = packBatches(nodes, repoRoots, 10000);
    expect(batches).toHaveLength(0); // all nodes skipped
  });

  it("creates single batch for small graphs", () => {
    const repoDir = join(testDir, "repo");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "a.py"), "def foo(): pass\n");

    const nodes = [
      { id: "A", label: "A", type: "function", source_file: "src/a.py", start_line: 1, end_line: 1, repo: "test" },
    ];

    const repoRoots = new Map([["test", repoDir]]);
    const batches = packBatches(nodes, repoRoots, 10000);
    expect(batches).toHaveLength(1);
    expect(batches[0].items[0].nodeId).toBe("A");
  });

  it("caps file content at maxCharsPerFile", () => {
    const repoDir = join(testDir, "repo");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "big.py"), "x".repeat(50000));

    const node = { id: "big", label: "big", type: "function", source_file: "src/big.py", start_line: 1, end_line: 1, repo: "test" };
    const repoRoots = new Map([["test", repoDir]]);
    const code = extractNodeCode(node, repoRoots, 100);
    expect(code).not.toBeNull();
    expect(code!.length).toBe(100);
  });
});

// ─── PROMPTS ─────────────────────────────────────────────────────────────────

describe("prompts", () => {
  it("buildDescriptionPrompt includes file path and line ranges", () => {
    const batch = [{
      nodeId: "A", qualifiedName: "module.A", filePath: "src/a.py",
      startLine: 1, endLine: 10, code: "def A(): pass", estimatedTokens: 5,
    }];
    const { system, user } = buildDescriptionPrompt(batch);
    expect(system).toContain("JSON array");
    expect(user).toContain("src/a.py");
    expect(user).toContain("lines 1-10");
    expect(user).toContain("def A(): pass");
  });

  it("buildProfilePrompt includes node descriptions and edges", () => {
    const { system, user } = buildProfilePrompt("0", [
      { id: "A", description: "handles auth" },
    ], [
      { source: "A", target: "B", type: "calls" },
    ]);
    expect(system).toContain("profiling");
    expect(user).toContain("Nodes:");
    expect(user).toContain("handles auth");
    expect(user).toContain("Internal edges:");
  });

  it("buildProfilePrompt respects custom maxNodes limit", () => {
    const members = Array.from({ length: 100 }, (_, i) => ({ id: `N${i}`, description: `desc ${i}` }));
    const edges = Array.from({ length: 10 }, (_, i) => ({ source: `N${i}`, target: `N${i + 1}`, type: "calls" }));

    // Default (80)
    const { user: defaultUser } = buildProfilePrompt("0", members, edges);
    expect(defaultUser).toContain("... and 20 more nodes");

    // Custom limit (5)
    const { user: limitedUser } = buildProfilePrompt("0", members, edges, { maxNodes: 5 });
    expect(limitedUser).toContain("... and 95 more nodes");
    // Only 5 nodes should appear
    expect(limitedUser).toContain("N0");
    expect(limitedUser).toContain("N4");
    expect(limitedUser).not.toContain("- N5:");
  });

  it("buildProfilePrompt respects custom maxEdges limit", () => {
    const members = [{ id: "A", description: "x" }];
    const edges = Array.from({ length: 100 }, (_, i) => ({ source: `N${i}`, target: `N${i + 1}`, type: "calls" }));

    // Custom limit (3)
    const { user } = buildProfilePrompt("0", members, edges, { maxEdges: 3 });
    expect(user).toContain("... and 97 more edges");
  });

  it("buildRoutingPrompt includes community profiles and candidates", () => {
    const profiles = new Map([
      ["0", { communityId: "0", label: "Auth", profile: "handles auth", misfits: [] }],
    ]);
    const { system, user } = buildRoutingPrompt([
      { nodeId: "A", description: "test", currentCommunity: "0", adjacentCommunities: [{ id: "1", edgeCount: 3 }] },
    ], profiles);
    expect(system).toContain("STAY");
    expect(user).toContain("Community profiles");
    expect(user).toContain("1. A (current: 0)");
  });

  it("buildRestructurePrompt includes all context sections", () => {
    const { system, user } = buildRestructurePrompt(
      [{ communityId: "0", label: "Auth", profile: "handles auth", misfits: [] }],
      [{ communityA: "0", communityB: "1", edgeCount: 5 }],
      new Map([["1", 7]]),
      [{ communityId: "0", nodeCount: 50 }],
    );
    expect(system).toContain("merges");
    expect(user).toContain("Communities");
    expect(user).toContain("High cross-edge");
    expect(user).toContain("gained");
    expect(user).toContain("Size outliers");
  });
});

// ─── LLM EXECUTOR ────────────────────────────────────────────────────────────

describe("llm-executor", () => {
  it("parseLlmJson handles clean JSON", () => {
    const result = parseLlmJson<{ key: string }>('{"key": "value"}');
    expect(result.key).toBe("value");
  });

  it("parseLlmJson strips markdown fences", () => {
    const result = parseLlmJson<{ key: string }>('```json\n{"key": "value"}\n```');
    expect(result.key).toBe("value");
  });

  it("parseLlmJson strips fences without language tag", () => {
    const result = parseLlmJson<number[]>('```\n[1, 2, 3]\n```');
    expect(result).toEqual([1, 2, 3]);
  });

  it("parseLlmJson throws on invalid JSON", () => {
    expect(() => parseLlmJson("not json at all")).toThrow();
  });

  it("parseLlmJson handles arrays", () => {
    const result = parseLlmJson<Array<{ id: string }>>('[{"id": "A"}, {"id": "B"}]');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("A");
  });
});
