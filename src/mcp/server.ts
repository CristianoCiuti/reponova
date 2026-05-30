import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { statSync } from "node:fs";
import { resolveGraphPath, resolveSearchDb, resolveGraphJson } from "../shared/graph-resolver.js";
import { errorMessage, log } from "../shared/utils.js";
import type { PathResolver } from "../shared/path-resolver.js";
import type { Database } from "../query/db.js";

import { embeddingsConfigFromFingerprint, requireBuildConfigFingerprint } from "../pipeline/build-config-metadata.js";
import type { EmbeddingsConfig } from "../shared/types.js";

export interface McpServerOptions {
  graphPath?: string;
}

export function resolveEmbeddingsConfig(graphJsonPath: string | null): EmbeddingsConfig {
  if (!graphJsonPath) {
    throw new Error("graph.json not found");
  }
  const buildConfig = requireBuildConfigFingerprint(graphJsonPath);
  return embeddingsConfigFromFingerprint(buildConfig);
}

// ─── Resource Manager ────────────────────────────────────────────────────────

interface ServerResources {
  db: Database;
  graphDir: string;
  graphJsonPath: string;
  resolvePaths: PathResolver | null;
}

/**
 * Manages lazy loading and hot-reloading of graph resources.
 * - At startup: loads if reponova-out exists, otherwise stays idle.
 * - At each tool call: checks graph.json mtime. If changed (or first load), reloads.
 */
class ResourceManager {
  private resources: ServerResources | null = null;
  private loadingPromise: Promise<ServerResources | null> | null = null;
  private cachedMtimeMs: number = 0;
  private graphPathHint: string | undefined;

  constructor(graphPathHint: string | undefined) {
    this.graphPathHint = graphPathHint;
  }

  /**
   * Try initial load. Does NOT throw — if dir missing, server stays idle.
   */
  async tryInitialLoad(): Promise<void> {
    const graphDir = resolveGraphPath(this.graphPathHint);
    if (!graphDir) {
      log.info("Graph output not found — server will load resources on first tool call after build.");
      return;
    }
    const graphJsonPath = resolveGraphJson(graphDir);
    if (!graphJsonPath) {
      log.info("graph.json not found — server will load resources on first tool call after build.");
      return;
    }
    await this.loadResources(graphDir, graphJsonPath);
  }

  /**
   * Called before every tool call. Returns resources or throws a user-friendly error.
   */
  async getResources(): Promise<ServerResources> {
    // Re-resolve graph path each time (handles dir appearing after startup)
    const graphDir = resolveGraphPath(this.graphPathHint);
    if (!graphDir) {
      throw new Error("Graph output directory not found. Run 'reponova build' first, or pass --graph <path>.");
    }
    const graphJsonPath = resolveGraphJson(graphDir);
    if (!graphJsonPath) {
      throw new Error(`graph.json not found in ${graphDir}. Run 'reponova build' first.`);
    }

    // Check mtime
    const currentMtime = this.getGraphJsonMtime(graphJsonPath);

    // If already loaded and mtime matches, use cached
    if (this.resources && currentMtime === this.cachedMtimeMs && this.resources.graphDir === graphDir) {
      return this.resources;
    }

    // Need to load/reload
    return await this.loadResources(graphDir, graphJsonPath);
  }

  private getGraphJsonMtime(graphJsonPath: string): number {
    try {
      return statSync(graphJsonPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private async loadResources(graphDir: string, graphJsonPath: string): Promise<ServerResources> {
    // Deduplicate concurrent loads
    if (this.loadingPromise) {
      const result = await this.loadingPromise;
      if (result) return result;
    }

    this.loadingPromise = this.doLoad(graphDir, graphJsonPath);
    try {
      const result = await this.loadingPromise;
      if (!result) {
        throw new Error("Failed to load graph resources.");
      }
      return result;
    } finally {
      this.loadingPromise = null;
    }
  }

  private async doLoad(graphDir: string, graphJsonPath: string): Promise<ServerResources | null> {
    try {
      // Close previous DB if reloading
      if (this.resources) {
        try {
          this.resources.db.close();
        } catch { /* ignore */ }
        // Dispose embeddings from previous load
        try {
          const { disposeSimilaritySearch } = await import("./tools/similar.js");
          const { disposeContextBuilder } = await import("./tools/context.js");
          await disposeSimilaritySearch();
          await disposeContextBuilder();
        } catch { /* ignore */ }
        this.resources = null;
      }

      const dbPath = resolveSearchDb(graphDir);
      if (!dbPath) {
        log.warn(`Search database not found in ${graphDir}. Run 'reponova build' to generate it.`);
        return null;
      }

      log.info(`Loading graph from ${graphJsonPath}`);

      const { openDatabase } = await import("../query/db.js");
      const db = await openDatabase(dbPath, { readonly: true });

      // Reconstruct repo mappings from graph.json metadata
      let resolvePaths: PathResolver | null = null;
      try {
        const { loadGraphData } = await import("../graph/loader.js");
        const { reconstructRepos, resolveFilePaths } = await import("../shared/path-resolver.js");
        const graphData = loadGraphData(graphJsonPath);
        if (graphData.metadata) {
          const repos = reconstructRepos(graphDir, graphData.metadata.config_dir, graphData.metadata.repos);
          const mode = graphData.metadata.mode ?? "single";
          if (repos) {
            resolvePaths = (sourceFile: string) => resolveFilePaths(graphDir, repos, mode, sourceFile);
          }
        }
      } catch {
        log.warn("Could not load graph metadata for path resolution — on-the-fly outlines may fail");
      }

      // Initialize embeddings in background (non-blocking)
      let defaultEmbeddingsConfig: EmbeddingsConfig | null = null;
      try {
        defaultEmbeddingsConfig = resolveEmbeddingsConfig(graphJsonPath);
      } catch { /* no embeddings config */ }

      if (defaultEmbeddingsConfig) {
        const eConfig = defaultEmbeddingsConfig;
        const defaultCacheDir = "~/.cache/reponova/models";
        import("./tools/similar.js").then(({ initSimilaritySearch }) =>
          initSimilaritySearch(graphDir, eConfig, defaultCacheDir)
        ).catch(() => {});
        import("./tools/context.js").then(({ initContextBuilder }) =>
          initContextBuilder(db, graphDir, eConfig, defaultCacheDir)
        ).catch(() => {});
      }

      this.cachedMtimeMs = this.getGraphJsonMtime(graphJsonPath);
      this.resources = { db, graphDir, graphJsonPath, resolvePaths };

      log.info(`Graph loaded: ${graphDir}`);
      return this.resources;
    } catch (err) {
      log.error(`Failed to load resources: ${errorMessage(err)}`);
      return null;
    }
  }

  async dispose(): Promise<void> {
    if (this.resources) {
      try {
        const { disposeSimilaritySearch } = await import("./tools/similar.js");
        const { disposeContextBuilder } = await import("./tools/context.js");
        await disposeSimilaritySearch();
        await disposeContextBuilder();
        this.resources.db.close();
      } catch { /* ignore */ }
      this.resources = null;
    }
  }
}

// ─── Server Entry Point ──────────────────────────────────────────────────────

export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  // --- Phase 1: Connect transport IMMEDIATELY (no validation, no crash) ---
  const server = new Server(
    { name: "reponova", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("reponova MCP server running on stdio");

  // --- Phase 2: Try loading resources (non-blocking, no crash) ---
  const resourceManager = new ResourceManager(options.graphPath);
  // Fire initial load attempt — does not block, does not crash
  resourceManager.tryInitialLoad().catch(() => {});

  // --- Phase 3: Register handlers ---

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "graph_search", description: "Full-text search on knowledge graph nodes with optional BFS/DFS context expansion.", inputSchema: { type: "object" as const, properties: { query: { type: "string", description: "Search text" }, top_k: { type: "number", description: "Max results (default: 10)" }, repo: { type: "string", description: "Filter by repo" }, type: { type: "string", description: "Filter by type: function, class, module, all" }, context_depth: { type: "number", description: "BFS/DFS expansion depth from results (0 = no expansion, default: 0)" }, context_mode: { type: "string", description: "Expansion mode: bfs (broad context) or dfs (trace path). Default: bfs" } }, required: ["query"] } },
      { name: "graph_impact", description: "Blast radius analysis: what depends on a symbol and what it depends on.", inputSchema: { type: "object" as const, properties: { symbol: { type: "string", description: "Symbol name" }, direction: { type: "string", description: "upstream, downstream, or both" }, max_depth: { type: "number", description: "Max BFS depth (default: 3)" }, include_tests: { type: "boolean", description: "Include tests (default: false)" } }, required: ["symbol"] } },
      { name: "graph_outline", description: "Compressed file outline: signatures, decorators, docstrings.", inputSchema: { type: "object" as const, properties: { file_path: { type: "string", description: "Relative file path" }, format: { type: "string", description: "markdown or json" } }, required: ["file_path"] } },
      { name: "graph_path", description: "Shortest path between two nodes in the knowledge graph.", inputSchema: { type: "object" as const, properties: { from: { type: "string", description: "Source node" }, to: { type: "string", description: "Target node" }, max_depth: { type: "number", description: "Max depth (default: 10)" }, edge_types: { type: "array", items: { type: "string" }, description: "Edge types to traverse" } }, required: ["from", "to"] } },
      { name: "graph_explain", description: "Complete detail of a node: properties, relationships, centrality.", inputSchema: { type: "object" as const, properties: { symbol: { type: "string", description: "Node name or ID" }, include_code: { type: "boolean", description: "Include file outline" } }, required: ["symbol"] } },
      { name: "graph_community", description: "List all nodes belonging to a specific community.", inputSchema: { type: "object" as const, properties: { community_id: { type: "string", description: "Community ID or name" } }, required: ["community_id"] } },
      { name: "graph_hotspots", description: "Most connected nodes in the graph (god nodes / architectural hotspots).", inputSchema: { type: "object" as const, properties: { top_n: { type: "number", description: "Number of results (default: 10)" }, metric: { type: "string", description: "Ranking metric: degree, in_degree, out_degree, betweenness (default: degree)" } } } },
      { name: "graph_similar", description: "Semantic similarity search — find nodes conceptually similar to a query.", inputSchema: { type: "object" as const, properties: { query: { type: "string", description: "Natural language query or symbol name" }, top_k: { type: "number", description: "Max results (default: 10)" }, type: { type: "string", description: "Filter by type: function, class, module" }, repo: { type: "string", description: "Filter by repo" } }, required: ["query"] } },
      { name: "graph_context", description: "Smart context builder — returns token-budgeted, relevance-ranked context for any query. Combines text search, vector similarity, graph expansion, and community summaries.", inputSchema: { type: "object" as const, properties: { query: { type: "string", description: "Natural language query or code reference" }, max_tokens: { type: "number", description: "Token budget (default: 4096)" }, scope: { type: "string", description: "Repo name or path prefix filter" }, include_source: { type: "boolean", description: "Include source code snippets (default: false)" }, format: { type: "string", description: "Output format: 'narrative' (markdown) or 'structured' (JSON). Default: narrative" } }, required: ["query"] } },
      { name: "graph_docs", description: "Search documentation nodes (markdown, text, rst) with linked code references.", inputSchema: { type: "object" as const, properties: { query: { type: "string", description: "Search text" }, top_k: { type: "number", description: "Max results (default: 10)" }, repo: { type: "string", description: "Filter by repo" } }, required: ["query"] } },
      { name: "graph_status", description: "Graph status: metadata, counts, repos.", inputSchema: { type: "object" as const, properties: {} } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const { db, graphDir: gDir, graphJsonPath: gjPath, resolvePaths: rp } = await resourceManager.getResources();

      switch (name) {
        case "graph_search": {
          const { handleSearch } = await import("./tools/search.js");
          return await handleSearch(db, args as Record<string, unknown>, rp);
        }
        case "graph_impact": {
          const { handleImpact } = await import("./tools/impact.js");
          return await handleImpact(db, args as Record<string, unknown>, rp);
        }
        case "graph_outline": {
          const { handleOutline } = await import("./tools/outline.js");
          return await handleOutline(db, gDir, args as Record<string, unknown>, rp);
        }
        case "graph_path": {
          const { handlePath } = await import("./tools/path.js");
          return await handlePath(db, args as Record<string, unknown>, rp);
        }
        case "graph_explain": {
          const { handleExplain } = await import("./tools/explain.js");
          return await handleExplain(db, gDir, args as Record<string, unknown>, rp);
        }
        case "graph_community": {
          const { handleCommunity } = await import("./tools/community.js");
          return await handleCommunity(db, gDir, args as Record<string, unknown>, rp);
        }
        case "graph_hotspots": {
          const { handleHotspots } = await import("./tools/hotspots.js");
          return await handleHotspots(db, args as Record<string, unknown>, rp);
        }
        case "graph_similar": {
          const { handleSimilar } = await import("./tools/similar.js");
          return await handleSimilar(db, args as Record<string, unknown>, rp);
        }
        case "graph_context": {
          const { handleContext } = await import("./tools/context.js");
          return await handleContext(db, gDir, args as Record<string, unknown>, rp);
        }
        case "graph_docs": {
          const { handleDocs } = await import("./tools/docs.js");
          return await handleDocs(db, args as Record<string, unknown>, rp);
        }
        case "graph_status": {
          const { handleStatus } = await import("./tools/status.js");
          return await handleStatus(db, gDir, gjPath);
        }
        default: return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${errorMessage(error)}` }], isError: true };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "graph://status", name: "Graph Status", description: "Current graph metadata", mimeType: "text/plain" }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "graph://status") {
      try {
        const { db, graphDir: gDir, graphJsonPath: gjPath } = await resourceManager.getResources();
        const { handleStatus } = await import("./tools/status.js");
        const result = handleStatus(db, gDir, gjPath);
        return { contents: [{ uri: request.params.uri, text: result.content[0]?.text ?? "", mimeType: "text/plain" }] };
      } catch (error) {
        return { contents: [{ uri: request.params.uri, text: `Error: ${errorMessage(error)}`, mimeType: "text/plain" }] };
      }
    }
    return { contents: [{ uri: request.params.uri, text: "Not found", mimeType: "text/plain" }] };
  });

  const shutdown = async () => {
    await resourceManager.dispose();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
