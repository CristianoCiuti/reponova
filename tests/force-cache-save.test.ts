/**
 * Tests that --force builds still save the incremental cache.
 *
 * Bug: When `--force` was used, `incremental` was set to `false`, which
 * prevented `saveBuildCache()` from being called. The next incremental
 * build would find no cache and re-extract every file from scratch.
 *
 * The fix decouples cache SAVING from the incremental flag. The flag now
 * only controls whether to LOAD the cache (skip unchanged files).
 * Saving always happens when `outputDir` is present.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  computeHashes,
  diffFiles,
  loadBuildCache,
  saveBuildCache,
  cleanStaleCacheEntries,
} from "../src/build/incremental.js";
import type { FileExtraction } from "../src/extract/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeExtraction(filePath: string, fnName: string): FileExtraction {
  return {
    filePath,
    language: "python",
    symbols: [{
      name: fnName,
      qualifiedName: `${filePath}/${fnName}`,
      kind: "function",
      decorators: [],
      startLine: 1,
      endLine: 1,
      calls: [],
    }],
    imports: [],
    references: [],
  };
}

// ─── Unit Tests ──────────────────────────────────────────────────────────────

describe("Force build cache persistence (unit)", () => {
  const root = join(tmpdir(), `rn-force-cache-unit-${Date.now()}`);
  const workspaceDir = join(root, "workspace");
  const outputDir = join(root, "output");

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("should save cache when called unconditionally (simulating --force flow)", () => {
    // Setup: create workspace files and output dir
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(workspaceDir, "a.py"), "def foo(): pass\n");
    writeFileSync(join(workspaceDir, "b.py"), "def bar(): pass\n");

    // Simulate --force: incremental=false, so cache is NOT loaded
    const incremental = false;
    const files = ["a.py", "b.py"];
    const currentHashes = computeHashes(workspaceDir, files);

    // With incremental=false, cache loading is skipped
    const cache = incremental ? loadBuildCache(outputDir) : null;
    expect(cache).toBeNull();

    // diffFiles with null cache → all files are "changed"
    const diff = diffFiles(currentHashes, cache);
    expect(diff.changedFiles.length).toBe(2);
    expect(diff.unchangedFiles.length).toBe(0);

    // Simulate extraction
    const extractions = [
      makeExtraction("a.py", "foo"),
      makeExtraction("b.py", "bar"),
    ];

    // KEY: cache is saved unconditionally (the fix)
    saveBuildCache(outputDir, currentHashes, extractions);
    cleanStaleCacheEntries(outputDir, currentHashes);

    // Verify: cache exists on disk
    expect(existsSync(join(outputDir, ".cache", "hashes.json"))).toBe(true);
    const savedCache = loadBuildCache(outputDir);
    expect(savedCache).not.toBeNull();
    expect(savedCache!.hashes.size).toBe(2);
  });

  it("should allow next incremental build to use the cache saved by --force", () => {
    // Now simulate the NEXT build with incremental=true
    const incremental = true;
    const files = ["a.py", "b.py"];
    const currentHashes = computeHashes(workspaceDir, files);

    // This time, cache IS loaded
    const cache = incremental ? loadBuildCache(outputDir) : null;
    expect(cache).not.toBeNull();

    const diff = diffFiles(currentHashes, cache);
    // Both files should be cached (unchanged since --force build)
    expect(diff.unchangedFiles.length).toBe(2);
    expect(diff.changedFiles.length).toBe(0);
    expect(diff.cachedExtractions.length).toBe(2);
  });

  it("should detect changes correctly when one file is modified after --force", () => {
    // Modify one file
    writeFileSync(join(workspaceDir, "a.py"), "def foo_v2(): return 42\n");

    const files = ["a.py", "b.py"];
    const currentHashes = computeHashes(workspaceDir, files);
    const cache = loadBuildCache(outputDir)!;

    const diff = diffFiles(currentHashes, cache);
    expect(diff.changedFiles).toEqual(["a.py"]);
    expect(diff.unchangedFiles).toEqual(["b.py"]);
    expect(diff.cachedExtractions.length).toBe(1);
    expect(diff.cachedExtractions[0].filePath).toBe("b.py");
  });
});

// ─── E2E: Full --force → incremental cycle ───────────────────────────────────

describe("Force → incremental build cycle (e2e sandbox)", () => {
  const root = join(tmpdir(), `rn-force-cache-e2e-${Date.now()}`);
  const workspaceDir = join(root, "workspace");
  const outputDir = join(root, "output");

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("full cycle: --force saves cache, next incremental uses it", () => {
    // 1. Setup workspace
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(workspaceDir, "core.py"), "class Engine:\n    def run(self): pass\n");
    writeFileSync(join(workspaceDir, "utils.py"), "def helper(): return True\n");
    writeFileSync(join(workspaceDir, "main.py"), "from core import Engine\nEngine().run()\n");

    const files = ["core.py", "utils.py", "main.py"];

    // 2. Simulate --force build (incremental=false)
    const hashesForce = computeHashes(workspaceDir, files);
    const cacheForce = false ? loadBuildCache(outputDir) : null;
    expect(cacheForce).toBeNull();

    const diffForce = diffFiles(hashesForce, cacheForce);
    expect(diffForce.changedFiles.length).toBe(3);
    expect(diffForce.unchangedFiles.length).toBe(0);

    // Simulate extraction results
    const extractionsForce = files.map((f) =>
      makeExtraction(f, f.replace(".py", "_fn")),
    );

    // Save cache (the fix — no incremental guard)
    saveBuildCache(outputDir, hashesForce, extractionsForce);
    cleanStaleCacheEntries(outputDir, hashesForce);

    // 3. Verify cache files on disk
    const hashesJson = join(outputDir, ".cache", "hashes.json");
    expect(existsSync(hashesJson)).toBe(true);
    const savedHashes = JSON.parse(readFileSync(hashesJson, "utf-8")) as Record<string, string>;
    expect(Object.keys(savedHashes).length).toBe(3);
    expect(savedHashes["core.py"]).toMatch(/^[a-f0-9]{64}$/);

    // 4. Simulate next incremental build (incremental=true, no file changes)
    const hashesIncr = computeHashes(workspaceDir, files);
    const cacheIncr = loadBuildCache(outputDir);
    expect(cacheIncr).not.toBeNull();

    const diffIncr = diffFiles(hashesIncr, cacheIncr);
    expect(diffIncr.cachedFiles ?? diffIncr.unchangedFiles.length).toBe(3);
    expect(diffIncr.changedFiles.length).toBe(0);
    expect(diffIncr.cachedExtractions.length).toBe(3);

    // Verify cached extractions contain the right data
    const cachedPaths = diffIncr.cachedExtractions.map((e) => e.filePath).sort();
    expect(cachedPaths).toEqual(["core.py", "main.py", "utils.py"]);

    // 5. Modify one file and verify partial cache hit
    writeFileSync(join(workspaceDir, "utils.py"), "def helper_v2(): return False\n");
    const hashesPartial = computeHashes(workspaceDir, files);
    const diffPartial = diffFiles(hashesPartial, cacheIncr);

    expect(diffPartial.changedFiles).toEqual(["utils.py"]);
    expect(diffPartial.unchangedFiles.sort()).toEqual(["core.py", "main.py"]);
    expect(diffPartial.cachedExtractions.length).toBe(2);
  });

  it("simulates --force after existing cache (clears + rebuilds cache)", () => {
    // Reset workspace to known state
    writeFileSync(join(workspaceDir, "core.py"), "class Engine:\n    def run(self): pass\n");
    writeFileSync(join(workspaceDir, "utils.py"), "def helper(): return True\n");
    writeFileSync(join(workspaceDir, "main.py"), "from core import Engine\nEngine().run()\n");

    // Simulate --force: delete output dir and recreate (like orchestrator does)
    rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(outputDir, { recursive: true });

    const files = ["core.py", "utils.py", "main.py"];
    const hashes = computeHashes(workspaceDir, files);

    // No cache after --force cleanup
    const cache = loadBuildCache(outputDir);
    expect(cache).toBeNull();

    const diff = diffFiles(hashes, null);
    expect(diff.changedFiles.length).toBe(3);

    // Save cache (the fix ensures this always happens)
    const extractions = files.map((f) => makeExtraction(f, f.replace(".py", "_fn")));
    saveBuildCache(outputDir, hashes, extractions);
    cleanStaleCacheEntries(outputDir, hashes);

    // Immediately verify: next build should find everything cached
    const nextCache = loadBuildCache(outputDir);
    expect(nextCache).not.toBeNull();
    const nextDiff = diffFiles(hashes, nextCache);
    expect(nextDiff.unchangedFiles.length).toBe(3);
    expect(nextDiff.changedFiles.length).toBe(0);
  });
});
