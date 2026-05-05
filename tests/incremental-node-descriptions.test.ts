import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runNodeDescriptionsStep } from "../src/build/steps/node-descriptions-step.js";
import type { StepContext } from "../src/build/types.js";
import type { Config, GraphData } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";

const tempDirs: string[] = [];

const generateMock = vi.hoisted(() => vi.fn());

vi.mock("../src/build/intelligence/node-description-generator.js", () => ({
  NodeDescriptionGenerator: class {
    async generate(nodes: Array<{ id: string; label: string }>) {
      return generateMock(nodes);
    }
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("incremental node descriptions", () => {
  it("keeps unchanged nodes from cache", async () => {
    const { graphJsonPath, makeContext, outputDir } = setup();
    writeGraph(graphJsonPath, makeGraph(["a", "b", "c"]));
    generateMock.mockImplementation(async (nodes) => nodes.map((node) => ({ id: node.id, description: `desc:${node.label}` })));

    await runNodeDescriptionsStep(makeContext());
    generateMock.mockClear();

    const result = await runNodeDescriptionsStep(makeContext());

    expect(result.skipped).toBe(true);
    expect(result.processed).toBe(0);
    expect(generateMock).not.toHaveBeenCalled();
    expect(readDescriptions(outputDir)).toHaveLength(3);
  });

  it("regenerates only changed nodes and preserves unchanged cached descriptions", async () => {
    const { graphJsonPath, makeContext, outputDir } = setup();
    writeGraph(graphJsonPath, makeGraph(["a", "b", "c"]));
    generateMock.mockImplementation(async (nodes) => nodes.map((node) => ({ id: node.id, description: `initial:${node.id}` })));
    await runNodeDescriptionsStep(makeContext());

    generateMock.mockImplementation(async (nodes) => nodes.map((node) => ({ id: node.id, description: `updated:${node.id}` })));
    writeGraph(graphJsonPath, makeGraph(["a", "b", "c"], { b: { label: "Beta changed" } }));

    const result = await runNodeDescriptionsStep(makeContext());
    const descriptions = new Map(readDescriptions(outputDir).map((entry) => [entry.id, entry.description]));

    expect(result.processed).toBe(1);
    expect(generateMock).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: "b" })]));
    expect(descriptions.get("a")).toBe("initial:a");
    expect(descriptions.get("b")).toBe("updated:b");
  });

  it("drops nodes removed from the target set", async () => {
    const { graphJsonPath, makeContext, outputDir } = setup();
    writeGraph(graphJsonPath, makeGraph(["a", "b", "c"]));
    generateMock.mockImplementation(async (nodes) => nodes.map((node) => ({ id: node.id, description: `desc:${node.id}` })));
    await runNodeDescriptionsStep(makeContext());

    writeGraph(graphJsonPath, makeGraph(["a", "b"]));
    generateMock.mockClear();
    const result = await runNodeDescriptionsStep(makeContext());

    expect(result.processed).toBe(0);
    expect(readDescriptions(outputDir).map((entry) => entry.id).sort()).toEqual(["a", "b"]);
  });

  it("generates descriptions for new target nodes", async () => {
    const { graphJsonPath, makeContext, outputDir } = setup();
    writeGraph(graphJsonPath, makeGraph(["a", "b"]));
    generateMock.mockImplementation(async (nodes) => nodes.map((node) => ({ id: node.id, description: `desc:${node.id}` })));
    await runNodeDescriptionsStep(makeContext());

    writeGraph(graphJsonPath, makeGraph(["a", "b", "c"]));
    generateMock.mockClear();
    generateMock.mockImplementation(async (nodes) => nodes.map((node) => ({ id: node.id, description: `new:${node.id}` })));

    const result = await runNodeDescriptionsStep(makeContext());

    expect(result.processed).toBe(1);
    expect(readDescriptions(outputDir).map((entry) => entry.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("regenerates everything when force is enabled", async () => {
    const { graphJsonPath, makeContext } = setup();
    writeGraph(graphJsonPath, makeGraph(["a", "b", "c"]));
    generateMock.mockImplementation(async (nodes) => nodes.map((node) => ({ id: node.id, description: `desc:${node.id}` })));
    await runNodeDescriptionsStep(makeContext());

    generateMock.mockClear();
    const result = await runNodeDescriptionsStep(makeContext({ force: true }));

    expect(result.processed).toBe(3);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("removes artifacts when disabled", async () => {
    const { config, graphJsonPath, makeContext, outputDir } = setup();
    writeGraph(graphJsonPath, makeGraph(["a", "b", "c"]));
    generateMock.mockImplementation(async (nodes) => nodes.map((node) => ({ id: node.id, description: `desc:${node.id}` })));
    await runNodeDescriptionsStep(makeContext());

    config.build.node_descriptions.enabled = false;
    const result = await runNodeDescriptionsStep(makeContext());

    expect(result.skipped).toBe(true);
    expect(existsSync(join(outputDir, "node_descriptions.json"))).toBe(false);
    expect(existsSync(join(outputDir, ".cache", "node-description-fingerprints.json"))).toBe(false);
  });

  it("skips immediately when graphChanged=false and force=false", async () => {
    const { graphJsonPath, makeContext } = setup();
    writeGraph(graphJsonPath, makeGraph(["a", "b", "c"]));

    const result = await runNodeDescriptionsStep(makeContext({ graphChanged: false }));

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("graph unchanged");
    expect(generateMock).not.toHaveBeenCalled();
  });
});

function setup(): {
  config: Config;
  outputDir: string;
  graphJsonPath: string;
  makeContext: (overrides?: Partial<StepContext>) => StepContext;
} {
  const root = join(tmpdir(), `rn-test-node-desc-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(root);

  const outputDir = join(root, "out");
  mkdirSync(outputDir, { recursive: true });

  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
  config.build.node_descriptions.enabled = true;
  config.build.node_descriptions.threshold = 0;
  config.build.community_summaries.enabled = false;

  const graphJsonPath = join(outputDir, "graph.json");
  return {
    config,
    outputDir,
    graphJsonPath,
    makeContext: (overrides = {}) => ({
      config,
      outputDir,
      graphJsonPath,
      force: false,
      graphChanged: true,
      previousConfig: null,
      ...overrides,
    }),
  };
}

function makeGraph(ids: string[], overrides: Record<string, Partial<GraphData["nodes"][number]>> = {}): GraphData {
  const nodes = ids.map((id) => ({
    id,
    label: id.toUpperCase(),
    type: "function",
    source_file: `${id}.py`,
    repo: "repo",
    ...(overrides[id] ?? {}),
  }));
  const edges = ids.map((id, index) => ({
    source: id,
    target: ids[(index + 1) % ids.length]!,
    type: "calls",
  }));
  return { nodes, edges };
}

function writeGraph(path: string, graph: GraphData): void {
  writeFileSync(path, JSON.stringify(graph, null, 2));
}

function readDescriptions(outputDir: string): Array<{ id: string; description: string }> {
  return JSON.parse(readFileSync(join(outputDir, "node_descriptions.json"), "utf-8")) as Array<{ id: string; description: string }>;
}
