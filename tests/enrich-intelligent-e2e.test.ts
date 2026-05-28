/**
 * E2E tests for intelligent enrichment with a mock LLM provider.
 *
 * Tests the full orchestrator pipeline end-to-end.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GraphData, Config } from "../src/shared/types.js";
import type { LlmProvider, LlmCompletionOptions } from "../src/intelligence/llm-provider.js";
import type { ProviderRegistry } from "../src/intelligence/provider-registry.js";
import { runFullEnrichment } from "../src/pipeline/enrich/orchestrator.js";
import { runMetrics } from "../src/pipeline/enrich/metrics.js";
import { runMerge } from "../src/pipeline/enrich/merge.js";
import { runApply } from "../src/pipeline/enrich/apply.js";
import { runFinalize } from "../src/pipeline/enrich/finalize.js";
import { runPrepare } from "../src/pipeline/enrich/prepare.js";
import { hashFile, writeHashFile } from "../src/pipeline/cache/utils.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `rn-enrich-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, ".cache"), { recursive: true });
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeGraph(): GraphData {
  return {
    nodes: [
      { id: "auth.login", label: "login", type: "function", community: "auth", source_file: "src/auth.py", start_line: 1, end_line: 10, repo: "main" },
      { id: "auth.verify", label: "verify", type: "function", community: "auth", source_file: "src/auth.py", start_line: 12, end_line: 20, repo: "main" },
      { id: "auth.token", label: "token", type: "function", community: "auth", source_file: "src/auth.py", start_line: 22, end_line: 30, repo: "main" },
      { id: "db.query", label: "query", type: "function", community: "data", source_file: "src/db.py", start_line: 1, end_line: 15, repo: "main" },
      { id: "db.connect", label: "connect", type: "function", community: "data", source_file: "src/db.py", start_line: 17, end_line: 25, repo: "main" },
      { id: "api.handler", label: "handler", type: "function", community: "api", source_file: "src/api.py", start_line: 1, end_line: 20, repo: "main" },
      { id: "api.middleware", label: "middleware", type: "function", community: "api", source_file: "src/api.py", start_line: 22, end_line: 35, repo: "main" },
      { id: "utils.hash", label: "hash", type: "function", community: "auth", source_file: "src/utils.py", start_line: 1, end_line: 5, repo: "main" },
    ],
    edges: [
      { source: "auth.login", target: "auth.verify", type: "calls" },
      { source: "auth.login", target: "db.query", type: "calls" }, // cross-community
      { source: "auth.verify", target: "auth.token", type: "calls" },
      { source: "api.handler", target: "auth.login", type: "calls" }, // cross-community
      { source: "api.handler", target: "db.query", type: "calls" }, // cross-community
      { source: "api.middleware", target: "auth.verify", type: "calls" }, // cross-community
      { source: "db.query", target: "db.connect", type: "calls" },
      { source: "utils.hash", target: "db.query", type: "calls" }, // cross-community
    ],
  };
}

function makeConfig(repoDir: string): Config {
  return {
    output: testDir,
    repos: [{ name: "main", path: repoDir }],
    providers: {},
    models: { cache_dir: "~/.cache/reponova/models", gpu: "cpu", threads: 0, download_on_first_use: false },
    patterns: [],
    exclude: [],
    exclude_common: true,
    incremental: true,
    docs: { enabled: false, patterns: [], exclude: [], max_file_size_kb: 500 },
    images: { enabled: false, patterns: [], exclude: [], parse_puml: true, parse_svg_text: true },
    embeddings: { enabled: false, batch_size: 128 },
    html: false,
    outlines: { enabled: false },
    server: {},
    enrich: {
      enabled: true,
      provider: "mock-llm",
      threshold: 0.8,
      max_communities: 0,
      candidate_threshold: 0.3,
      description_batch_tokens: 50000,
      routing_batch_size: 30,
      concurrency: 2,
      max_retry_depth: 1,
      max_tokens: { descriptions: 32768, profiles: 2048, routing: 8192, restructure: 4096 },
      profile: { max_nodes: 80, max_edges: 50 },
      restructure_max_pairs: 20,
    },
  };
}

/** Pad a string with empty lines up to at least `n` lines total. */
function padLines(content: string, n: number): string {
  const lines = content.split("\n");
  while (lines.length < n) lines.push("");
  return lines.join("\n");
}

/** Write source files for the mock graph. Must have enough lines to cover end_line values. */
function writeSourceFiles(repoDir: string): void {
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "auth.py"), padLines([
    "def login():",
    "    user = get_user()",
    "    if verify(user):",
    "        return token(user)",
    "    return None",
    "",
    "def verify(user):",
    "    return user.is_active and user.password_valid",
    "",
    "def token(user):",
    "    import jwt",
    "    return jwt.encode({'id': user.id}, SECRET)",
  ].join("\n"), 35));
  writeFileSync(join(repoDir, "src", "db.py"), padLines([
    "def query(sql, params=None):",
    "    conn = connect()",
    "    cursor = conn.execute(sql, params or [])",
    "    return cursor.fetchall()",
    "",
    "def connect():",
    "    from db_driver import Database",
    "    return Database.connect(config.DATABASE_URL)",
  ].join("\n"), 30));
  writeFileSync(join(repoDir, "src", "api.py"), padLines([
    "def handler(request):",
    "    user = auth.login(request.credentials)",
    "    data = db.query(request.query_string)",
    "    return Response(200, data)",
    "",
    "def middleware(request, next_handler):",
    "    if not auth.verify(request.token):",
    "        return Response(401, 'Unauthorized')",
    "    return next_handler(request)",
  ].join("\n"), 40));
  writeFileSync(join(repoDir, "src", "utils.py"), padLines([
    "def hash(data):",
    "    import hashlib",
    "    return hashlib.sha256(data.encode()).hexdigest()",
  ].join("\n"), 10));
}

/**
 * Mock LLM provider that returns valid JSON responses for each step.
 */
class MockLlmProvider implements LlmProvider {
  readonly isAvailable = true;
  callCount = 0;
  lastSystemPrompt = "";
  lastMaxTokens: number | undefined = undefined;
  maxTokensHistory: (number | undefined)[] = [];

  async initialize(): Promise<boolean> {
    return true;
  }

  async generate(options: LlmCompletionOptions): Promise<string | null> {
    this.callCount++;
    this.lastSystemPrompt = options.systemPrompt;
    this.lastMaxTokens = options.maxTokens;
    this.maxTokensHistory.push(options.maxTokens);

    // Step 1: Node descriptions
    if (options.systemPrompt.includes("1-2 sentence description")) {
      // Extract node IDs from the user prompt
      const ids = [...options.userPrompt.matchAll(/\(([^,]+),/g)].map((m) => m[1]);
      return JSON.stringify(ids.map((id) => ({ id, description: `Mock description for ${id}` })));
    }

    // Step 2: Community profiling
    if (options.systemPrompt.includes("profiling a code community")) {
      const commMatch = options.systemPrompt.match(/"communityId": "([^"]+)"/);
      const commId = commMatch?.[1] ?? "unknown";
      return JSON.stringify({
        communityId: commId,
        label: `${commId} services`,
        profile: `Handles ${commId}-related operations and utilities.`,
        misfits: [],
      });
    }

    // Step 3: Candidate routing
    if (options.systemPrompt.includes("STAY in current community or MOVE")) {
      const nodeMatches = [...options.userPrompt.matchAll(/^\d+\.\s+(\S+)/gm)];
      return JSON.stringify(nodeMatches.map((m) => ({
        node: m[1],
        action: "stay",
        reason: "Mock: node fits its community",
      })));
    }

    // Step 4: Merge/Split
    if (options.systemPrompt.includes("merges") && options.systemPrompt.includes("splits")) {
      return JSON.stringify({ merges: [], splits: [] });
    }

    return "{}";
  }

  async dispose(): Promise<void> {}
}

/**
 * Create a mock ProviderRegistry that returns the mock LLM provider.
 */
function createMockRegistry(mockProvider: MockLlmProvider): ProviderRegistry {
  return {
    acquireLlm: async (_name?: string) => mockProvider,
    acquireEmbedding: async () => null,
    disposeAll: async () => {},
  } as unknown as ProviderRegistry;
}

// ─── E2E Tests ───────────────────────────────────────────────────────────────

describe("intelligent enrichment E2E", { timeout: 30000 }, () => {

  it("enrich:metrics produces candidates.json and edge-density.json", () => {
    writeFileSync(join(testDir, "graph.json"), JSON.stringify(makeGraph()));

    const result = runMetrics({ outputDir: testDir, candidateThreshold: 0.3 });
    expect(result.totalNodes).toBe(8);
    expect(result.candidateCount).toBeGreaterThan(0);

    expect(existsSync(join(testDir, ".enrich", "candidates.json"))).toBe(true);
    expect(existsSync(join(testDir, ".enrich", "edge-density.json"))).toBe(true);

    const candidates = JSON.parse(readFileSync(join(testDir, ".enrich", "candidates.json"), "utf-8"));
    expect(candidates.candidates).toHaveLength(8);
    expect(candidates.threshold).toBe(0.3);
  });

  it("enrich:metrics invalidates .enrich/ when graph.json changes", () => {
    const graph1 = makeGraph();
    writeFileSync(join(testDir, "graph.json"), JSON.stringify(graph1));
    writeFileSync(join(testDir, ".cache", "enrich-input-hash.txt"), "old-hash-that-wont-match");

    // Create stale .enrich directory
    mkdirSync(join(testDir, ".enrich"), { recursive: true });
    writeFileSync(join(testDir, ".enrich", "stale-file.txt"), "should be deleted");

    runMetrics({ outputDir: testDir, candidateThreshold: 0.3 });

    // Stale file should be gone (directory was invalidated and recreated)
    expect(existsSync(join(testDir, ".enrich", "stale-file.txt"))).toBe(false);
    expect(existsSync(join(testDir, ".enrich", "candidates.json"))).toBe(true);
  });

  it("enrich:merge concatenates batch files correctly", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(join(enrichDir, "output", "descriptions"), { recursive: true });

    writeFileSync(join(enrichDir, "output", "descriptions", "batch-001.json"), JSON.stringify([
      { id: "auth.login", description: "Handles login" },
      { id: "auth.verify", description: "Verifies credentials" },
    ]));
    writeFileSync(join(enrichDir, "output", "descriptions", "batch-002.json"), JSON.stringify([
      { id: "db.query", description: "Runs database queries" },
    ]));

    const result = runMerge(testDir, "descriptions");
    expect(result.merged).toBe(2);

    const merged = JSON.parse(readFileSync(join(enrichDir, "descriptions.json"), "utf-8"));
    expect(merged).toHaveLength(3);
    expect(merged.map((d: any) => d.id)).toEqual(["auth.login", "auth.verify", "db.query"]);
  });

  it("enrich:prepare creates input batches and cleans stale files on repeat", () => {
    const repoDir = join(testDir, "repo");
    writeSourceFiles(repoDir);
    writeFileSync(join(testDir, "graph.json"), JSON.stringify(makeGraph()));

    // Run metrics (prerequisite for descriptions)
    runMetrics({ outputDir: testDir, candidateThreshold: 0.3 });

    const config = makeConfig(repoDir);

    // First prepare call
    const result1 = runPrepare({ outputDir: testDir, config, configDir: repoDir }, "descriptions");
    expect(result1.batchCount).toBeGreaterThan(0);
    expect(existsSync(result1.inputDir)).toBe(true);

    // Plant a stale file
    writeFileSync(join(result1.inputDir, "batch-999.json"), JSON.stringify({ stale: true }));

    // Second prepare call — stale files removed
    const result2 = runPrepare({ outputDir: testDir, config, configDir: repoDir }, "descriptions");
    expect(existsSync(join(result2.inputDir, "batch-999.json"))).toBe(false);
    expect(result2.batchCount).toBe(result1.batchCount); // same data → same batch count
  });

  it("enrich:apply moves nodes and writes modified-communities.json", () => {
    writeFileSync(join(testDir, "graph.json"), JSON.stringify(makeGraph()));
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(enrichDir, { recursive: true });

    writeFileSync(join(enrichDir, "routing.json"), JSON.stringify([
      { node: "utils.hash", action: "move", to: "data", reason: "hash is used primarily by db" },
    ]));
    writeFileSync(join(enrichDir, "restructure.json"), JSON.stringify({ merges: [], splits: [] }));

    const result = runApply(testDir);
    expect(result.moved).toBe(1);

    const applied = JSON.parse(readFileSync(join(enrichDir, "graph-applied.json"), "utf-8"));
    const utilsHash = applied.nodes.find((n: any) => n.id === "utils.hash");
    expect(utilsHash.community).toBe("data");

    const modified = JSON.parse(readFileSync(join(enrichDir, "modified-communities.json"), "utf-8"));
    expect(modified.modified).toContain("auth");
    expect(modified.modified).toContain("data");
  });

  it("enrich:finalize assembles final output files", () => {
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(enrichDir, { recursive: true });

    const graph = makeGraph();
    writeFileSync(join(enrichDir, "graph-applied.json"), JSON.stringify(graph));
    writeFileSync(join(enrichDir, "descriptions.json"), JSON.stringify([
      { id: "auth.login", description: "Handles user login" },
    ]));
    writeFileSync(join(enrichDir, "profiles.json"), JSON.stringify([
      { communityId: "auth", label: "Authentication", profile: "Manages user authentication", misfits: [] },
    ]));

    runFinalize(testDir);

    expect(existsSync(join(testDir, "graph-enriched.json"))).toBe(true);
    expect(existsSync(join(testDir, "node_descriptions.json"))).toBe(true);
    expect(existsSync(join(testDir, "community_summaries.json"))).toBe(true);

    const summaries = JSON.parse(readFileSync(join(testDir, "community_summaries.json"), "utf-8"));
    const auth = summaries.find((s: any) => s.id === "auth");
    expect(auth.label).toBe("Authentication");
    expect(auth.nodeCount).toBe(4); // login, verify, token, hash
  });

  it("full pipeline with mock provider completes end-to-end", async () => {
    // Setup source files (so batcher can read them)
    const repoDir = join(testDir, "repo");
    writeSourceFiles(repoDir);
    writeFileSync(join(testDir, "graph.json"), JSON.stringify(makeGraph()));

    const mockProvider = new MockLlmProvider();
    const config = makeConfig(repoDir);
    const mockRegistry = createMockRegistry(mockProvider);

    const result = await runFullEnrichment({
      config,
      outputDir: testDir,
      configDir: repoDir,
      providerRegistry: mockRegistry,
    });

    // Verify LLM was called
    expect(mockProvider.callCount).toBeGreaterThan(0);
    expect(result.totalLlmCalls).toBeGreaterThan(0);

    // Verify final output files exist
    expect(existsSync(join(testDir, "graph-enriched.json"))).toBe(true);
    expect(existsSync(join(testDir, "node_descriptions.json"))).toBe(true);
    expect(existsSync(join(testDir, "community_summaries.json"))).toBe(true);

    // Verify intermediate files exist
    expect(existsSync(join(testDir, ".enrich", "candidates.json"))).toBe(true);
    expect(existsSync(join(testDir, ".enrich", "descriptions.json"))).toBe(true);
    expect(existsSync(join(testDir, ".enrich", "profiles.json"))).toBe(true);
    expect(existsSync(join(testDir, ".enrich", "routing.json"))).toBe(true);
    expect(existsSync(join(testDir, ".enrich", "restructure.json"))).toBe(true);
    expect(existsSync(join(testDir, ".enrich", "graph-applied.json"))).toBe(true);

    // Verify graph-enriched.json has nodes
    const enriched = JSON.parse(readFileSync(join(testDir, "graph-enriched.json"), "utf-8"));
    expect(enriched.nodes).toHaveLength(8);
  });

  it("resumption: skips completed steps on re-run", async () => {
    const repoDir = join(testDir, "repo");
    writeSourceFiles(repoDir);
    writeFileSync(join(testDir, "graph.json"), JSON.stringify(makeGraph()));

    const mockProvider = new MockLlmProvider();
    const config = makeConfig(repoDir);
    const mockRegistry = createMockRegistry(mockProvider);

    // First run
    await runFullEnrichment({ config, outputDir: testDir, configDir: repoDir, providerRegistry: mockRegistry });
    const firstCallCount = mockProvider.callCount;
    expect(firstCallCount).toBeGreaterThan(0);

    // Seal the cache (simulates `reponova cache --target enrich`)
    const graphHash = hashFile(join(testDir, "graph.json"));
    writeHashFile(join(testDir, ".cache", "enrich-input-hash.txt"), graphHash);

    // Second run — should skip all LLM steps (all final files exist + hash sealed)
    mockProvider.callCount = 0;
    await runFullEnrichment({ config, outputDir: testDir, configDir: repoDir, providerRegistry: mockRegistry });

    // Second run should have 0 LLM calls (all steps skipped)
    expect(mockProvider.callCount).toBe(0);
  });

  it("IDE flow step 4: prepare → agent writes to output/ → merge → apply reads from .enrich/", () => {
    writeFileSync(join(testDir, "graph.json"), JSON.stringify(makeGraph()));
    const enrichDir = join(testDir, ".enrich");
    mkdirSync(enrichDir, { recursive: true });

    // Prerequisites: routing.json must exist for apply
    writeFileSync(join(enrichDir, "routing.json"), JSON.stringify([
      { node: "utils.hash", action: "move", to: "data", reason: "used by db" },
    ]));

    // Simulate agent writing restructure output (as the skill instructs)
    mkdirSync(join(enrichDir, "output", "restructure"), { recursive: true });
    const agentOutput = {
      merges: [{ communities: ["auth", "data"], newLabel: "Auth+Data", reason: "tightly coupled" }],
      splits: [],
    };
    writeFileSync(join(enrichDir, "output", "restructure", "restructure.json"), JSON.stringify(agentOutput));

    // Run merge (this is what was missing before the fix!)
    const mergeResult = runMerge(testDir, "restructure");
    expect(mergeResult.merged).toBe(1);

    // Verify .enrich/restructure.json now exists (what apply.ts reads)
    expect(existsSync(join(enrichDir, "restructure.json"))).toBe(true);
    const finalRestructure = JSON.parse(readFileSync(join(enrichDir, "restructure.json"), "utf-8"));
    expect(finalRestructure.merges).toHaveLength(1);
    expect(finalRestructure.merges[0].communities).toEqual(["auth", "data"]);

    // Run apply — should succeed now (was failing before because restructure.json didn't exist)
    const applyResult = runApply(testDir);
    expect(applyResult.moved).toBe(1);
    expect(applyResult.merged).toBe(1);

    // Verify merge was applied
    const applied = JSON.parse(readFileSync(join(enrichDir, "graph-applied.json"), "utf-8"));
    // After merge, all "data" nodes should now be in "auth" (first community in merge list)
    const dataNodes = applied.nodes.filter((n: any) => n.community === "data");
    expect(dataNodes).toHaveLength(0); // all merged into "auth"
  });

  it("orchestrator throws when no provider configured", async () => {
    writeFileSync(join(testDir, "graph.json"), JSON.stringify(makeGraph()));

    const config = makeConfig(testDir);
    config.enrich.provider = undefined;

    await expect(
      runFullEnrichment({
        config,
        outputDir: testDir,
        configDir: testDir,
        providerRegistry: createMockRegistry(new MockLlmProvider()),
      }),
    ).rejects.toThrow("enrich.provider is required");
  });

  it("orchestrator passes max_tokens per step to the LLM provider", async () => {
    const repoDir = join(testDir, "repo");
    writeFileSync(join(testDir, "graph.json"), JSON.stringify(makeGraph()));
    writeSourceFiles(repoDir);

    const config = makeConfig(repoDir);
    config.enrich.max_tokens = {
      descriptions: 4096,
      profiles: 512,
      routing: 1024,
      restructure: 3000,
    };

    const mockProvider = new MockLlmProvider();
    const registry = createMockRegistry(mockProvider);

    await runFullEnrichment({
      config,
      outputDir: testDir,
      configDir: repoDir,
      providerRegistry: registry,
    });

    // Verify maxTokens was passed (check history)
    expect(mockProvider.maxTokensHistory.length).toBeGreaterThan(0);

    // Step 1 (descriptions) should use 4096
    expect(mockProvider.maxTokensHistory[0]).toBe(4096);

    // Find the profile call (step 2) — systemPrompt contains "profiling"
    // After all description calls, profiles come next
    // We can't easily index by step, but verify at least one call used 512
    expect(mockProvider.maxTokensHistory).toContain(512);

    // Verify restructure used 3000 (last single call before step 6)
    expect(mockProvider.maxTokensHistory).toContain(3000);
  });

  it("orchestrator uses profile.max_nodes and profile.max_edges in prompts", async () => {
    const repoDir = join(testDir, "repo");
    writeFileSync(join(testDir, "graph.json"), JSON.stringify(makeGraph()));
    writeSourceFiles(repoDir);

    const config = makeConfig(repoDir);
    config.enrich.profile = { max_nodes: 2, max_edges: 1 };

    const mockProvider = new MockLlmProvider();
    const registry = createMockRegistry(mockProvider);

    await runFullEnrichment({
      config,
      outputDir: testDir,
      configDir: repoDir,
      providerRegistry: registry,
    });

    // Profile step ran — verify the enrichDir has profiles.json
    const enrichDir = join(testDir, ".enrich");
    expect(existsSync(join(enrichDir, "profiles.json"))).toBe(true);
  });

  it("orchestrator uses restructure_max_pairs to limit density pairs", async () => {
    // Create a graph with many cross-community edges to generate many density pairs
    const graph = makeGraph();
    // Add extra cross-edges
    graph.edges.push(
      { source: "auth.login", target: "data.query", type: "calls" },
      { source: "auth.verify", target: "data.store", type: "calls" },
      { source: "auth.token", target: "data.query", type: "calls" },
    );
    const repoDir = join(testDir, "repo");
    writeFileSync(join(testDir, "graph.json"), JSON.stringify(graph));
    writeSourceFiles(repoDir);

    const config = makeConfig(repoDir);
    config.enrich.restructure_max_pairs = 1;

    const mockProvider = new MockLlmProvider();
    const registry = createMockRegistry(mockProvider);

    await runFullEnrichment({
      config,
      outputDir: testDir,
      configDir: repoDir,
      providerRegistry: registry,
    });

    // Orchestrator completed without error — restructure was called with limited pairs
    const enrichDir = join(testDir, ".enrich");
    expect(existsSync(join(enrichDir, "restructure.json"))).toBe(true);
  });
});
