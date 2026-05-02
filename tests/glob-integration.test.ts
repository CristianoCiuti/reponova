import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectFiles, detectDocFiles, detectDiagramFiles } from "../src/extract/index.js";
import { buildSkipDirs, COMMON_SKIP_DIRS } from "../src/shared/glob.js";
import { diffFiles, type BuildCache } from "../src/build/incremental.js";
import { loadPreviousBuildConfig } from "../src/build/config-diff.js";
import type { Config, BuildConfigFingerprint } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";

function normalizePaths(paths: string[]): string[] {
  return paths.map((path) => path.replace(/\\/g, "/")).sort();
}

function makeConfig(): Config {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
}

function makeBuildConfigFingerprint(overrides?: Partial<BuildConfigFingerprint>): BuildConfigFingerprint {
  return {
    embeddings: {
      enabled: true,
      method: "tfidf",
      model: "all-MiniLM-L6-v2",
      dimensions: 384,
      ...overrides?.embeddings,
    },
    outlines: {
      enabled: true,
      paths: ["src/**/*.ts", "src/**/*.py", "src/**/*.js"],
      exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
      exclude_common: true,
      ...overrides?.outlines,
    },
    community_summaries: {
      enabled: true,
      max_number: 0,
      model: null,
      context_size: 512,
      ...overrides?.community_summaries,
    },
    node_descriptions: {
      enabled: true,
      threshold: 0.8,
      model: null,
      context_size: 512,
      ...overrides?.node_descriptions,
    },
  };
}

describe("FIX-017 glob integration", () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = join(tmpdir(), `reponova-fix017-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    mkdirSync(join(testRoot, "src"), { recursive: true });
    mkdirSync(join(testRoot, "venv", "lib", "site-packages"), { recursive: true });
    mkdirSync(join(testRoot, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(testRoot, ".git"), { recursive: true });
    mkdirSync(join(testRoot, "docs"), { recursive: true });
    mkdirSync(join(testRoot, "dist"), { recursive: true });
    mkdirSync(join(testRoot, "diagrams"), { recursive: true });

    writeFileSync(join(testRoot, "src", "main.py"), "print('hello')\n");
    writeFileSync(join(testRoot, "src", "utils.py"), "def util(): pass\n");
    writeFileSync(join(testRoot, "venv", "lib", "site-packages", "pkg.py"), "x = 1\n");
    writeFileSync(join(testRoot, "node_modules", "pkg", "index.js"), "module.exports = {}\n");
    writeFileSync(join(testRoot, ".git", "config"), "[core]\n");
    writeFileSync(join(testRoot, "docs", "README.md"), "# Docs\n");
    writeFileSync(join(testRoot, "docs", "CHANGELOG.md"), "# Changelog\n");
    writeFileSync(join(testRoot, "dist", "bundle.js"), "// built\n");
    writeFileSync(join(testRoot, "diagrams", "system.puml"), "@startuml\n@enduml\n");
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("exclude_common=true skips common directories for source detection", () => {
    const files = normalizePaths(detectFiles(testRoot, [], [], buildSkipDirs(true)));

    expect(files).toEqual(["src/main.py", "src/utils.py"]);
    expect(files.some((file) => file.startsWith("venv/"))).toBe(false);
    expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
    expect(files.some((file) => file.startsWith(".git/"))).toBe(false);
    expect(files.some((file) => file.startsWith("dist/"))).toBe(false);
  });

  it("exclude_common=false does not skip common directories", () => {
    const files = normalizePaths(detectFiles(testRoot, [], [], buildSkipDirs(false)));

    expect(files).toContain("src/main.py");
    expect(files).toContain("src/utils.py");
    expect(files).toContain("venv/lib/site-packages/pkg.py");
  });

  it("explicit exclude patterns still work when exclude_common=false", () => {
    const files = normalizePaths(detectFiles(testRoot, [], ["**/venv/**"], buildSkipDirs(false)));

    expect(files).toContain("src/main.py");
    expect(files).toContain("src/utils.py");
    expect(files).not.toContain("venv/lib/site-packages/pkg.py");
  });

  it("pattern-based detection uses centralized picomatch semantics", () => {
    const files = normalizePaths(detectFiles(testRoot, ["src/**/*.py"], [], buildSkipDirs(true)));

    expect(files).toEqual(["src/main.py", "src/utils.py"]);
  });

  it("doc detection respects skipDirs", () => {
    writeFileSync(join(testRoot, "venv", "lib", "readme.md"), "# Hidden docs\n");

    const docs = normalizePaths(detectDocFiles(testRoot, {
      enabled: true,
      patterns: ["**/*.md"],
      exclude: [],
      max_file_size_kb: 500,
    }, buildSkipDirs(true)));

    expect(docs).toContain("docs/README.md");
    expect(docs).toContain("docs/CHANGELOG.md");
    expect(docs).not.toContain("venv/lib/readme.md");
  });

  it("doc exclude patterns match CHANGELOG.md at root and nested levels", () => {
    const docs = normalizePaths(detectDocFiles(testRoot, {
      enabled: true,
      patterns: ["**/*.md"],
      exclude: ["**/CHANGELOG.md"],
      max_file_size_kb: 500,
    }, buildSkipDirs(true)));

    expect(docs).toContain("docs/README.md");
    expect(docs).not.toContain("docs/CHANGELOG.md");
  });

  it("diagram detection respects common skip directories", () => {
    writeFileSync(join(testRoot, "venv", "lib", "hidden.puml"), "@startuml\n@enduml\n");

    const diagrams = normalizePaths(detectDiagramFiles(testRoot, {
      enabled: true,
      patterns: ["**/*.puml"],
      exclude: [],
      parse_puml: true,
      parse_svg_text: true,
    }, buildSkipDirs(true)));

    expect(diagrams).toEqual(["diagrams/system.puml"]);
  });

  it("buildSkipDirs(true) includes every common skip directory", () => {
    const skipDirs = buildSkipDirs(true);

    expect(skipDirs.size).toBe(COMMON_SKIP_DIRS.length);
    for (const dir of COMMON_SKIP_DIRS) {
      expect(skipDirs.has(dir)).toBe(true);
    }
  });

  it("diffFiles reports removed files from previous cache", () => {
    const cache: BuildCache = {
      hashes: new Map([
        ["a.py", "hash-a"],
        ["b.py", "hash-b"],
        ["c.py", "hash-c"],
      ]),
      cacheDir: join(testRoot, "cache"),
      baseDir: join(testRoot, "base"),
    };

    const currentHashes = new Map([
      ["a.py", "hash-a-new"],
      ["b.py", "hash-b-new"],
    ]);

    const diff = diffFiles(currentHashes, cache);

    expect(diff.removedFiles).toEqual(["c.py"]);
  });

  it("diffFiles reports no removed files when all cached paths still exist", () => {
    const cache: BuildCache = {
      hashes: new Map([
        ["a.py", "hash-a"],
        ["b.py", "hash-b"],
      ]),
      cacheDir: join(testRoot, "cache"),
      baseDir: join(testRoot, "base"),
    };
    const currentHashes = new Map([
      ["a.py", "hash-a"],
      ["b.py", "hash-b"],
    ]);

    const diff = diffFiles(currentHashes, cache);

    expect(diff.removedFiles).toEqual([]);
  });

  it("diffFiles reports no removed files on first build", () => {
    const currentHashes = new Map([
      ["a.py", "hash-a"],
      ["b.py", "hash-b"],
    ]);

    const diff = diffFiles(currentHashes, null);

    expect(diff.removedFiles).toEqual([]);
  });

  it("config diff detects exclude_common changes", () => {
    const graphPath = join(testRoot, "graph.json");
    const config = makeConfig();
    config.build.exclude_common = false;

    writeFileSync(graphPath, JSON.stringify({
      nodes: [],
      edges: [],
      metadata: {
        build_config: makeBuildConfigFingerprint({
          outlines: { exclude_common: true },
        }),
      },
    }));

    const diff = loadPreviousBuildConfig(graphPath, config);

    expect(diff.outlinesChanged).toBe(true);
    expect(diff.hasChanges).toBe(true);
  });

  it("config diff detects context_size changes", () => {
    const graphPath = join(testRoot, "graph.json");
    const config = makeConfig();
    config.build.community_summaries.context_size = 1024;

    writeFileSync(graphPath, JSON.stringify({
      nodes: [],
      edges: [],
      metadata: {
        build_config: makeBuildConfigFingerprint({
          community_summaries: { context_size: 512 },
        }),
      },
    }));

    const diff = loadPreviousBuildConfig(graphPath, config);

    expect(diff.communitySummariesChanged).toBe(true);
    expect(diff.hasChanges).toBe(true);
  });
});
