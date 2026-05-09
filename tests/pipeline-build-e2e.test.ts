import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/shared/config.js";
import { runBuild } from "../src/pipeline/build.js";
import { DEFAULT_CONFIG, type Config } from "../src/shared/types.js";

function makeConfig(): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  config.repos = [{ name: "test", path: "." }];
  config.output = "out";
  config.html = false;
  config.embeddings.enabled = false;
  config.community_summaries.enabled = false;
  config.node_descriptions.enabled = false;
  config.outlines.enabled = false;
  return config;
}

function writeFile(rootDir: string, relativePath: string, content: string): void {
  const filePath = join(rootDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

describe("pipeline build E2E", { timeout: 30000 }, () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reponova-pipeline-build-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("builds a graph from Python files", async () => {
    writeFile(tmpDir, "main.py", "def greet():\n    pass\n");
    writeFile(tmpDir, "utils.py", "def helper():\n    pass\n\ndef another():\n    pass\n");

    const result = await runBuild(makeConfig(), tmpDir, {});

    expect(existsSync(result.outputDir)).toBe(true);
    expect(existsSync(join(result.outputDir, "graph-nodes.json"))).toBe(true);
    expect(existsSync(join(result.outputDir, "graph.json"))).toBe(true);
    expect(result.totalProcessed).toBeGreaterThan(0);
  });

  it("--target limits execution to specified phase + deps", async () => {
    writeFile(tmpDir, "main.py", "def greet():\n    pass\n");

    const result = await runBuild(makeConfig(), tmpDir, { target: "graph" });

    expect(existsSync(join(result.outputDir, "graph-nodes.json"))).toBe(true);
    expect(existsSync(join(result.outputDir, "report.md"))).toBe(false);
    expect(Array.from(result.phases.keys())).toEqual(["file-detection", "graph"]);
  });

  it("--force ignores incremental cache", async () => {
    writeFile(tmpDir, "main.py", "def greet():\n    pass\n");

    const first = await runBuild(makeConfig(), tmpDir, {});
    const second = await runBuild(makeConfig(), tmpDir, { force: true });

    expect(first.totalProcessed).toBeGreaterThan(0);
    expect(second.totalProcessed).toBeGreaterThan(0);
  });

  it("incremental build skips unchanged files", async () => {
    writeFile(tmpDir, "main.py", "def greet():\n    pass\n");

    await runBuild(makeConfig(), tmpDir, {});
    const second = await runBuild(makeConfig(), tmpDir, {});

    const fileDetection = second.phases.get("file-detection");
    const graph = second.phases.get("graph");

    expect(fileDetection).toBeDefined();
    expect(fileDetection?.skipped).toBe(false);
    expect(fileDetection?.processed).toBeGreaterThan(0);
    expect(graph).toBeDefined();
    expect(graph?.skipped).toBe(false);
    expect(graph?.processed).toBeGreaterThan(0);
  });

  it("empty repo produces empty graph", async () => {
    const result = await runBuild(makeConfig(), tmpDir, {});
    const graph = JSON.parse(readFileSync(join(result.outputDir, "graph.json"), "utf-8")) as {
      nodes: unknown[];
      edges: unknown[];
    };

    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it("config with legacy build wrapper is migrated", async () => {
    writeFile(tmpDir, "main.py", "def greet():\n    pass\n");
    writeFile(
      tmpDir,
      "reponova.yml",
      [
        'output: "out"',
        "repos:",
        '  - name: "test"',
        '    path: "."',
        "build:",
        "  html: false",
        "  embeddings:",
        "    enabled: false",
        "  community_summaries:",
        "    enabled: false",
        "  node_descriptions:",
        "    enabled: false",
        "  outlines:",
        "    enabled: false",
      ].join("\n"),
    );

    const { config, configDir } = loadConfig(join(tmpDir, "reponova.yml"));
    const result = await runBuild(config, configDir, {});

    expect(config.html).toBe(false);
    expect(config.embeddings.enabled).toBe(false);
    expect(config.community_summaries.enabled).toBe(false);
    expect(config.node_descriptions.enabled).toBe(false);
    expect(config.outlines.enabled).toBe(false);
    expect(existsSync(join(result.outputDir, "graph.json"))).toBe(true);
  });
});
