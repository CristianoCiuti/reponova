/**
 * Tests for MCP tool file path resolution.
 *
 * Verifies that resolveFilePaths produces correct graph-relative and
 * absolute paths, and that MCP tool handlers include them in responses
 * when a PathResolver is provided.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { resolveFilePaths, type RepoMapping, type PathResolver } from "../src/core/path-resolver.js";
import { handleSearch } from "../src/mcp/tools/search.js";
import { handleHotspots } from "../src/mcp/tools/hotspots.js";
import { handleCommunity } from "../src/mcp/tools/community.js";
import { handleImpact } from "../src/mcp/tools/impact.js";
import { openDatabase, type Database } from "../src/core/db.js";
import { initializeSchema, populateDatabase } from "../src/core/db.js";

// ─── Unit tests for resolveFilePaths ─────────────────────────────────────────

describe("resolveFilePaths", () => {
  const root = join(tmpdir(), `rn-resolve-paths-${Date.now()}`);
  const graphDir = join(root, "out");
  const repoDir = join(root, "repo");

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null when sourceFile is null", () => {
    const repos: RepoMapping[] = [{ name: "repo", absPath: repoDir }];
    const result = resolveFilePaths(graphDir, repos, "single", null);
    expect(result.graph_rel_path).toBeNull();
    expect(result.absolute_path).toBeNull();
  });

  it("returns null when repos is null", () => {
    const result = resolveFilePaths(graphDir, null, "single", "src/foo.py");
    expect(result.graph_rel_path).toBeNull();
    expect(result.absolute_path).toBeNull();
  });

  it("returns null when repos is empty", () => {
    const result = resolveFilePaths(graphDir, [], "single", "src/foo.py");
    expect(result.graph_rel_path).toBeNull();
    expect(result.absolute_path).toBeNull();
  });

  it("returns null when file does not exist on disk", () => {
    const repos: RepoMapping[] = [{ name: "repo", absPath: repoDir }];
    mkdirSync(repoDir, { recursive: true });
    const result = resolveFilePaths(graphDir, repos, "single", "nonexistent.py");
    expect(result.graph_rel_path).toBeNull();
    expect(result.absolute_path).toBeNull();
  });

  it("resolves paths correctly in single-repo mode", () => {
    mkdirSync(join(repoDir, "src"), { recursive: true });
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(repoDir, "src", "core.py"), "def main(): pass\n");

    const repos: RepoMapping[] = [{ name: "repo", absPath: resolve(repoDir) }];
    const result = resolveFilePaths(graphDir, repos, "single", "src/core.py");

    expect(result.absolute_path).not.toBeNull();
    expect(result.absolute_path!.replace(/\\/g, "/")).toContain("src/core.py");
    expect(result.graph_rel_path).not.toBeNull();
    // Graph-rel path goes from graphDir to the file — should contain ../
    expect(result.graph_rel_path!).toContain("src/core.py");
  });

  it("resolves paths correctly in multi-repo mode", () => {
    const apiDir = join(root, "api");
    mkdirSync(join(apiDir, "handlers"), { recursive: true });
    writeFileSync(join(apiDir, "handlers", "auth.py"), "def login(): pass\n");

    const repos: RepoMapping[] = [
      { name: "api", absPath: resolve(apiDir) },
      { name: "core", absPath: resolve(repoDir) },
    ];
    const result = resolveFilePaths(graphDir, repos, "multi", "api/handlers/auth.py");

    expect(result.absolute_path).not.toBeNull();
    expect(result.absolute_path!.replace(/\\/g, "/")).toContain("handlers/auth.py");
    expect(result.graph_rel_path).not.toBeNull();
    expect(result.graph_rel_path!).toContain("handlers/auth.py");
  });
});

// ─── E2E: MCP tool responses include paths ───────────────────────────────────

describe("MCP tools include resolved paths in responses (e2e sandbox)", () => {
  const root = join(tmpdir(), `rn-mcp-paths-e2e-${Date.now()}`);
  const graphDir = join(root, "out");
  const repoDir = join(root, "repo");
  let db: Database;
  let repos: RepoMapping[];
  let resolvePaths: PathResolver;

  afterAll(async () => {
    if (db) db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("setup: build a minimal graph with real files", async () => {
    // Create repo structure
    mkdirSync(join(repoDir, "src"), { recursive: true });
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(repoDir, "src", "main.py"), "def main(): pass\n");
    writeFileSync(join(repoDir, "src", "utils.py"), "def helper(): return True\n");

    repos = [{ name: "repo", absPath: resolve(repoDir) }];
    resolvePaths = (sourceFile: string) => resolveFilePaths(graphDir, repos, "single", sourceFile);

    // Create in-memory DB with sample data
    db = await openDatabase(":memory:");
    initializeSchema(db);

    const graphData = {
      nodes: [
        { id: "Module:src/main.py", label: "main.py", type: "module", source_file: "src/main.py", repo: "repo", community: "0" },
        { id: "Function:main", label: "main", type: "function", source_file: "src/main.py", repo: "repo", community: "0" },
        { id: "Module:src/utils.py", label: "utils.py", type: "module", source_file: "src/utils.py", repo: "repo", community: "0" },
        { id: "Function:helper", label: "helper", type: "function", source_file: "src/utils.py", repo: "repo", community: "0" },
      ],
      edges: [
        { source: "Module:src/main.py", target: "Function:main", type: "contains" },
        { source: "Module:src/utils.py", target: "Function:helper", type: "contains" },
        { source: "Function:main", target: "Function:helper", type: "calls" },
      ],
      communities: [{ id: "0", name: "Main", members: ["Module:src/main.py", "Function:main", "Module:src/utils.py", "Function:helper"], size: 4 }],
      metadata: {},
    };
    populateDatabase(db, graphData);
  });

  it("graph_search includes resolved paths", () => {
    const result = handleSearch(db, { query: "main" }, resolvePaths);
    const text = result.content[0]!.text;

    // Should contain the absolute path for src/main.py
    expect(text).toContain("Graph path:");
    expect(text).toContain("Absolute path:");
    expect(text).toContain("main.py");
  });

  it("graph_hotspots includes resolved paths", () => {
    const result = handleHotspots(db, { top_n: 5 }, resolvePaths);
    const text = result.content[0]!.text;

    expect(text).toContain("Graph path:");
    expect(text).toContain("Absolute path:");
  });

  it("graph_community includes resolved paths", () => {
    const result = handleCommunity(db, { community_id: "0" }, resolvePaths);
    const text = result.content[0]!.text;

    expect(text).toContain("Graph path:");
    expect(text).toContain("Absolute path:");
  });

  it("graph_impact includes resolved paths", () => {
    const result = handleImpact(db, { symbol: "main" }, resolvePaths);
    const text = result.content[0]!.text;

    // Impact analysis should resolve paths for target and impacted nodes
    expect(text).toContain("Graph path:");
    expect(text).toContain("Absolute path:");
  });

  it("graceful degradation: no paths when resolvePaths not provided", () => {
    const result = handleSearch(db, { query: "main" });
    const text = result.content[0]!.text;

    // Should still work, just without path resolution
    expect(text).toContain("main");
    expect(text).not.toContain("Graph path:");
    expect(text).not.toContain("Absolute path:");
  });

  it("graceful degradation: no paths when file doesn't exist on disk", () => {
    // Create a resolver with a nonexistent repo path
    const fakeResolver: PathResolver = (sourceFile: string) =>
      resolveFilePaths(graphDir, [{ name: "repo", absPath: "/nonexistent/path" }], "single", sourceFile);
    const result = handleSearch(db, { query: "main" }, fakeResolver);
    const text = result.content[0]!.text;

    // Should still show search results, just without resolved paths
    expect(text).toContain("main");
    expect(text).not.toContain("Graph path:");
    expect(text).not.toContain("Absolute path:");
  });
});
