import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runEmbeddingsStep } from "../src/build/steps/embeddings-step.js";
import { runCommunitySummariesStep } from "../src/build/steps/community-summaries-step.js";
import { runNodeDescriptionsStep } from "../src/build/steps/node-descriptions-step.js";
import type { StepContext } from "../src/build/types.js";
import type { BuildConfigFingerprint, Config, GraphData } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";

const tempDirs: string[] = [];

const generatorMocks = vi.hoisted(() => ({
  communityGenerate: vi.fn(async (communities: Array<{ id: string }>) => communities.map((community) => ({
    id: community.id,
    nodeCount: 3,
    summary: `summary:${community.id}`,
    hub_nodes: ["a"],
    primary_path: "src",
    repos: ["repo"],
  }))),
  nodeGenerate: vi.fn(async (nodes: Array<{ id: string; label: string }>) => nodes.map((node) => ({
    id: node.id,
    description: `description:${node.label}`,
  }))),
}));

vi.mock("@lancedb/lancedb", () => ({
  connect: async () => { throw new Error("mock: lancedb unavailable"); },
}));
vi.mock("../src/build/intelligence/community-summary-generator.js", () => ({
  CommunitySummaryGenerator: class {
    async generate(communities: Array<{ id: string }>) {
      return generatorMocks.communityGenerate(communities);
    }
  },
}));
vi.mock("../src/build/intelligence/node-description-generator.js", () => ({
  NodeDescriptionGenerator: class {
    async generate(nodes: Array<{ id: string; label: string }>) {
      return generatorMocks.nodeGenerate(nodes);
    }
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("step-level config-change forcing", () => {
  it("forces embeddings when embeddings method changed", async () => {
    const { config, outputDir, graphJsonPath } = setup();
    writeGraph(graphJsonPath, baseGraph());

    const previousConfig = makePreviousConfig({
      embeddings: { enabled: true, method: "onnx", model: "all-MiniLM-L6-v2", dimensions: 384 },
    });

    const result = await runEmbeddingsStep(makeContext({ config, outputDir, graphJsonPath, previousConfig, graphChanged: false }));

    expect(result.skipped).toBe(false);
    expect(result.processed).toBe(3);
    expect(JSON.parse(readFileSync(join(outputDir, "vectors", "vectors.json"), "utf-8"))).toHaveLength(3);
  });

  it("forces community summaries when model changed", async () => {
    const { config, outputDir, graphJsonPath } = setup();
    writeGraph(graphJsonPath, baseGraph());

    const previousConfig = makePreviousConfig({
      community_summaries: { enabled: true, max_number: 0, model: "hf:old/model", context_size: 512 },
    });

    const result = await runCommunitySummariesStep(makeContext({ config, outputDir, graphJsonPath, previousConfig, graphChanged: false }));

    expect(result.skipped).toBe(false);
    expect(result.processed).toBe(1);
    expect(generatorMocks.communityGenerate).toHaveBeenCalledTimes(1);
  });

  it("forces node descriptions when model changed", async () => {
    const { config, outputDir, graphJsonPath } = setup();
    config.build.node_descriptions.threshold = 0;
    writeGraph(graphJsonPath, baseGraph());

    const previousConfig = makePreviousConfig({
      node_descriptions: { enabled: true, threshold: 0, model: "hf:old/model", context_size: 512 },
    });

    const result = await runNodeDescriptionsStep(makeContext({ config, outputDir, graphJsonPath, previousConfig, graphChanged: false }));

    expect(result.skipped).toBe(false);
    expect(result.processed).toBe(3);
    expect(generatorMocks.nodeGenerate).toHaveBeenCalledTimes(1);
  });
});

function setup(): { config: Config; outputDir: string; graphJsonPath: string } {
  const root = join(tmpdir(), `rn-test-selective-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(root);

  const outputDir = join(root, "out");
  mkdirSync(outputDir, { recursive: true });

  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
  config.build.embeddings.method = "tfidf";
  config.build.community_summaries.enabled = true;
  config.build.node_descriptions.enabled = true;
  config.build.node_descriptions.threshold = 0;

  return { config, outputDir, graphJsonPath: join(outputDir, "graph.json") };
}

function makeContext(overrides: Partial<StepContext>): StepContext {
  return {
    config: overrides.config!,
    outputDir: overrides.outputDir!,
    graphJsonPath: overrides.graphJsonPath!,
    force: false,
    graphChanged: true,
    previousConfig: null,
    ...overrides,
  };
}

function makePreviousConfig(overrides: Partial<BuildConfigFingerprint>): BuildConfigFingerprint {
  return {
    embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
    outlines: { enabled: true, patterns: [], exclude: [], exclude_common: true },
    community_summaries: { enabled: true, max_number: 0, model: null, context_size: 512 },
    node_descriptions: { enabled: true, threshold: 0, model: null, context_size: 512 },
    ...overrides,
  };
}

function baseGraph(): GraphData {
  return {
    nodes: [
      { id: "a", label: "Alpha", type: "function", source_file: "a.py", repo: "repo", community: "1", signature: "()" },
      { id: "b", label: "Beta", type: "function", source_file: "b.py", repo: "repo", community: "1", signature: "()" },
      { id: "c", label: "Gamma", type: "function", source_file: "c.py", repo: "repo", community: "1", signature: "()" },
    ],
    edges: [
      { source: "a", target: "b", type: "calls" },
      { source: "b", target: "c", type: "calls" },
      { source: "c", target: "a", type: "calls" },
    ],
    metadata: {
      build_config: makePreviousConfig({
        node_descriptions: { enabled: true, threshold: 0, model: null, context_size: 512 },
      }),
    },
  };
}

function writeGraph(path: string, graph: GraphData): void {
  writeFileSync(path, JSON.stringify(graph, null, 2));
}
