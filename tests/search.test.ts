import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { openDatabase, initializeSchema, populateDatabase, getMeta } from "../src/core/db.js";
import type { Database } from "../src/core/db.js";
import { loadGraphData } from "../src/core/graph-loader.js";
import { searchNodes, fuzzyMatchNode } from "../src/core/search.js";

const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/sample-graph.json");
let db: Database;

beforeAll(async () => {
  const graphData = loadGraphData(FIXTURE_PATH);
  db = await openDatabase(":memory:");
  initializeSchema(db);
  populateDatabase(db, graphData);
});

afterAll(() => { db.close(); });

describe("searchNodes", () => {
  it("finds nodes by keyword", () => {
    const results = searchNodes(db, "user");
    expect(results.length).toBeGreaterThan(0);
  });

  it("respects top_k limit", () => {
    const results = searchNodes(db, "user", { top_k: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("filters by repo", () => {
    const results = searchNodes(db, "connect", { repo: "project-core" });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.repo).toBe("project-core");
  });

  it("filters by type", () => {
    const results = searchNodes(db, "User", { type: "class" });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.type).toBe("class");
  });

  it("returns empty for no matches", () => {
    expect(searchNodes(db, "xyznonexistent12345")).toHaveLength(0);
  });

  it("handles special characters", () => {
    expect(Array.isArray(searchNodes(db, 'user "auth" (test)'))).toBe(true);
  });
});

describe("fuzzyMatchNode", () => {
  it("finds close matches", () => {
    const results = fuzzyMatchNode(db, "get_user");
    expect(results.length).toBeGreaterThan(0);
  });

  it("requires ALL terms to match (AND logic, FIX-005)", () => {
    // "nonexistent_user" splits to ["nonexistent", "user"]
    // AND logic: both must appear in label → no node has "nonexistent" → 0 results
    const results = fuzzyMatchNode(db, "nonexistent_user");
    expect(results).toHaveLength(0);
  });

  it("matches when all terms are present in label", () => {
    // "get_user" splits to ["get", "user"] — "get_user_by_id" contains both
    const results = fuzzyMatchNode(db, "get_user");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.label).toContain("get_user");
  });
});

describe("metadata", () => {
  it("stores node count", () => { expect(getMeta(db, "node_count")).toBe("13"); });
  it("stores edge count", () => { expect(getMeta(db, "edge_count")).toBe("12"); });
  it("stores repos", () => {
    const repos = JSON.parse(getMeta(db, "repos")!);
    expect(repos).toContain("project-api");
    expect(repos).toContain("project-core");
  });
});
