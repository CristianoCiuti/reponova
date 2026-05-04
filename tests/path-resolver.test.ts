/**
 * Tests for src/core/path-resolver.ts — central path resolution module.
 *
 * Covers all public functions in both single-repo and multi-repo modes:
 * - resolveMode()
 * - createPathContext()
 * - prepareWorkspace()
 * - toSourceFile()
 * - matchesPatterns()
 * - isExcluded()
 * - toOutlineRelPath()
 * - extractRepoName()
 * - resolveAbsolutePath()
 * - resolveOutlinePath()
 * - reconstructRepos()
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";
import {
  resolveMode,
  createPathContext,
  prepareWorkspace,
  toSourceFile,
  matchesPatterns,
  isExcluded,
  toOutlineRelPath,
  extractRepoName,
  resolveAbsolutePath,
  resolveOutlinePath,
  reconstructRepos,
  stripRepoPrefix,
  createDualMatcher,
  createPatternMatcher,
} from "../src/core/path-resolver.js";
import type { PathContext, RepoMapping } from "../src/core/path-resolver.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(suffix: string): string {
  const dir = join(tmpdir(), `rn-test-pathres-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir.replace(/\\/g, "/");
}

function makeConfig(repos: Array<{ name: string; path: string }>): Config {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
  cfg.repos = repos;
  return cfg;
}

/** Create a file on disk (so existsSync checks pass). */
function touchFile(dir: string, relPath: string): string {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "");
  return full.replace(/\\/g, "/");
}

let tmpDirs: string[] = [];

function freshTmpDir(suffix: string): string {
  const d = makeTmpDir(suffix);
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  }
  tmpDirs = [];
});

// ══════════════════════════════════════════════════════════════════════════════
// resolveMode
// ══════════════════════════════════════════════════════════════════════════════

describe("resolveMode", () => {
  it("returns 'single' for 1 repo", () => {
    const cfg = makeConfig([{ name: "myapp", path: "." }]);
    expect(resolveMode(cfg)).toBe("single");
  });

  it("returns 'multi' for 2 repos", () => {
    const cfg = makeConfig([
      { name: "api", path: "./api" },
      { name: "core", path: "./core" },
    ]);
    expect(resolveMode(cfg)).toBe("multi");
  });

  it("returns 'multi' for 3+ repos", () => {
    const cfg = makeConfig([
      { name: "a", path: "./a" },
      { name: "b", path: "./b" },
      { name: "c", path: "./c" },
    ]);
    expect(resolveMode(cfg)).toBe("multi");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// createPathContext
// ══════════════════════════════════════════════════════════════════════════════

describe("createPathContext", () => {
  it("creates single-repo context with correct mode and absPath", () => {
    const configDir = freshTmpDir("ctx-single");
    const outputDir = join(configDir, "out").replace(/\\/g, "/");
    const cfg = makeConfig([{ name: "myapp", path: "." }]);

    const ctx = createPathContext(cfg, configDir, outputDir);
    expect(ctx.mode).toBe("single");
    expect(ctx.repos).toHaveLength(1);
    expect(ctx.repos[0]!.name).toBe("myapp");
    expect(ctx.repos[0]!.absPath).toBe(configDir);
    expect(ctx.outputDir).toBe(outputDir);
  });

  it("creates multi-repo context with resolved absPaths", () => {
    const configDir = freshTmpDir("ctx-multi");
    const outputDir = join(configDir, "out").replace(/\\/g, "/");
    const cfg = makeConfig([
      { name: "api", path: "./services/api" },
      { name: "core", path: "./services/core" },
    ]);

    const ctx = createPathContext(cfg, configDir, outputDir);
    expect(ctx.mode).toBe("multi");
    expect(ctx.repos).toHaveLength(2);
    expect(ctx.repos[0]!.name).toBe("api");
    expect(ctx.repos[0]!.absPath).toBe(
      resolve(configDir, "./services/api").replace(/\\/g, "/"),
    );
    expect(ctx.repos[1]!.name).toBe("core");
  });

  it("normalizes backslashes in absPath on Windows", () => {
    const configDir = freshTmpDir("ctx-bs");
    const cfg = makeConfig([{ name: "app", path: "." }]);
    const ctx = createPathContext(cfg, configDir, configDir);
    expect(ctx.repos[0]!.absPath).not.toContain("\\");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// prepareWorkspace
// ══════════════════════════════════════════════════════════════════════════════

describe("prepareWorkspace", () => {
  it("single-repo: returns repo absPath as workspace (no symlinks)", () => {
    const repoDir = freshTmpDir("ws-single");
    const ctx: PathContext = {
      mode: "single",
      repos: [{ name: "myapp", absPath: repoDir }],
      workspace: "",
      outputDir: join(repoDir, "out").replace(/\\/g, "/"),
    };

    const ws = prepareWorkspace(ctx, freshTmpDir("ws-single-tmp"), new Set());
    expect(ws.replace(/\\/g, "/")).toBe(repoDir);
    expect(ctx.workspace.replace(/\\/g, "/")).toBe(repoDir);
  });

  it("multi-repo: creates symlink workspace in tmpDir", () => {
    const apiDir = freshTmpDir("ws-api");
    const coreDir = freshTmpDir("ws-core");
    const tmpDir = freshTmpDir("ws-multi-tmp");

    const ctx: PathContext = {
      mode: "multi",
      repos: [
        { name: "api", absPath: apiDir },
        { name: "core", absPath: coreDir },
      ],
      workspace: "",
      outputDir: join(tmpDir, "out").replace(/\\/g, "/"),
    };

    const ws = prepareWorkspace(ctx, tmpDir, new Set());
    expect(existsSync(ws)).toBe(true);
    expect(existsSync(join(ws, "api"))).toBe(true);
    expect(existsSync(join(ws, "core"))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// toSourceFile
// ══════════════════════════════════════════════════════════════════════════════

describe("toSourceFile", () => {
  it("single-repo: returns repo-relative path WITHOUT prefix", () => {
    const repoDir = freshTmpDir("sf-single");
    const ctx: PathContext = {
      mode: "single",
      repos: [{ name: "myapp", absPath: repoDir }],
      workspace: repoDir,
      outputDir: "",
    };

    const fullPath = join(repoDir, "src", "core.py").replace(/\\/g, "/");
    expect(toSourceFile(ctx, fullPath)).toBe("src/core.py");
  });

  it("single-repo: does NOT include repo name", () => {
    const repoDir = freshTmpDir("sf-noprefix");
    const ctx: PathContext = {
      mode: "single",
      repos: [{ name: "myapp", absPath: repoDir }],
      workspace: repoDir,
      outputDir: "",
    };

    const fullPath = join(repoDir, "tests", "test_main.py").replace(/\\/g, "/");
    const result = toSourceFile(ctx, fullPath);
    expect(result).toBe("tests/test_main.py");
    expect(result).not.toMatch(/^myapp\//);
  });

  it("multi-repo: returns repo-prefixed path", () => {
    const apiDir = freshTmpDir("sf-api");
    const coreDir = freshTmpDir("sf-core");
    const ctx: PathContext = {
      mode: "multi",
      repos: [
        { name: "api", absPath: apiDir },
        { name: "core", absPath: coreDir },
      ],
      workspace: "",
      outputDir: "",
    };

    const fullPath = join(apiDir, "src", "main.py").replace(/\\/g, "/");
    expect(toSourceFile(ctx, fullPath)).toBe("api/src/main.py");

    const coreFile = join(coreDir, "lib", "utils.py").replace(/\\/g, "/");
    expect(toSourceFile(ctx, coreFile)).toBe("core/lib/utils.py");
  });

  it("normalizes backslashes", () => {
    const repoDir = freshTmpDir("sf-bs");
    const ctx: PathContext = {
      mode: "single",
      repos: [{ name: "app", absPath: repoDir }],
      workspace: repoDir,
      outputDir: "",
    };

    const fullPath = join(repoDir, "src", "nested", "file.py").replace(/\\/g, "/");
    const result = toSourceFile(ctx, fullPath);
    expect(result).not.toContain("\\");
    expect(result).toBe("src/nested/file.py");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// matchesPatterns
// ══════════════════════════════════════════════════════════════════════════════

describe("matchesPatterns", () => {
  describe("single-repo", () => {
    let ctx: PathContext;
    let repoDir: string;

    beforeEach(() => {
      repoDir = freshTmpDir("mp-single");
      ctx = {
        mode: "single",
        repos: [{ name: "myapp", absPath: repoDir }],
        workspace: repoDir,
        outputDir: "",
      };
    });

    it("matches repo-relative glob", () => {
      const file = join(repoDir, "src", "core.py").replace(/\\/g, "/");
      expect(matchesPatterns(ctx, file, ["src/**/*.py"])).toBe(true);
    });

    it("does not match non-matching glob", () => {
      const file = join(repoDir, "tests", "test.py").replace(/\\/g, "/");
      expect(matchesPatterns(ctx, file, ["src/**/*.py"])).toBe(false);
    });

    it("matches ** wildcard", () => {
      const file = join(repoDir, "deep", "nested", "file.py").replace(/\\/g, "/");
      expect(matchesPatterns(ctx, file, ["**/*.py"])).toBe(true);
    });

    it("returns true when patterns is empty (include-all)", () => {
      const file = join(repoDir, "any", "file.txt").replace(/\\/g, "/");
      expect(matchesPatterns(ctx, file, [])).toBe(true);
    });
  });

  describe("multi-repo", () => {
    let ctx: PathContext;
    let apiDir: string;
    let coreDir: string;

    beforeEach(() => {
      apiDir = freshTmpDir("mp-api");
      coreDir = freshTmpDir("mp-core");
      ctx = {
        mode: "multi",
        repos: [
          { name: "api", absPath: apiDir },
          { name: "core", absPath: coreDir },
        ],
        workspace: "",
        outputDir: "",
      };
    });

    it("matches repo-relative pattern across repos", () => {
      const apiFile = join(apiDir, "src", "main.py").replace(/\\/g, "/");
      const coreFile = join(coreDir, "src", "lib.py").replace(/\\/g, "/");
      expect(matchesPatterns(ctx, apiFile, ["src/**/*.py"])).toBe(true);
      expect(matchesPatterns(ctx, coreFile, ["src/**/*.py"])).toBe(true);
    });

    it("matches workspace-relative pattern (repo-prefixed)", () => {
      const apiFile = join(apiDir, "src", "main.py").replace(/\\/g, "/");
      expect(matchesPatterns(ctx, apiFile, ["api/src/**/*.py"])).toBe(true);
    });

    it("repo-prefixed pattern does NOT match other repos", () => {
      const coreFile = join(coreDir, "src", "lib.py").replace(/\\/g, "/");
      expect(matchesPatterns(ctx, coreFile, ["api/src/**/*.py"])).toBe(false);
    });

    it("pattern outside src/ does not match", () => {
      const file = join(apiDir, "tests", "test.py").replace(/\\/g, "/");
      expect(matchesPatterns(ctx, file, ["src/**/*.py"])).toBe(false);
    });

    it("returns true when patterns is empty (include-all)", () => {
      const file = join(apiDir, "any.txt").replace(/\\/g, "/");
      expect(matchesPatterns(ctx, file, [])).toBe(true);
    });

    it("file not belonging to any repo returns false", () => {
      const orphan = join(freshTmpDir("mp-orphan"), "stray.py").replace(/\\/g, "/");
      expect(matchesPatterns(ctx, orphan, ["**/*.py"])).toBe(false);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// isExcluded
// ══════════════════════════════════════════════════════════════════════════════

describe("isExcluded", () => {
  describe("single-repo", () => {
    let ctx: PathContext;
    let repoDir: string;

    beforeEach(() => {
      repoDir = freshTmpDir("ex-single");
      ctx = {
        mode: "single",
        repos: [{ name: "myapp", absPath: repoDir }],
        workspace: repoDir,
        outputDir: "",
      };
    });

    it("excludes matching glob", () => {
      const file = join(repoDir, "tests", "test_main.py").replace(/\\/g, "/");
      expect(isExcluded(ctx, file, ["**/tests/**"])).toBe(true);
    });

    it("does not exclude non-matching glob", () => {
      const file = join(repoDir, "src", "core.py").replace(/\\/g, "/");
      expect(isExcluded(ctx, file, ["**/tests/**"])).toBe(false);
    });

    it("returns false when excludeGlobs is empty", () => {
      const file = join(repoDir, "anything.py").replace(/\\/g, "/");
      expect(isExcluded(ctx, file, [])).toBe(false);
    });
  });

  describe("multi-repo", () => {
    let ctx: PathContext;
    let apiDir: string;
    let coreDir: string;

    beforeEach(() => {
      apiDir = freshTmpDir("ex-api");
      coreDir = freshTmpDir("ex-core");
      ctx = {
        mode: "multi",
        repos: [
          { name: "api", absPath: apiDir },
          { name: "core", absPath: coreDir },
        ],
        workspace: "",
        outputDir: "",
      };
    });

    it("excludes via repo-relative pattern", () => {
      const file = join(apiDir, "tests", "test.py").replace(/\\/g, "/");
      expect(isExcluded(ctx, file, ["**/tests/**"])).toBe(true);
    });

    it("excludes via workspace-relative (repo-prefixed) pattern", () => {
      const file = join(apiDir, "venv", "lib.py").replace(/\\/g, "/");
      expect(isExcluded(ctx, file, ["api/venv/**"])).toBe(true);
    });

    it("repo-prefixed exclude does NOT affect other repos", () => {
      const file = join(coreDir, "venv", "lib.py").replace(/\\/g, "/");
      expect(isExcluded(ctx, file, ["api/venv/**"])).toBe(false);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// toOutlineRelPath
// ══════════════════════════════════════════════════════════════════════════════

describe("toOutlineRelPath", () => {
  it("single-repo: returns repo-relative path (no prefix)", () => {
    const repoDir = freshTmpDir("olp-single");
    const ctx: PathContext = {
      mode: "single",
      repos: [{ name: "myapp", absPath: repoDir }],
      workspace: repoDir,
      outputDir: "",
    };

    const file = join(repoDir, "src", "core.py").replace(/\\/g, "/");
    expect(toOutlineRelPath(ctx, "myapp", repoDir, file)).toBe("src/core.py");
  });

  it("multi-repo: returns repo-prefixed path", () => {
    const apiDir = freshTmpDir("olp-api");
    const ctx: PathContext = {
      mode: "multi",
      repos: [{ name: "api", absPath: apiDir }],
      workspace: "",
      outputDir: "",
    };

    const file = join(apiDir, "src", "main.py").replace(/\\/g, "/");
    expect(toOutlineRelPath(ctx, "api", apiDir, file)).toBe("api/src/main.py");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// extractRepoName
// ══════════════════════════════════════════════════════════════════════════════

describe("extractRepoName", () => {
  it("single-repo: returns the repo name from config", () => {
    const ctx: PathContext = {
      mode: "single",
      repos: [{ name: "myapp", absPath: "/tmp/myapp" }],
      workspace: "/tmp/myapp",
      outputDir: "",
    };

    expect(extractRepoName(ctx, "src/core.py")).toBe("myapp");
    expect(extractRepoName(ctx, "any/path/file.ts")).toBe("myapp");
  });

  it("multi-repo: extracts repo name from first path component", () => {
    const ctx: PathContext = {
      mode: "multi",
      repos: [
        { name: "api", absPath: "/tmp/api" },
        { name: "core", absPath: "/tmp/core" },
      ],
      workspace: "",
      outputDir: "",
    };

    expect(extractRepoName(ctx, "api/src/main.py")).toBe("api");
    expect(extractRepoName(ctx, "core/lib/utils.py")).toBe("core");
  });

  it("multi-repo: returns undefined for unknown repo prefix", () => {
    const ctx: PathContext = {
      mode: "multi",
      repos: [{ name: "api", absPath: "/tmp/api" }],
      workspace: "",
      outputDir: "",
    };

    expect(extractRepoName(ctx, "unknown/src/file.py")).toBeUndefined();
  });

  it("single-repo: returns undefined if repos is empty", () => {
    const ctx: PathContext = {
      mode: "single",
      repos: [],
      workspace: "",
      outputDir: "",
    };

    expect(extractRepoName(ctx, "src/file.py")).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// resolveAbsolutePath
// ══════════════════════════════════════════════════════════════════════════════

describe("resolveAbsolutePath", () => {
  describe("single-repo", () => {
    it("resolves existing file to absolute path", () => {
      const repoDir = freshTmpDir("abs-single");
      touchFile(repoDir, "src/core.py");
      const repos: RepoMapping[] = [{ name: "myapp", absPath: repoDir }];

      const result = resolveAbsolutePath(repos, "src/core.py", "single");
      expect(result).not.toBeNull();
      expect(result!.replace(/\\/g, "/")).toContain("src/core.py");
    });

    it("returns null for non-existent file", () => {
      const repoDir = freshTmpDir("abs-single-miss");
      const repos: RepoMapping[] = [{ name: "myapp", absPath: repoDir }];

      expect(resolveAbsolutePath(repos, "nonexistent.py", "single")).toBeNull();
    });

    it("returns null when repos is empty", () => {
      expect(resolveAbsolutePath([], "src/core.py", "single")).toBeNull();
    });
  });

  describe("multi-repo", () => {
    it("resolves file with repo prefix", () => {
      const apiDir = freshTmpDir("abs-api");
      touchFile(apiDir, "src/main.py");
      const repos: RepoMapping[] = [{ name: "api", absPath: apiDir }];

      const result = resolveAbsolutePath(repos, "api/src/main.py", "multi");
      expect(result).not.toBeNull();
      expect(result!.replace(/\\/g, "/")).toContain("src/main.py");
    });

    it("returns null for unknown repo prefix", () => {
      const repos: RepoMapping[] = [{ name: "api", absPath: "/tmp/api" }];
      expect(resolveAbsolutePath(repos, "unknown/file.py", "multi")).toBeNull();
    });

    it("returns null when source_file has no slash", () => {
      const repos: RepoMapping[] = [{ name: "api", absPath: "/tmp/api" }];
      expect(resolveAbsolutePath(repos, "noslash", "multi")).toBeNull();
    });

    it("returns null for non-existent file in valid repo", () => {
      const apiDir = freshTmpDir("abs-api-miss");
      const repos: RepoMapping[] = [{ name: "api", absPath: apiDir }];
      expect(resolveAbsolutePath(repos, "api/missing.py", "multi")).toBeNull();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// resolveOutlinePath
// ══════════════════════════════════════════════════════════════════════════════

describe("resolveOutlinePath", () => {
  it("constructs correct path for single-repo source_file", () => {
    const graphDir = "/project/out";
    const result = resolveOutlinePath(graphDir, "src/core.py");
    expect(result.replace(/\\/g, "/")).toBe(
      "/project/out/outlines/src/core.py.outline.json",
    );
  });

  it("constructs correct path for multi-repo source_file", () => {
    const graphDir = "/project/out";
    const result = resolveOutlinePath(graphDir, "api/src/main.py");
    expect(result.replace(/\\/g, "/")).toBe(
      "/project/out/outlines/api/src/main.py.outline.json",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// reconstructRepos
// ══════════════════════════════════════════════════════════════════════════════

describe("reconstructRepos", () => {
  it("reconstructs RepoMapping[] from metadata", () => {
    const graphDir = freshTmpDir("rr-graph");
    const configDir = freshTmpDir("rr-config");
    // graphDir -> configDir relative
    const configDirRel = resolve(graphDir, "..").replace(/\\/g, "/") === resolve(configDir, "..").replace(/\\/g, "/")
      ? "../" + configDir.split("/").pop()!
      : configDir;

    // Use a simpler approach: just compute the relative
    const relConfigDir = join("..", configDir.split("/").pop()!);

    const repos = reconstructRepos(
      graphDir,
      relConfigDir,
      [
        { name: "api", path: "./services/api" },
        { name: "core", path: "./services/core" },
      ],
    );

    expect(repos).not.toBeNull();
    expect(repos).toHaveLength(2);
    expect(repos![0]!.name).toBe("api");
    expect(repos![0]!.absPath).not.toContain("\\");
    expect(repos![1]!.name).toBe("core");
  });

  it("returns null when config_dir is missing", () => {
    expect(reconstructRepos("/graph", undefined, [{ name: "a", path: "." }])).toBeNull();
  });

  it("returns null when repos is missing", () => {
    expect(reconstructRepos("/graph", "..", undefined)).toBeNull();
  });

  it("returns null when both are missing", () => {
    expect(reconstructRepos("/graph", undefined, undefined)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Integration: end-to-end path flow
// ══════════════════════════════════════════════════════════════════════════════

describe("integration: full path flow", () => {
  it("single-repo: config → context → sourceFile → outline → resolve", () => {
    const repoDir = freshTmpDir("int-single");
    const outputDir = join(repoDir, "out").replace(/\\/g, "/");
    const filePath = touchFile(repoDir, "src/core.py");

    // 1. Create config + context
    const cfg = makeConfig([{ name: "myapp", path: "." }]);
    const ctx = createPathContext(cfg, repoDir, outputDir);
    expect(ctx.mode).toBe("single");

    // 2. Prepare workspace
    const ws = prepareWorkspace(ctx, freshTmpDir("int-single-tmp"), new Set());
    expect(ws.replace(/\\/g, "/")).toBe(repoDir);

    // 3. toSourceFile — no prefix
    const sf = toSourceFile(ctx, filePath);
    expect(sf).toBe("src/core.py");

    // 4. matchesPatterns
    expect(matchesPatterns(ctx, filePath, ["src/**/*.py"])).toBe(true);
    expect(matchesPatterns(ctx, filePath, ["tests/**/*.py"])).toBe(false);

    // 5. extractRepoName
    expect(extractRepoName(ctx, sf)).toBe("myapp");

    // 6. toOutlineRelPath — no prefix
    const olp = toOutlineRelPath(ctx, "myapp", repoDir, filePath);
    expect(olp).toBe("src/core.py");

    // 7. resolveOutlinePath
    const op = resolveOutlinePath(outputDir, sf);
    expect(op.replace(/\\/g, "/")).toBe(`${outputDir}/outlines/src/core.py.outline.json`);

    // 8. resolveAbsolutePath
    const abs = resolveAbsolutePath(ctx.repos, sf, "single");
    expect(abs).not.toBeNull();
    expect(abs!.replace(/\\/g, "/")).toBe(filePath);
  });

  it("multi-repo: config → context → sourceFile → outline → resolve", () => {
    const rootDir = freshTmpDir("int-multi");
    const apiDir = join(rootDir, "services", "api").replace(/\\/g, "/");
    const coreDir = join(rootDir, "services", "core").replace(/\\/g, "/");
    mkdirSync(apiDir, { recursive: true });
    mkdirSync(coreDir, { recursive: true });
    const outputDir = join(rootDir, "out").replace(/\\/g, "/");

    const apiFile = touchFile(apiDir, "src/main.py");
    const coreFile = touchFile(coreDir, "src/lib.py");

    // 1. Create config + context
    const cfg = makeConfig([
      { name: "api", path: "./services/api" },
      { name: "core", path: "./services/core" },
    ]);
    const ctx = createPathContext(cfg, rootDir, outputDir);
    expect(ctx.mode).toBe("multi");

    // 2. toSourceFile — with prefix
    const sfApi = toSourceFile(ctx, apiFile);
    expect(sfApi).toBe("api/src/main.py");
    const sfCore = toSourceFile(ctx, coreFile);
    expect(sfCore).toBe("core/src/lib.py");

    // 3. matchesPatterns — repo-relative matches both
    expect(matchesPatterns(ctx, apiFile, ["src/**/*.py"])).toBe(true);
    expect(matchesPatterns(ctx, coreFile, ["src/**/*.py"])).toBe(true);

    // 4. matchesPatterns — workspace-relative matches only target repo
    expect(matchesPatterns(ctx, apiFile, ["api/src/**/*.py"])).toBe(true);
    expect(matchesPatterns(ctx, coreFile, ["api/src/**/*.py"])).toBe(false);

    // 5. extractRepoName
    expect(extractRepoName(ctx, sfApi)).toBe("api");
    expect(extractRepoName(ctx, sfCore)).toBe("core");

    // 6. toOutlineRelPath — with prefix
    const olpApi = toOutlineRelPath(ctx, "api", apiDir, apiFile);
    expect(olpApi).toBe("api/src/main.py");
    const olpCore = toOutlineRelPath(ctx, "core", coreDir, coreFile);
    expect(olpCore).toBe("core/src/lib.py");

    // 7. resolveOutlinePath
    const opApi = resolveOutlinePath(outputDir, sfApi);
    expect(opApi.replace(/\\/g, "/")).toBe(`${outputDir}/outlines/api/src/main.py.outline.json`);

    // 8. resolveAbsolutePath
    const absApi = resolveAbsolutePath(ctx.repos, sfApi, "multi");
    expect(absApi).not.toBeNull();
    expect(absApi!.replace(/\\/g, "/")).toBe(apiFile);

    const absCore = resolveAbsolutePath(ctx.repos, sfCore, "multi");
    expect(absCore).not.toBeNull();
    expect(absCore!.replace(/\\/g, "/")).toBe(coreFile);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// stripRepoPrefix
// ══════════════════════════════════════════════════════════════════════════════

describe("stripRepoPrefix", () => {
  const repoNames = new Set(["api", "core"]);

  it("strips known repo prefix", () => {
    expect(stripRepoPrefix("api/src/main.py", repoNames)).toBe("src/main.py");
    expect(stripRepoPrefix("core/lib/utils.py", repoNames)).toBe("lib/utils.py");
  });

  it("returns null for unknown repo prefix", () => {
    expect(stripRepoPrefix("unknown/src/main.py", repoNames)).toBeNull();
  });

  it("returns null when no slash present", () => {
    expect(stripRepoPrefix("main.py", repoNames)).toBeNull();
  });

  it("handles deeply nested paths", () => {
    expect(stripRepoPrefix("api/a/b/c/d.py", repoNames)).toBe("a/b/c/d.py");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// createDualMatcher
// ══════════════════════════════════════════════════════════════════════════════

describe("createDualMatcher", () => {
  it("returns false-returning function for empty patterns", () => {
    const matcher = createDualMatcher([], undefined);
    expect(matcher("anything.py")).toBe(false);
  });

  it("matches workspace-relative path (no repoNames)", () => {
    const matcher = createDualMatcher(["src/**/*.py"]);
    expect(matcher("src/main.py")).toBe(true);
    expect(matcher("tests/test.py")).toBe(false);
  });

  it("matches repo-relative pattern in multi-repo", () => {
    const repoNames = new Set(["api", "core"]);
    const matcher = createDualMatcher(["src/**/*.py"], repoNames);
    // workspace-relative: "api/src/main.py" doesn't match "src/**/*.py" directly
    // but repo-relative "src/main.py" does match
    expect(matcher("api/src/main.py")).toBe(true);
    expect(matcher("core/src/lib.py")).toBe(true);
  });

  it("matches workspace-relative (repo-prefixed) pattern", () => {
    const repoNames = new Set(["api", "core"]);
    const matcher = createDualMatcher(["api/src/**/*.py"], repoNames);
    expect(matcher("api/src/main.py")).toBe(true);
    expect(matcher("core/src/lib.py")).toBe(false);
  });

  it("repo-prefixed exclude only affects target repo", () => {
    const repoNames = new Set(["api", "core"]);
    const matcher = createDualMatcher(["api/venv/**"], repoNames);
    expect(matcher("api/venv/lib.py")).toBe(true);
    expect(matcher("core/venv/lib.py")).toBe(false);
  });

  it("falls back when repoNames is empty set", () => {
    const matcher = createDualMatcher(["src/**/*.py"], new Set());
    expect(matcher("src/main.py")).toBe(true);
    expect(matcher("api/src/main.py")).toBe(false); // no dual-match
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// createPatternMatcher (bidirectional)
// ══════════════════════════════════════════════════════════════════════════════

describe("createPatternMatcher", () => {
  it("returns false-returning function for empty patterns", () => {
    const matcher = createPatternMatcher([]);
    expect(matcher("anything.py")).toBe(false);
    expect(matcher("anything.py", "api")).toBe(false);
  });

  it("matches direct path (no repoNames)", () => {
    const matcher = createPatternMatcher(["src/**/*.py"]);
    expect(matcher("src/main.py")).toBe(true);
    expect(matcher("tests/test.py")).toBe(false);
  });

  // Direction 1: strip prefix (workspace walk — input has repo prefix)
  it("strips repo prefix to match repo-relative pattern (workspace walk)", () => {
    const repoNames = new Set(["api", "core"]);
    const matcher = createPatternMatcher(["src/**/*.py"], repoNames);
    // "api/src/main.py" → strip "api/" → "src/main.py" matches "src/**/*.py"
    expect(matcher("api/src/main.py")).toBe(true);
    expect(matcher("core/src/lib.py")).toBe(true);
  });

  // Direction 2: add prefix (per-repo walk — input is repo-relative)
  it("adds repo prefix to match workspace-relative pattern (per-repo walk)", () => {
    const repoNames = new Set(["api", "core"]);
    const matcher = createPatternMatcher(["api/src/**/*.py"], repoNames);
    // "src/main.py" + repoName="api" → "api/src/main.py" matches "api/src/**/*.py"
    expect(matcher("src/main.py", "api")).toBe(true);
    // "src/lib.py" + repoName="core" → "core/src/lib.py" does NOT match "api/src/**/*.py"
    expect(matcher("src/lib.py", "core")).toBe(false);
  });

  it("workspace-relative pattern matches directly when path already has prefix", () => {
    const repoNames = new Set(["api", "core"]);
    const matcher = createPatternMatcher(["api/src/**/*.py"], repoNames);
    expect(matcher("api/src/main.py")).toBe(true);
    expect(matcher("core/src/lib.py")).toBe(false);
  });

  it("repo-prefixed exclude only affects target repo", () => {
    const repoNames = new Set(["api", "core"]);
    const matcher = createPatternMatcher(["api/venv/**"], repoNames);
    expect(matcher("api/venv/lib.py")).toBe(true);
    expect(matcher("core/venv/lib.py")).toBe(false);
    // Per-repo walk: "venv/lib.py" + repoName="api" → "api/venv/lib.py" matches
    expect(matcher("venv/lib.py", "api")).toBe(true);
    // Per-repo walk: "venv/lib.py" + repoName="core" → "core/venv/lib.py" no match
    expect(matcher("venv/lib.py", "core")).toBe(false);
  });

  it("falls back when repoNames is empty set", () => {
    const matcher = createPatternMatcher(["src/**/*.py"], new Set());
    expect(matcher("src/main.py")).toBe(true);
    expect(matcher("api/src/main.py")).toBe(false); // no dual-match
  });

  it("wildcard pattern matches both directions", () => {
    const repoNames = new Set(["api", "core"]);
    const matcher = createPatternMatcher(["**/*.py"], repoNames);
    expect(matcher("src/main.py")).toBe(true);
    expect(matcher("api/src/main.py")).toBe(true);
    expect(matcher("main.py", "api")).toBe(true);
  });

  it("without repoName arg, does not try prefix addition", () => {
    const repoNames = new Set(["api"]);
    // Pattern requires "api/" prefix, but path doesn't have it and no repoName given
    const matcher = createPatternMatcher(["api/src/**/*.py"], repoNames);
    expect(matcher("src/main.py")).toBe(false); // no prefix to strip, no repoName to add
  });

  it("handles multiple patterns", () => {
    const repoNames = new Set(["api", "core"]);
    const matcher = createPatternMatcher(["src/**/*.py", "lib/**/*.ts"], repoNames);
    expect(matcher("api/src/main.py")).toBe(true);
    expect(matcher("core/lib/utils.ts")).toBe(true);
    expect(matcher("src/main.py", "api")).toBe(true);
    expect(matcher("lib/utils.ts", "core")).toBe(true);
    expect(matcher("tests/test.py")).toBe(false);
  });
});
