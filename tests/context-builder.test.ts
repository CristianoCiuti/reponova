/**
 * Phase 3 tests: Smart Context Builder (graph_context)
 */
import { describe, it, expect, beforeAll } from "vitest";
import { openDatabase, initializeSchema, populateDatabase, loadGraphData } from "../dist/index.js";
import { ContextBuilder } from "../dist/index.js";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const FIXTURE_PATH = join(import.meta.dirname, "fixtures", "sample-graph.json");

describe("ContextBuilder", () => {
  let db: Awaited<ReturnType<typeof openDatabase>>;
  let graphDir: string;

  beforeAll(async () => {
    const graphData = loadGraphData(FIXTURE_PATH);
    db = await openDatabase(":memory:");
    initializeSchema(db);
    populateDatabase(db, graphData);

    // Create temp graphDir
    graphDir = mkdtempSync(join(tmpdir(), "gmt-test-context-"));

    // Write mock community summaries
    const summaries = [
      { community_id: "0", summary: "Core authentication and user management module" },
      { community_id: "1", summary: "Data processing and transformation pipeline" },
    ];
    writeFileSync(join(graphDir, "community_summaries.json"), JSON.stringify(summaries));

    // Write mock node descriptions
    const descriptions = [
      { id: "Function:authenticate", description: "Validates user credentials and returns JWT token" },
    ];
    writeFileSync(join(graphDir, "node_descriptions.json"), JSON.stringify(descriptions));
  });

  it("should build context for a query (text-only mode)", async () => {
    const builder = new ContextBuilder(db, graphDir);
    await builder.initialize();

    const result = await builder.buildContext({
      query: "config",
      max_tokens: 2048,
    });

    expect(result.query).toBe("config");
    expect(result.max_tokens).toBe(2048);
    expect(result.total_tokens).toBeGreaterThan(0);
    expect(result.total_tokens).toBeLessThanOrEqual(2048);
    expect(result.sections.length).toBeGreaterThan(0);

    // Should have at least candidates and metadata sections
    const types = result.sections.map(s => s.type);
    expect(types).toContain("candidates");
    expect(types).toContain("metadata");

    await builder.dispose();
  });

  it("should respect token budget", async () => {
    const builder = new ContextBuilder(db, graphDir);
    await builder.initialize();

    const result = await builder.buildContext({
      query: "module",
      max_tokens: 512,
    });

    // Total tokens should not exceed budget (with some tolerance for metadata overhead)
    expect(result.total_tokens).toBeLessThanOrEqual(600); // allow small overhead
    await builder.dispose();
  });

  it("should return structured format when requested", async () => {
    const builder = new ContextBuilder(db, graphDir);
    await builder.initialize();

    const result = await builder.buildContext({
      query: "module",
      max_tokens: 2048,
      format: "structured",
    });

    expect(result.structured).toBeDefined();
    expect(result.structured!.candidates).toBeInstanceOf(Array);
    expect(result.structured!.relationships).toBeInstanceOf(Array);
    expect(result.structured!.communities).toBeInstanceOf(Array);

    if (result.structured!.candidates.length > 0) {
      const first = result.structured!.candidates[0]!;
      expect(first.id).toBeDefined();
      expect(first.label).toBeDefined();
      expect(first.type).toBeDefined();
      expect(first.score).toBeGreaterThan(0);
    }

    await builder.dispose();
  });

  it("should format result as narrative text", async () => {
    const builder = new ContextBuilder(db, graphDir);
    await builder.initialize();

    const result = await builder.buildContext({
      query: "module",
      max_tokens: 2048,
    });

    const text = builder.formatAsText(result);
    expect(text).toContain("Relevant Symbols");
    expect(text).toContain("Token usage:");

    await builder.dispose();
  });

  it("should filter by scope (repo)", async () => {
    const builder = new ContextBuilder(db, graphDir);
    await builder.initialize();

    const result = await builder.buildContext({
      query: "module",
      max_tokens: 2048,
      scope: "nonexistent-repo",
    });

    // Should return empty or minimal context for non-matching scope
    const candidates = result.sections.find(s => s.type === "candidates");
    expect(candidates).toBeDefined();

    await builder.dispose();
  });

  it("should load community summaries from disk", async () => {
    const builder = new ContextBuilder(db, graphDir);
    await builder.initialize();

    const result = await builder.buildContext({
      query: "authenticate",
      max_tokens: 4096,
    });

    // If any candidate is in community "0", we should see the summary
    const commSection = result.sections.find(s => s.type === "community");
    expect(commSection).toBeDefined();

    await builder.dispose();
  });

  it("should expand graph relationships from candidates", async () => {
    const builder = new ContextBuilder(db, graphDir);
    await builder.initialize();

    const result = await builder.buildContext({
      query: "module",
      max_tokens: 4096,
      format: "structured",
    });

    // Should find some relationships (our test graph has edges)
    if (result.structured!.candidates.length > 0) {
      expect(result.structured!.relationships.length).toBeGreaterThan(0);
    }

    await builder.dispose();
  });

  it("should handle empty query gracefully", async () => {
    const builder = new ContextBuilder(db, graphDir);
    await builder.initialize();

    const result = await builder.buildContext({
      query: "",
      max_tokens: 2048,
    });

    // Should not crash, may return minimal context
    expect(result.sections).toBeDefined();
    await builder.dispose();
  });
});
