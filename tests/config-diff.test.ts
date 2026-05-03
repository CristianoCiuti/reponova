/**
 * Tests for FIX-014: Config change detection.
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPreviousBuildConfig } from "../src/build/config-diff.js";
import type { Config } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `rn-test-fix014-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfig(): Config {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
}

function writeGraphJson(dir: string, buildConfig: Record<string, unknown>): string {
  const path = join(dir, "graph.json");
  writeFileSync(path, JSON.stringify({
    nodes: [],
    edges: [],
    metadata: {
      reponova_version: "0.1.21",
      built_at: new Date().toISOString(),
      build_config: buildConfig,
    },
  }));
  return path;
}

describe("FIX-014: Config change detection", () => {
  it("should return isFirstBuild when no graph.json exists", () => {
    const diff = loadPreviousBuildConfig("/nonexistent/graph.json", makeConfig());
    expect(diff.isFirstBuild).toBe(true);
    expect(diff.hasChanges).toBe(false);
  });

  it("should return isFirstBuild when graph.json has no build_config", () => {
    const dir = makeTmpDir();
    const path = join(dir, "graph.json");
    writeFileSync(path, JSON.stringify({ nodes: [], edges: [], metadata: { reponova_version: "0.1.0" } }));

    const diff = loadPreviousBuildConfig(path, makeConfig());
    expect(diff.isFirstBuild).toBe(true);
    expect(diff.hasChanges).toBe(false);
  });

  it("should detect no changes when config matches", () => {
    const dir = makeTmpDir();
    const config = makeConfig();
    const path = writeGraphJson(dir, {
      embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
      outlines: { enabled: true, patterns: ["src/**/*.ts", "src/**/*.py", "src/**/*.js"], exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**"], exclude_common: true },
      community_summaries: { enabled: true, max_number: 0, model: null, context_size: 512 },
      node_descriptions: { enabled: true, threshold: 0.8, model: null, context_size: 512 },
    });

    const diff = loadPreviousBuildConfig(path, config);
    expect(diff.hasChanges).toBe(false);
    expect(diff.isFirstBuild).toBe(false);
    expect(diff.embeddingsChanged).toBe(false);
    expect(diff.outlinesChanged).toBe(false);
    expect(diff.communitySummariesChanged).toBe(false);
    expect(diff.nodeDescriptionsChanged).toBe(false);
  });

  it("should detect embeddings method change (tfidf → onnx)", () => {
    const dir = makeTmpDir();
    const config = makeConfig();
    config.build.embeddings.method = "onnx";

    const path = writeGraphJson(dir, {
      embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
      outlines: { enabled: true, patterns: config.outlines.patterns, exclude: config.outlines.exclude, exclude_common: true },
      community_summaries: { enabled: true, max_number: 0, model: null, context_size: 512 },
      node_descriptions: { enabled: true, threshold: 0.8, model: null, context_size: 512 },
    });

    const diff = loadPreviousBuildConfig(path, config);
    expect(diff.hasChanges).toBe(true);
    expect(diff.embeddingsChanged).toBe(true);
    expect(diff.outlinesChanged).toBe(false);
  });

  it("should detect embeddings model change", () => {
    const dir = makeTmpDir();
    const config = makeConfig();
    config.build.embeddings.model = "multi-qa-MiniLM-L6-cos-v1";

    const path = writeGraphJson(dir, {
      embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
      outlines: { enabled: true, patterns: config.outlines.patterns, exclude: config.outlines.exclude, exclude_common: true },
      community_summaries: { enabled: true, max_number: 0, model: null, context_size: 512 },
      node_descriptions: { enabled: true, threshold: 0.8, model: null, context_size: 512 },
    });

    const diff = loadPreviousBuildConfig(path, config);
    expect(diff.embeddingsChanged).toBe(true);
  });

  it("should detect embeddings enabled → disabled", () => {
    const dir = makeTmpDir();
    const config = makeConfig();
    config.build.embeddings.enabled = false;

    const path = writeGraphJson(dir, {
      embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
      outlines: { enabled: true, patterns: config.outlines.patterns, exclude: config.outlines.exclude, exclude_common: true },
      community_summaries: { enabled: true, max_number: 0, model: null, context_size: 512 },
      node_descriptions: { enabled: true, threshold: 0.8, model: null, context_size: 512 },
    });

    const diff = loadPreviousBuildConfig(path, config);
    expect(diff.embeddingsChanged).toBe(true);
  });

  it("should detect outlines patterns change", () => {
    const dir = makeTmpDir();
    const config = makeConfig();
    config.outlines.patterns = ["src/**/*.py"];

    const path = writeGraphJson(dir, {
      embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
      outlines: { enabled: true, patterns: ["src/**/*.ts", "src/**/*.py", "src/**/*.js"], exclude: config.outlines.exclude, exclude_common: true },
      community_summaries: { enabled: true, max_number: 0, model: null, context_size: 512 },
      node_descriptions: { enabled: true, threshold: 0.8, model: null, context_size: 512 },
    });

    const diff = loadPreviousBuildConfig(path, config);
    expect(diff.outlinesChanged).toBe(true);
  });

  it("should detect community_summaries model change", () => {
    const dir = makeTmpDir();
    const config = makeConfig();
    config.build.community_summaries.model = "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M";

    const path = writeGraphJson(dir, {
      embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
      outlines: { enabled: true, patterns: config.outlines.patterns, exclude: config.outlines.exclude, exclude_common: true },
      community_summaries: { enabled: true, max_number: 0, model: null, context_size: 512 },
      node_descriptions: { enabled: true, threshold: 0.8, model: null, context_size: 512 },
    });

    const diff = loadPreviousBuildConfig(path, config);
    expect(diff.communitySummariesChanged).toBe(true);
    expect(diff.embeddingsChanged).toBe(false);
  });

  it("should detect node_descriptions threshold change", () => {
    const dir = makeTmpDir();
    const config = makeConfig();
    config.build.node_descriptions.threshold = 0.5;

    const path = writeGraphJson(dir, {
      embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
      outlines: { enabled: true, patterns: config.outlines.patterns, exclude: config.outlines.exclude, exclude_common: true },
      community_summaries: { enabled: true, max_number: 0, model: null, context_size: 512 },
      node_descriptions: { enabled: true, threshold: 0.8, model: null, context_size: 512 },
    });

    const diff = loadPreviousBuildConfig(path, config);
    expect(diff.nodeDescriptionsChanged).toBe(true);
  });

  it("should handle corrupted graph.json gracefully", () => {
    const dir = makeTmpDir();
    const path = join(dir, "graph.json");
    writeFileSync(path, "not valid json");

    const diff = loadPreviousBuildConfig(path, makeConfig());
    expect(diff.isFirstBuild).toBe(true);
    expect(diff.hasChanges).toBe(false);
  });

  it("should preserve previous config reference", () => {
    const dir = makeTmpDir();
    const config = makeConfig();
    const path = writeGraphJson(dir, {
      embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
      outlines: { enabled: true, patterns: config.outlines.patterns, exclude: config.outlines.exclude, exclude_common: true },
      community_summaries: { enabled: true, max_number: 0, model: null, context_size: 512 },
      node_descriptions: { enabled: true, threshold: 0.8, model: null, context_size: 512 },
    });

    const diff = loadPreviousBuildConfig(path, config);
    expect(diff.previous).not.toBeNull();
    expect(diff.previous!.embeddings.method).toBe("tfidf");
  });
});
