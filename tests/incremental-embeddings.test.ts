import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { runIntelligenceLayer, loadNodeTextCache } from "../src/build/intelligence.js";
import type { Config, GraphData } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("PROP-I3: incremental embeddings", () => {
  it("writes node text cache and skips regeneration when texts are unchanged", async () => {
    const { config, outputDir, graphJsonPath } = setup();
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta")]);

    const first = await runIntelligenceLayer(config, outputDir, graphJsonPath);
    const firstVectors = loadVectors(outputDir);

    const second = await runIntelligenceLayer(config, outputDir, graphJsonPath);
    const secondVectors = loadVectors(outputDir);

    expect(first.embeddingsGenerated).toBe(2);
    expect(second.embeddingsGenerated).toBe(0);
    expect(loadNodeTextCache(outputDir)).toEqual(new Map(Object.entries({
      "node-a": firstVectors.find((record) => record.id === "node-a")!.text,
      "node-b": firstVectors.find((record) => record.id === "node-b")!.text,
    })));
    expect(secondVectors).toEqual(firstVectors);
  });

  it("regenerates only changed node embeddings and preserves unchanged vectors", async () => {
    const { config, outputDir, graphJsonPath } = setup();
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta")]);
    await runIntelligenceLayer(config, outputDir, graphJsonPath);
    const firstVectors = loadVectors(outputDir);

    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha updated"), makeNode("node-b", "Beta")]);
    const result = await runIntelligenceLayer(config, outputDir, graphJsonPath);
    const secondVectors = loadVectors(outputDir);

    expect(result.embeddingsGenerated).toBe(1);
    expect(vectorFor(firstVectors, "node-b")).toEqual(vectorFor(secondVectors, "node-b"));
    expect(vectorFor(firstVectors, "node-a")).not.toEqual(vectorFor(secondVectors, "node-a"));
  });

  it("adds new nodes and removes deleted nodes from the vector store", async () => {
    const { config, outputDir, graphJsonPath } = setup();
    writeGraph(graphJsonPath, [makeNode("node-a", "Alpha"), makeNode("node-b", "Beta")]);
    await runIntelligenceLayer(config, outputDir, graphJsonPath);

    writeGraph(graphJsonPath, [makeNode("node-b", "Beta"), makeNode("node-c", "Gamma")]);
    const result = await runIntelligenceLayer(config, outputDir, graphJsonPath);
    const vectors = loadVectors(outputDir);

    expect(result.embeddingsGenerated).toBe(1);
    expect(vectors.map((record) => record.id).sort()).toEqual(["node-b", "node-c"]);
    expect(loadNodeTextCache(outputDir).has("node-a")).toBe(false);
    expect(loadNodeTextCache(outputDir).has("node-c")).toBe(true);
  });
});

function setup(): { config: Config; outputDir: string; graphJsonPath: string } {
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
  return JSON.parse(readFileSync(join(outputDir, "vectors", "vectors.json"), "utf-8")) as Array<{ id: string; text: string; vector: number[] }>;
}

function vectorFor(records: Array<{ id: string; vector: number[] }>, id: string): number[] {
  const record = records.find((entry) => entry.id === id);
  if (!record) throw new Error(`Missing vector for ${id}`);
  return record.vector;
}
