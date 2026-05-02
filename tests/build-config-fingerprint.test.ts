/**
 * Tests for FIX-013: BuildConfigFingerprint in graph.json metadata.
 *
 * Verifies that build_config is correctly written to graph.json
 * and correctly parsed back by graph-loader.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Graph from "graphology";
import { exportJson } from "../src/extract/export-json.js";
import { loadGraphData } from "../src/core/graph-loader.js";
import type { Config, BuildConfigFingerprint } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpPath(): string {
  const dir = join(tmpdir(), `rn-test-fix013-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "graph.json");
}

function makeGraph(): Graph {
  const g = new Graph({ type: "directed", multi: false, allowSelfLoops: false });
  g.addNode("mod_main", {
    label: "main",
    type: "module",
    file_type: "code",
    source_file: "main.py",
    community: 0,
    norm_label: "main",
    start_line: 1,
  });
  g.addNode("fn_hello", {
    label: "hello",
    type: "function",
    file_type: "code",
    source_file: "main.py",
    source_location: "L5-L10",
    community: 0,
    norm_label: "hello",
    start_line: 5,
    end_line: 10,
  });
  g.addEdge("mod_main", "fn_hello", {
    relation: "contains",
    confidence: "EXTRACTED",
    confidence_score: 1.0,
    weight: 1,
  });
  return g;
}

function makeConfig(overrides?: Partial<Config>): Config {
  return JSON.parse(JSON.stringify({ ...DEFAULT_CONFIG, ...overrides })) as Config;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("FIX-013: BuildConfigFingerprint", () => {
  const tmpPaths: string[] = [];

  afterEach(() => {
    for (const p of tmpPaths) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }
    tmpPaths.length = 0;
  });

  it("should write build_config to graph.json when config is provided", () => {
    const tmpPath = makeTmpPath();
    tmpPaths.push(tmpPath);

    const graph = makeGraph();
    const config = makeConfig();

    exportJson({
      graph,
      communities: { count: 1, assignments: new Map([["mod_main", 0], ["fn_hello", 0]]) },
      outputPath: tmpPath,
      config,
    });

    const raw = JSON.parse(readFileSync(tmpPath, "utf-8"));
    expect(raw.metadata).toBeDefined();
    expect(raw.metadata.build_config).toBeDefined();

    const bc = raw.metadata.build_config as BuildConfigFingerprint;
    expect(bc.embeddings.enabled).toBe(true);
    expect(bc.embeddings.method).toBe("tfidf");
    expect(bc.embeddings.model).toBe("all-MiniLM-L6-v2");
    expect(bc.embeddings.dimensions).toBe(384);

    expect(bc.outlines.enabled).toBe(true);
    expect(bc.outlines.paths).toEqual(["src/**/*.ts", "src/**/*.py", "src/**/*.js"]);

    expect(bc.community_summaries.enabled).toBe(true);
    expect(bc.community_summaries.max_number).toBe(0);
    expect(bc.community_summaries.model).toBeNull();

    expect(bc.node_descriptions.enabled).toBe(true);
    expect(bc.node_descriptions.threshold).toBe(0.8);
    expect(bc.node_descriptions.model).toBeNull();
  });

  it("should write build_config with custom embeddings config", () => {
    const tmpPath = makeTmpPath();
    tmpPaths.push(tmpPath);

    const config = makeConfig();
    config.build.embeddings = {
      enabled: true,
      method: "onnx",
      model: "multi-qa-MiniLM-L6-cos-v1",
      dimensions: 384,
      batch_size: 64,
    };

    exportJson({
      graph: makeGraph(),
      communities: { count: 1, assignments: new Map() },
      outputPath: tmpPath,
      config,
    });

    const raw = JSON.parse(readFileSync(tmpPath, "utf-8"));
    const bc = raw.metadata.build_config;
    expect(bc.embeddings.method).toBe("onnx");
    expect(bc.embeddings.model).toBe("multi-qa-MiniLM-L6-cos-v1");
  });

  it("should write build_config with LLM model URIs", () => {
    const tmpPath = makeTmpPath();
    tmpPaths.push(tmpPath);

    const config = makeConfig();
    config.build.community_summaries = {
      enabled: true,
      max_number: 10,
      model: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M",
      context_size: 1024,
    };
    config.build.node_descriptions = {
      enabled: true,
      threshold: 0.5,
      model: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M",
      context_size: 512,
    };

    exportJson({
      graph: makeGraph(),
      communities: { count: 1, assignments: new Map() },
      outputPath: tmpPath,
      config,
    });

    const raw = JSON.parse(readFileSync(tmpPath, "utf-8"));
    const bc = raw.metadata.build_config;
    expect(bc.community_summaries.model).toBe("hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M");
    expect(bc.community_summaries.max_number).toBe(10);
    expect(bc.node_descriptions.model).toBe("hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M");
    expect(bc.node_descriptions.threshold).toBe(0.5);
  });

  it("should write undefined build_config when no config provided (backward compat)", () => {
    const tmpPath = makeTmpPath();
    tmpPaths.push(tmpPath);

    exportJson({
      graph: makeGraph(),
      communities: { count: 1, assignments: new Map() },
      outputPath: tmpPath,
    });

    const raw = JSON.parse(readFileSync(tmpPath, "utf-8"));
    expect(raw.metadata.reponova_version).toBeDefined();
    expect(raw.metadata.built_at).toBeDefined();
    // build_config should not appear in JSON when config is not provided
    expect(raw.metadata.build_config).toBeUndefined();
  });

  it("should not include runtime-only params (batch_size, gpu, threads)", () => {
    const tmpPath = makeTmpPath();
    tmpPaths.push(tmpPath);

    const config = makeConfig();
    exportJson({
      graph: makeGraph(),
      communities: { count: 1, assignments: new Map() },
      outputPath: tmpPath,
      config,
    });

    const raw = JSON.parse(readFileSync(tmpPath, "utf-8"));
    const bc = raw.metadata.build_config;

    // embeddings should NOT have batch_size
    expect(bc.embeddings.batch_size).toBeUndefined();
    // context_size IS now tracked (FIX-017 — needed for change detection)
    expect(bc.community_summaries.context_size).toBe(512);
    expect(bc.node_descriptions.context_size).toBe(512);
    // exclude_common IS now tracked in outlines fingerprint
    expect(bc.outlines.exclude_common).toBe(true);
  });

  it("graph-loader should parse build_config from graph.json", () => {
    const tmpPath = makeTmpPath();
    tmpPaths.push(tmpPath);

    const config = makeConfig();
    exportJson({
      graph: makeGraph(),
      communities: { count: 1, assignments: new Map() },
      outputPath: tmpPath,
      config,
    });

    const graphData = loadGraphData(tmpPath);
    expect(graphData.metadata).toBeDefined();
    expect(graphData.metadata!.build_config).toBeDefined();

    const bc = graphData.metadata!.build_config;
    expect(bc.embeddings.method).toBe("tfidf");
    expect(bc.outlines.enabled).toBe(true);
    expect(bc.community_summaries.model).toBeNull();
    expect(bc.node_descriptions.threshold).toBe(0.8);
  });
});
