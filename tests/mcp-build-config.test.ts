import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveEmbeddingsConfig } from "../src/mcp/server.js";
import { readBuildConfigStatusLines } from "../src/mcp/tools/status.js";
import { verifyGraphArtifacts } from "../src/cli/check.js";
import type { BuildConfigFingerprint } from "../src/shared/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("FIX-010v2: MCP build_config metadata", () => {
  it("resolves embeddings config from graph.json metadata", () => {
    const graphJsonPath = writeGraphJson(makeTempDir(), {
      embeddings: { enabled: true, method: "onnx", model: "multi-qa-MiniLM-L6-cos-v1", dimensions: 384 },
    });

    expect(resolveEmbeddingsConfig(graphJsonPath)).toEqual({
      enabled: true,
      method: "onnx",
      model: "multi-qa-MiniLM-L6-cos-v1",
      dimensions: 384,
      batch_size: 128,
    });
  });

  it("throws an actionable error when build_config is missing", () => {
    const dir = makeTempDir();
    const graphJsonPath = join(dir, "graph.json");
    writeFileSync(graphJsonPath, JSON.stringify({ nodes: [], edges: [], metadata: {} }, null, 2));

    expect(() => resolveEmbeddingsConfig(graphJsonPath)).toThrow(
      "graph.json missing build_config — rebuild with: reponova build --force",
    );
  });

  it("formats build_config status lines from graph.json metadata", () => {
    const graphJsonPath = writeGraphJson(makeTempDir(), {
      embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
      outlines: { enabled: false, paths: [], exclude: [] },
      community_summaries: { enabled: true, max_number: 3, model: null },
      node_descriptions: { enabled: false, threshold: 0.8, model: null },
    });

    expect(readBuildConfigStatusLines(graphJsonPath)).toEqual([
      "Build config:",
      "  Embeddings: tfidf (all-MiniLM-L6-v2, 384d)",
      "  Outlines: disabled",
      "  Community summaries: enabled",
      "  Node descriptions: disabled",
    ]);
  });

  it("reports missing build_config as a check error", () => {
    const dir = makeTempDir();
    const graphJsonPath = join(dir, "graph.json");
    writeFileSync(graphJsonPath, JSON.stringify({ nodes: [], edges: [], metadata: {} }, null, 2));

    const checks = verifyGraphArtifacts(dir, graphJsonPath);

    expect(checks).toEqual([
      {
        label: "Build metadata",
        status: "graph.json missing build_config — rebuild with: reponova build --force ✗",
        ok: false,
      },
    ]);
  });

  it("warns when onnx metadata conflicts with stale tfidf artifacts", () => {
    const dir = makeTempDir();
    const graphJsonPath = writeGraphJson(dir, {
      embeddings: { enabled: true, method: "onnx", model: "all-MiniLM-L6-v2", dimensions: 384 },
    });
    writeFileSync(join(dir, "tfidf_idf.json"), "{}");

    const checks = verifyGraphArtifacts(dir, graphJsonPath);

    expect(checks).toEqual([
      { label: "Build metadata", status: "build_config present ✓", ok: true },
      {
        label: "Embeddings artifacts",
        status: "WARNING: tfidf_idf.json exists but build_config.embeddings.method is onnx",
        ok: true,
      },
    ]);
  });

  it("errors when tfidf metadata is missing the required idf artifact", () => {
    const dir = makeTempDir();
    const graphJsonPath = writeGraphJson(dir, {
      embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
    });

    const checks = verifyGraphArtifacts(dir, graphJsonPath);

    expect(checks).toEqual([
      { label: "Build metadata", status: "build_config present ✓", ok: true },
      {
        label: "Embeddings artifacts",
        status: "ERROR: TF-IDF build missing tfidf_idf.json ✗",
        ok: false,
      },
    ]);
  });
});

function makeTempDir(): string {
  const dir = join(tmpdir(), `rn-test-fix010v2-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeGraphJson(dir: string, overrides: Partial<BuildConfigFingerprint> = {}): string {
  const graphJsonPath = join(dir, "graph.json");
  const buildConfig: BuildConfigFingerprint = {
    embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
    outlines: { enabled: true, paths: ["src/**/*.ts"], exclude: ["**/dist/**"] },
    community_summaries: { enabled: true, max_number: 0, model: null },
    node_descriptions: { enabled: true, threshold: 0.8, model: null },
    ...overrides,
  };

  writeFileSync(graphJsonPath, JSON.stringify({
    nodes: [],
    edges: [],
    metadata: {
      build_config: buildConfig,
    },
  }, null, 2));

  return graphJsonPath;
}
