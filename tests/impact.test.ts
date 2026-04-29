import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { openDatabase, initializeSchema, populateDatabase } from "../src/core/db.js";
import type { Database } from "../src/core/db.js";
import { loadGraphData } from "../src/core/graph-loader.js";
import { analyzeImpact, formatImpactMarkdown } from "../src/core/impact.js";

const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/sample-graph.json");
let db: Database;

beforeAll(async () => {
  const graphData = loadGraphData(FIXTURE_PATH);
  db = await openDatabase(":memory:");
  initializeSchema(db);
  populateDatabase(db, graphData);
});

afterAll(() => { db.close(); });

describe("analyzeImpact", () => {
  it("finds upstream dependencies", () => {
    const result = analyzeImpact(db, "Function:connect_database", { direction: "upstream" });
    expect(result).not.toBeNull();
    expect(result!.upstream[0]!.nodes.length).toBeGreaterThanOrEqual(3);
  });

  it("finds downstream dependencies", () => {
    const result = analyzeImpact(db, "Function:connect_database", { direction: "downstream" });
    expect(result).not.toBeNull();
    expect(result!.downstream[0]!.nodes.some((n) => n.label === "get_db_url")).toBe(true);
  });

  it("respects max_depth", () => {
    const result = analyzeImpact(db, "Function:connect_database", { direction: "upstream", max_depth: 1 });
    expect(result!.upstream.length).toBe(1);
  });

  it("excludes tests by default", () => {
    const result = analyzeImpact(db, "Function:get_user_by_id", { direction: "upstream" });
    const allNodes = result!.upstream.flatMap((l) => l.nodes);
    expect(allNodes.every((n) => !n.source_file?.includes("test_"))).toBe(true);
  });

  it("includes tests when requested", () => {
    const result = analyzeImpact(db, "Function:get_user_by_id", { direction: "upstream", include_tests: true });
    const allNodes = result!.upstream.flatMap((l) => l.nodes);
    expect(allNodes.some((n) => n.source_file?.includes("test_"))).toBe(true);
  });

  it("detects cross-repo", () => {
    const result = analyzeImpact(db, "Function:connect_database", { direction: "upstream" });
    expect(result!.cross_repo_summary.size).toBeGreaterThan(0);
  });

  it("returns null for unknown", () => {
    expect(analyzeImpact(db, "Function:nonexistent")).toBeNull();
  });

  it("formats markdown", () => {
    const md = formatImpactMarkdown(analyzeImpact(db, "Function:connect_database")!);
    expect(md).toContain("## Impact analysis: connect_database");
  });
});
