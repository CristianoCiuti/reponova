import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBuild } from "../src/build/orchestrator.js";
import type { Config } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";

const tempDirs: string[] = [];

const mockedSteps = vi.hoisted(() => ({
  runIndexerStep: vi.fn(async (ctx: { outputDir: string; graphJsonPath: string; force: boolean }) => {
    const outputPath = join(ctx.outputDir, "graph_search.db");
    if (!ctx.force && statExists(outputPath) && statSync(outputPath).mtimeMs >= statSync(ctx.graphJsonPath).mtimeMs) {
      return { processed: 0, skipped: true, skipReason: "up to date" };
    }
    writeFileSync(outputPath, "db");
    return { processed: 1, skipped: false };
  }),
  runHtmlStep: vi.fn(async (ctx: { outputDir: string; graphJsonPath: string; force: boolean }) => {
    const htmlPath = join(ctx.outputDir, "graph.html");
    const communitiesPath = join(ctx.outputDir, "graph_communities.html");
    const summariesPath = join(ctx.outputDir, "community_summaries.json");
    const shouldRun = ctx.force
      || !statExists(htmlPath)
      || !statExists(communitiesPath)
      || statSync(ctx.graphJsonPath).mtimeMs > statSync(htmlPath).mtimeMs
      || (statExists(summariesPath) && statSync(summariesPath).mtimeMs > statSync(communitiesPath).mtimeMs);
    if (!shouldRun) {
      return { processed: 0, skipped: true, skipReason: "up to date" };
    }
    writeFileSync(htmlPath, "<html></html>");
    writeFileSync(communitiesPath, "<html></html>");
    return { processed: 2, skipped: false };
  }),
  runReportStep: vi.fn(async (ctx: { outputDir: string; graphJsonPath: string; force: boolean }) => {
    const reportPath = join(ctx.outputDir, "report.md");
    const summariesPath = join(ctx.outputDir, "community_summaries.json");
    const shouldRun = ctx.force
      || !statExists(reportPath)
      || statSync(ctx.graphJsonPath).mtimeMs > statSync(reportPath).mtimeMs
      || (statExists(summariesPath) && statSync(summariesPath).mtimeMs > statSync(reportPath).mtimeMs);
    if (!shouldRun) {
      return { processed: 0, skipped: true, skipReason: "up to date" };
    }
    writeFileSync(reportPath, "# report\n");
    return { processed: 1, skipped: false };
  }),
}));

vi.mock("@lancedb/lancedb", () => ({
  connect: async () => { throw new Error("mock: lancedb unavailable"); },
}));
vi.mock("../src/build/steps/indexer.js", async () => {
  const actual = await vi.importActual<typeof import("../src/build/steps/indexer.js")>("../src/build/steps/indexer.js");
  return { ...actual, runIndexerStep: mockedSteps.runIndexerStep };
});
vi.mock("../src/build/steps/html-step.js", async () => {
  const actual = await vi.importActual<typeof import("../src/build/steps/html-step.js")>("../src/build/steps/html-step.js");
  return { ...actual, runHtmlStep: mockedSteps.runHtmlStep };
});
vi.mock("../src/build/steps/report.js", async () => {
  const actual = await vi.importActual<typeof import("../src/build/steps/report.js")>("../src/build/steps/report.js");
  return { ...actual, runReportStep: mockedSteps.runReportStep };
});

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("build pipeline e2e", () => {
  it("covers first build, no-change skips, file/config changes, mtime propagation, disable cleanup, and interrupted recovery", async () => {
    const { config, configDir, repoDir, outputDir } = setupProject();

    await runBuild(config, configDir, { force: false });
    await delay(75);
    let manifest = readManifest(outputDir);
    expect(manifest.steps.embeddings.status).toBe("completed");
    expect(manifest.steps.community_summaries.status).toBe("completed");
    expect(manifest.steps.node_descriptions.status).toBe("completed");

    await runBuild(config, configDir, { force: false });
    await delay(75);
    manifest = readManifest(outputDir);
    expect(manifest.steps.embeddings.status).toBe("skipped");
    expect(manifest.steps.community_summaries.status).toBe("skipped");
    expect(manifest.steps.node_descriptions.status).toBe("skipped");
    expect(manifest.steps.outlines.status).toBe("skipped");
    // graph.json mtime is stable (semantic content unchanged) → mtime-based steps skip
    expect(manifest.steps.indexer.status).toBe("skipped");
    expect(manifest.steps.html.status).toBe("skipped");
    expect(manifest.steps.report.status).toBe("skipped");

    writeFileSync(join(repoDir, "utils.py"), [
      "def leaf():",
      "    return 2",
      "",
      "def helper():",
      "    return leaf()",
      "",
      "def changed():",
      "    return helper()",
      "",
    ].join("\n"));
    await runBuild(config, configDir, { force: false });
    await delay(75);
    manifest = readManifest(outputDir);
    expect(manifest.steps.embeddings.status).toBe("completed");
    expect(manifest.steps.community_summaries.status).toBe("completed");
    expect(manifest.steps.node_descriptions.status).toBe("completed");

    mutatePreviousBuildConfig(outputDir, (previous) => {
      previous.embeddings.method = "onnx";
    });
    await runBuild(config, configDir, { force: false });
    await delay(75);
    manifest = readManifest(outputDir);
    expect(manifest.steps.embeddings.status).toBe("completed");

    mutatePreviousBuildConfig(outputDir, (previous) => {
      previous.community_summaries.model = "hf:old/model";
    });
    await runBuild(config, configDir, { force: false });
    await delay(75);
    manifest = readManifest(outputDir);
    expect(manifest.steps.community_summaries.status).toBe("completed");

    const htmlBefore = statSync(join(outputDir, "graph_communities.html")).mtimeMs;
    const reportBefore = statSync(join(outputDir, "report.md")).mtimeMs;
    const nextTime = new Date(Date.now() + 2000);
    utimesSync(join(outputDir, "community_summaries.json"), nextTime, nextTime);
    await runBuild(config, configDir, { force: false });
    await delay(75);
    expect(statSync(join(outputDir, "graph_communities.html")).mtimeMs).toBeGreaterThan(htmlBefore);
    expect(statSync(join(outputDir, "report.md")).mtimeMs).toBeGreaterThan(reportBefore);

    config.build.community_summaries.enabled = false;
    await runBuild(config, configDir, { force: false });
    await delay(75);
    manifest = readManifest(outputDir);
    expect(manifest.steps.community_summaries.status).toBe("skipped");
    expect(statExists(join(outputDir, "community_summaries.json"))).toBe(false);

    config.build.community_summaries.enabled = true;
    writeInterruptedManifest(outputDir, "community_summaries");
    await delay(75);
    await runBuild(config, configDir, { force: false });
    manifest = readManifest(outputDir);
    expect(manifest.steps.community_summaries.status).toBe("completed");
  });
});

function setupProject(): { config: Config; configDir: string; repoDir: string; outputDir: string } {
  const root = join(tmpdir(), `rn-test-build-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(root);

  const configDir = join(root, "config");
  const repoDir = join(root, "repo");
  const outputDir = join(root, "out");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  writeFileSync(join(repoDir, "main.py"), [
    "from utils import helper",
    "",
    "def main():",
    "    return helper()",
    "",
  ].join("\n"));
  writeFileSync(join(repoDir, "utils.py"), [
    "def leaf():",
    "    return 1",
    "",
    "def helper():",
    "    return leaf()",
    "",
  ].join("\n"));

  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
  config.output = "../out";
  config.repos = [{ name: "repo", path: "../repo" }];
  config.build.embeddings.enabled = true;
  config.build.embeddings.method = "tfidf";
  config.build.community_summaries.enabled = true;
  config.build.community_summaries.max_number = 0;
  config.build.node_descriptions.enabled = true;
  config.build.node_descriptions.threshold = 0;
  config.outlines.enabled = true;
  config.outlines.patterns = ["**/*.py"];

  return { config, configDir, repoDir, outputDir };
}

function readManifest(outputDir: string): {
  steps: Record<string, { status: string }>;
} {
  return JSON.parse(readFileSync(join(outputDir, ".cache", "build-manifest.json"), "utf-8")) as {
    steps: Record<string, { status: string }>;
  };
}

function mutatePreviousBuildConfig(outputDir: string, mutate: (config: Config["build"] & { outlines?: Config["outlines"] }) => void): void {
  const graphPath = join(outputDir, "graph.json");
  const graph = JSON.parse(readFileSync(graphPath, "utf-8")) as {
    metadata: { build_config: {
      embeddings: { enabled: boolean; method: "tfidf" | "onnx"; model: string; dimensions: number };
      outlines: { enabled: boolean; patterns: string[]; exclude: string[]; exclude_common: boolean };
      community_summaries: { enabled: boolean; max_number: number; model: string | null; context_size: number };
      node_descriptions: { enabled: boolean; threshold: number; model: string | null; context_size: number };
    } };
  };
  mutate(graph.metadata.build_config as never);
  writeFileSync(graphPath, JSON.stringify(graph, null, 2));
}

function writeInterruptedManifest(outputDir: string, stepName: string): void {
  const cacheDir = join(outputDir, ".cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "build-manifest.json"), JSON.stringify({
    version: 1,
    started_at: "2025-01-01T00:00:00.000Z",
    completed_at: null,
    graph_hash: "broken",
    steps: {
      extraction: { status: "completed" },
      indexer: { status: "completed" },
      outlines: { status: "completed" },
      embeddings: { status: "completed" },
      community_summaries: { status: stepName === "community_summaries" ? "running" : "completed" },
      node_descriptions: { status: "completed" },
      html: { status: "completed" },
      report: { status: "completed" },
    },
  }, null, 2));
}

function statExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
