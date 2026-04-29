import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { openDatabase, initializeSchema, populateDatabase } from "../src/core/db.js";
import type { Database } from "../src/core/db.js";
import { loadGraphData } from "../src/core/graph-loader.js";
import { findShortestPath, formatPathMarkdown } from "../src/core/shortest-path.js";

const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/sample-graph.json");
let db: Database;

beforeAll(async () => {
  const graphData = loadGraphData(FIXTURE_PATH);
  db = await openDatabase(":memory:");
  initializeSchema(db);
  populateDatabase(db, graphData);
});

afterAll(() => { db.close(); });

describe("findShortestPath", () => {
  it("finds a direct path", () => {
    const result = findShortestPath(db, "get_user_by_id", "connect_database");
    expect(result.found).toBe(true);
    expect(result.hops).toBe(1);
  });

  it("finds a multi-hop path", () => {
    const result = findShortestPath(db, "UserController.get", "connect_database");
    expect(result.found).toBe(true);
    expect(result.hops).toBe(2);
  });

  it("handles same node", () => {
    const result = findShortestPath(db, "connect_database", "connect_database");
    expect(result.found).toBe(true);
    expect(result.hops).toBe(0);
  });

  it("respects max_depth", () => {
    const result = findShortestPath(db, "UserController.get", "get_db_url", { max_depth: 1 });
    expect(result.found).toBe(false);
  });

  it("formats markdown", () => {
    const md = formatPathMarkdown(findShortestPath(db, "UserController.get", "connect_database"));
    expect(md).toContain("## Path:");
    expect(md).toContain("hops");
  });
});
