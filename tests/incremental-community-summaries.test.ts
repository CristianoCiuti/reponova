import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommunitySummariesStep } from "../src/build/steps/community-summaries-step.js";
import type { StepContext } from "../src/build/types.js";
import type { Config, GraphData } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";

const tempDirs: string[] = [];

const generateMock = vi.hoisted(() => vi.fn());

vi.mock("../src/build/intelligence/community-summary-generator.js", () => ({
  CommunitySummaryGenerator: class {
    async generate(communities: Array<{ id: string; nodes: Array<{ id: string }> }>) {
      return generateMock(communities);
    }
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("incremental community summaries", () => {
  it("keeps unchanged communities from cache", async () => {
    const { graphJsonPath, makeContext } = setup();
    writeGraph(graphJsonPath, makeGraph({ 1: ["a", "b", "c"] }));
    generateMock.mockImplementation(async (communities) => communities.map((community) => makeSummary(community.id)));
    await runCommunitySummariesStep(makeContext());

    generateMock.mockClear();
    const result = await runCommunitySummariesStep(makeContext());

    expect(result.skipped).toBe(true);
    expect(result.processed).toBe(0);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("regenerates only changed communities and keeps unchanged ones", async () => {
    const { graphJsonPath, makeContext, outputDir } = setup();
    writeGraph(graphJsonPath, makeGraph({ 1: ["a", "b", "c"], 2: ["d", "e", "f"] }));
    generateMock.mockImplementation(async (communities) => communities.map((community) => makeSummary(community.id, `initial:${community.id}`)));
    await runCommunitySummariesStep(makeContext());

    writeGraph(graphJsonPath, makeGraph({ 1: ["a", "b", "x"], 2: ["d", "e", "f"] }));
    generateMock.mockClear();
    generateMock.mockImplementation(async (communities) => communities.map((community) => makeSummary(community.id, `updated:${community.id}`)));
    const result = await runCommunitySummariesStep(makeContext());
    const summaries = new Map(readSummaries(outputDir).map((entry) => [entry.id, entry.summary]));

    expect(result.processed).toBe(1);
    expect(summaries.get("1")).toBe("updated:1");
    expect(summaries.get("2")).toBe("initial:2");
  });

  it("treats Louvain ID changes with identical nodes as a cache hit", async () => {
    const { graphJsonPath, makeContext, outputDir } = setup();
    writeGraph(graphJsonPath, makeGraph({ 1: ["a", "b", "c"] }));
    generateMock.mockImplementation(async (communities) => communities.map((community) => makeSummary(community.id, "stable summary")));
    await runCommunitySummariesStep(makeContext());

    writeGraph(graphJsonPath, makeGraph({ 9: ["a", "b", "c"] }));
    generateMock.mockClear();
    const result = await runCommunitySummariesStep(makeContext());

    expect(result.skipped).toBe(true);
    expect(generateMock).not.toHaveBeenCalled();
    expect(readSummaries(outputDir)).toEqual([expect.objectContaining({ id: "9", summary: "stable summary" })]);
  });

  it("regenerates everything when force is enabled", async () => {
    const { graphJsonPath, makeContext } = setup();
    writeGraph(graphJsonPath, makeGraph({ 1: ["a", "b", "c"], 2: ["d", "e", "f"] }));
    generateMock.mockImplementation(async (communities) => communities.map((community) => makeSummary(community.id)));
    await runCommunitySummariesStep(makeContext());

    generateMock.mockClear();
    const result = await runCommunitySummariesStep(makeContext({ force: true }));

    expect(result.processed).toBe(2);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("removes artifacts when disabled", async () => {
    const { config, graphJsonPath, makeContext, outputDir } = setup();
    writeGraph(graphJsonPath, makeGraph({ 1: ["a", "b", "c"] }));
    generateMock.mockImplementation(async (communities) => communities.map((community) => makeSummary(community.id)));
    await runCommunitySummariesStep(makeContext());

    config.build.community_summaries.enabled = false;
    const result = await runCommunitySummariesStep(makeContext());

    expect(result.skipped).toBe(true);
    expect(existsSync(join(outputDir, "community_summaries.json"))).toBe(false);
    expect(existsSync(join(outputDir, ".cache", "community-summary-fingerprints.json"))).toBe(false);
  });


  it("applies max_number filtering before generation", async () => {
    const { config, graphJsonPath, makeContext, outputDir } = setup();
    config.build.community_summaries.max_number = 1;
    writeGraph(graphJsonPath, makeGraph({ 1: ["a", "b", "c", "d"], 2: ["e", "f", "g"] }));
    generateMock.mockImplementation(async (communities) => communities.map((community) => makeSummary(community.id)));

    const result = await runCommunitySummariesStep(makeContext());

    expect(result.processed).toBe(1);
    expect(readSummaries(outputDir)).toHaveLength(1);
    expect(readSummaries(outputDir)[0]?.id).toBe("1");
  });
});

function setup(): {
  config: Config;
  outputDir: string;
  graphJsonPath: string;
  makeContext: (overrides?: Partial<StepContext>) => StepContext;
} {
  const root = join(tmpdir(), `rn-test-community-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(root);

  const outputDir = join(root, "out");
  mkdirSync(outputDir, { recursive: true });

  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
  config.build.community_summaries.enabled = true;
  config.build.node_descriptions.enabled = false;

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
      previousConfig: null,
      ...overrides,
    }),
  };
}

function makeGraph(communities: Record<string, string[]>): GraphData {
  const nodes = Object.entries(communities).flatMap(([communityId, ids]) => ids.map((id) => ({
    id,
    label: id.toUpperCase(),
    type: "function",
    source_file: `${id}.py`,
    repo: "repo",
    community: communityId,
  })));
  return { nodes, edges: [] };
}

function writeGraph(path: string, graph: GraphData): void {
  writeFileSync(path, JSON.stringify(graph, null, 2));
}

function readSummaries(outputDir: string): Array<{ id: string; summary: string }> {
  return JSON.parse(readFileSync(join(outputDir, "community_summaries.json"), "utf-8")) as Array<{ id: string; summary: string }>;
}

function makeSummary(id: string, summary = `summary:${id}`) {
  return {
    id,
    nodeCount: 3,
    summary,
    hub_nodes: ["a"],
    primary_path: "src",
    repos: ["repo"],
  };
}
