import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { openDatabase, initializeSchema, populateDatabase } from "../src/core/db.js";
import type { Database } from "../src/core/db.js";
import { loadGraphData } from "../src/core/graph-loader.js";
import { getNodeDetail, getNodeSuggestions, formatNodeDetailMarkdown } from "../src/core/node-detail.js";

const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/sample-graph.json");
let db: Database;

beforeAll(async () => {
  const graphData = loadGraphData(FIXTURE_PATH);
  db = await openDatabase(":memory:");
  initializeSchema(db);
  populateDatabase(db, graphData);
});

afterAll(() => { db.close(); });

describe("getNodeDetail", () => {
  it("finds by ID", () => {
    const d = getNodeDetail(db, "Function:get_user_by_id");
    expect(d).not.toBeNull();
    expect(d!.label).toBe("get_user_by_id");
  });

  it("finds by label", () => {
    const d = getNodeDetail(db, "connect_database");
    expect(d!.id).toBe("Function:connect_database");
  });

  it("includes edges", () => {
    const d = getNodeDetail(db, "Function:get_user_by_id")!;
    expect(Object.keys(d.outgoing_edges).length).toBeGreaterThan(0);
  });

  it("includes centrality", () => {
    const d = getNodeDetail(db, "Function:connect_database")!;
    expect(d.centrality.in_degree).toBeGreaterThan(0);
  });

  it("includes properties", () => {
    const d = getNodeDetail(db, "Function:get_user_by_id")!;
    expect(d.signature).toContain("get_user_by_id");
    expect(d.docstring).toContain("Retrieves");
  });

  it("returns null for unknown", () => {
    expect(getNodeDetail(db, "nonexistent")).toBeNull();
  });
});

describe("getNodeSuggestions", () => {
  it("suggests similar", () => {
    expect(getNodeSuggestions(db, "get_usr").length).toBeGreaterThan(0);
  });
});

describe("formatNodeDetailMarkdown", () => {
  it("formats detail", () => {
    const md = formatNodeDetailMarkdown(getNodeDetail(db, "Function:get_user_by_id")!);
    expect(md).toContain("## Node: get_user_by_id");
    expect(md).toContain("Centrality:");
  });
});
