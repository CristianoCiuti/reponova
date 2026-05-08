/**
 * Tests for BuildConfigFingerprint in graph.json metadata.
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

function makeTmpDir(): string {
  const dir = join(tmpdir(), `rn-test-fix013-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
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

describe("BuildConfigFingerprint", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try { if (existsSync(d)) unlinkSync(join(d, "graph.json")); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  it("should write build_config to graph.json when config is provided", () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const tmpPath = join(tmpDir, "graph.json");

    exportJson({
      graph: makeGraph(),
      outputPath: tmpPath,
      config: makeConfig(),
      configDir: tmpDir,
      outputDir: tmpDir,
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
    expect(bc.community_summaries.enabled).toBe(true);
    expect(bc.node_descriptions.enabled).toBe(true);
  });

  it("should write build_config with custom embeddings config", () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const tmpPath = join(tmpDir, "graph.json");

    const config = makeConfig();
    config.embeddings = {
      enabled: true,
      method: "onnx",
      model: "multi-qa-MiniLM-L6-cos-v1",
      dimensions: 384,
      batch_size: 64,
    };

    exportJson({
      graph: makeGraph(),
      outputPath: tmpPath,
      config,
      configDir: tmpDir,
      outputDir: tmpDir,
    });

    const raw = JSON.parse(readFileSync(tmpPath, "utf-8"));
    const bc = raw.metadata.build_config;
    expect(bc.embeddings.method).toBe("onnx");
    expect(bc.embeddings.model).toBe("multi-qa-MiniLM-L6-cos-v1");
  });

  it("should write build_config with LLM model URIs", () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const tmpPath = join(tmpDir, "graph.json");

    const config = makeConfig();
    config.community_summaries = {
      enabled: true,
      max_number: 10,
      model: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M",
      context_size: 1024,
    };
    config.node_descriptions = {
      enabled: true,
      threshold: 0.5,
      model: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M",
      context_size: 512,
    };

    exportJson({
      graph: makeGraph(),
      outputPath: tmpPath,
      config,
      configDir: tmpDir,
      outputDir: tmpDir,
    });

    const raw = JSON.parse(readFileSync(tmpPath, "utf-8"));
    const bc = raw.metadata.build_config;
    // Fingerprint only stores enabled flag — not model/max_number/threshold
    expect(bc.community_summaries.enabled).toBe(true);
    expect(bc.node_descriptions.enabled).toBe(true);
  });

  it("should write undefined build_config when no config provided", () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const tmpPath = join(tmpDir, "graph.json");

    exportJson({
      graph: makeGraph(),
      outputPath: tmpPath,
    });

    const raw = JSON.parse(readFileSync(tmpPath, "utf-8"));
    expect(raw.metadata.reponova_version).toBeDefined();
    expect(raw.metadata.built_at).toBeDefined();
    expect(raw.metadata.build_config).toBeUndefined();
  });

  it("should not include runtime-only params (batch_size)", () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const tmpPath = join(tmpDir, "graph.json");

    exportJson({
      graph: makeGraph(),
      outputPath: tmpPath,
      config: makeConfig(),
      configDir: tmpDir,
      outputDir: tmpDir,
    });

    const raw = JSON.parse(readFileSync(tmpPath, "utf-8"));
    const bc = raw.metadata.build_config;

    // embeddings should NOT have batch_size
    expect(bc.embeddings.batch_size).toBeUndefined();
  });

  it("graph-loader should parse build_config from graph.json", () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const tmpPath = join(tmpDir, "graph.json");

    exportJson({
      graph: makeGraph(),
      outputPath: tmpPath,
      config: makeConfig(),
      configDir: tmpDir,
      outputDir: tmpDir,
    });

    const graphData = loadGraphData(tmpPath);
    expect(graphData.metadata).toBeDefined();
    expect(graphData.metadata!.build_config).toBeDefined();

    const bc = graphData.metadata!.build_config!;
    expect(bc.embeddings.method).toBe("tfidf");
    expect(bc.outlines.enabled).toBe(true);
    expect(bc.community_summaries.enabled).toBe(true);
    expect(bc.node_descriptions.enabled).toBe(true);
  });
});
