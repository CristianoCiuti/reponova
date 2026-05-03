import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { cleanStaleArtifacts } from "../src/build/artifact-cleanup.js";
import type { Config, BuildConfigFingerprint } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";
import type { ConfigDiff } from "../src/build/config-diff.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("FIX-015: cleanStaleArtifacts", () => {
  it("does nothing on first build", () => {
    const outputDir = makeTempOutputDir();
    createDir(outputDir, "vectors");

    cleanStaleArtifacts(outputDir, makeDiff({ hasChanges: true, isFirstBuild: true }), makeConfig());

    expect(existsSync(join(outputDir, "vectors"))).toBe(true);
  });

  it("does nothing when there are no config changes", () => {
    const outputDir = makeTempOutputDir();
    createDir(outputDir, "vectors");

    cleanStaleArtifacts(outputDir, makeDiff({ hasChanges: false }), makeConfig());

    expect(existsSync(join(outputDir, "vectors"))).toBe(true);
  });

  it("removes vectors when embeddings method changes", () => {
    const outputDir = makeTempOutputDir();
    createDir(outputDir, "vectors");
    const config = makeConfig();
    config.build.embeddings.method = "onnx";

    cleanStaleArtifacts(outputDir, makeDiff({ embeddingsChanged: true }), config);

    expect(existsSync(join(outputDir, "vectors"))).toBe(false);
  });

  it("removes vectors when embeddings model changes", () => {
    const outputDir = makeTempOutputDir();
    createDir(outputDir, "vectors");
    const config = makeConfig();
    config.build.embeddings.method = "onnx";
    config.build.embeddings.model = "all-MiniLM-L12-v2";

    cleanStaleArtifacts(
      outputDir,
      makeDiff({
        embeddingsChanged: true,
        previous: {
          ...makePreviousFingerprint(),
          embeddings: { enabled: true, method: "onnx", model: "all-MiniLM-L6-v2", dimensions: 384 },
        },
      }),
      config,
    );

    expect(existsSync(join(outputDir, "vectors"))).toBe(false);
  });

  it("removes vectors when embeddings dimensions change", () => {
    const outputDir = makeTempOutputDir();
    createDir(outputDir, "vectors");
    const config = makeConfig();
    config.build.embeddings.method = "onnx";
    config.build.embeddings.dimensions = 768;

    cleanStaleArtifacts(
      outputDir,
      makeDiff({
        embeddingsChanged: true,
        previous: {
          ...makePreviousFingerprint(),
          embeddings: { enabled: true, method: "onnx", model: "all-MiniLM-L6-v2", dimensions: 384 },
        },
      }),
      config,
    );

    expect(existsSync(join(outputDir, "vectors"))).toBe(false);
  });

  it("removes vectors and tfidf cache when embeddings are disabled", () => {
    const outputDir = makeTempOutputDir();
    createDir(outputDir, "vectors");
    createFile(outputDir, "tfidf_idf.json");
    const config = makeConfig();
    config.build.embeddings.enabled = false;

    cleanStaleArtifacts(outputDir, makeDiff({ embeddingsChanged: true }), config);

    expect(existsSync(join(outputDir, "vectors"))).toBe(false);
    expect(existsSync(join(outputDir, "tfidf_idf.json"))).toBe(false);
  });

  it("removes tfidf cache when switching from tfidf to onnx", () => {
    const outputDir = makeTempOutputDir();
    createFile(outputDir, "tfidf_idf.json");
    const config = makeConfig();
    config.build.embeddings.method = "onnx";

    cleanStaleArtifacts(outputDir, makeDiff({ embeddingsChanged: true }), config);

    expect(existsSync(join(outputDir, "tfidf_idf.json"))).toBe(false);
  });

  it("keeps tfidf cache when remaining on tfidf", () => {
    const outputDir = makeTempOutputDir();
    createFile(outputDir, "tfidf_idf.json");
    const config = makeConfig();

    cleanStaleArtifacts(outputDir, makeDiff({ embeddingsChanged: true }), config);

    expect(existsSync(join(outputDir, "tfidf_idf.json"))).toBe(true);
  });

  it("removes outlines when outlines are disabled", () => {
    const outputDir = makeTempOutputDir();
    createDir(outputDir, "outlines");
    const config = makeConfig();
    config.outlines.enabled = false;

    cleanStaleArtifacts(outputDir, makeDiff({ outlinesChanged: true }), config);

    expect(existsSync(join(outputDir, "outlines"))).toBe(false);
  });

  it("removes community summaries when disabled", () => {
    const outputDir = makeTempOutputDir();
    createFile(outputDir, "community_summaries.json");
    const config = makeConfig();
    config.build.community_summaries.enabled = false;

    cleanStaleArtifacts(outputDir, makeDiff({ communitySummariesChanged: true }), config);

    expect(existsSync(join(outputDir, "community_summaries.json"))).toBe(false);
  });

  it("removes node descriptions when disabled", () => {
    const outputDir = makeTempOutputDir();
    createFile(outputDir, "node_descriptions.json");
    const config = makeConfig();
    config.build.node_descriptions.enabled = false;

    cleanStaleArtifacts(outputDir, makeDiff({ nodeDescriptionsChanged: true }), config);

    expect(existsSync(join(outputDir, "node_descriptions.json"))).toBe(false);
  });

  it("does not remove unrelated artifacts for unrelated config changes", () => {
    const outputDir = makeTempOutputDir();
    createDir(outputDir, "vectors");
    createDir(outputDir, "outlines");
    createFile(outputDir, "community_summaries.json");
    const config = makeConfig();
    config.build.node_descriptions.enabled = false;

    cleanStaleArtifacts(outputDir, makeDiff({ nodeDescriptionsChanged: true }), config);

    expect(existsSync(join(outputDir, "vectors"))).toBe(true);
    expect(existsSync(join(outputDir, "outlines"))).toBe(true);
    expect(existsSync(join(outputDir, "community_summaries.json"))).toBe(true);
  });
});

function makeTempOutputDir(): string {
  const dir = join(tmpdir(), `rn-test-fix015-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function makeConfig(): Config {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
}

function makePreviousFingerprint(): BuildConfigFingerprint {
  return {
    embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
    outlines: { enabled: true, patterns: ["src/**/*.ts", "src/**/*.py", "src/**/*.js"], exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**"], exclude_common: true },
    community_summaries: { enabled: true, max_number: 0, model: null, context_size: 512 },
    node_descriptions: { enabled: true, threshold: 0.8, model: null, context_size: 512 },
  };
}

function makeDiff(overrides: Partial<ConfigDiff>): ConfigDiff {
  const diff: ConfigDiff = {
    hasChanges: true,
    isFirstBuild: false,
    embeddingsChanged: false,
    outlinesChanged: false,
    communitySummariesChanged: false,
    nodeDescriptionsChanged: false,
    previous: makePreviousFingerprint(),
  };
  return { ...diff, ...overrides };
}

function createDir(outputDir: string, relativePath: string): void {
  mkdirSync(join(outputDir, relativePath), { recursive: true });
  writeFileSync(join(outputDir, relativePath, ".keep"), "artifact");
}

function createFile(outputDir: string, relativePath: string): void {
  const fullPath = join(outputDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, "artifact");
}
