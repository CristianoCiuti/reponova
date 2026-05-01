import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { openDatabase } from "../core/db.js";
import { resolveGraphPath, resolveSearchDb, resolveGraphJson } from "../core/graph-resolver.js";
import { handleSearch } from "./tools/search.js";
import { handleImpact } from "./tools/impact.js";
import { handleOutline } from "./tools/outline.js";
import { handlePath } from "./tools/path.js";
import { handleExplain } from "./tools/explain.js";
import { handleStatus } from "./tools/status.js";
import { handleCommunity } from "./tools/community.js";
import { handleHotspots } from "./tools/hotspots.js";
import { handleSimilar, initSimilaritySearch, disposeSimilaritySearch } from "./tools/similar.js";
import { handleContext, initContextBuilder, disposeContextBuilder } from "./tools/context.js";
import { handleAsk } from "./tools/ask.js";
import { handleDocs } from "./tools/docs.js";
import { log } from "../shared/utils.js";

export interface McpServerOptions {
  graphPath?: string;
}

export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  const graphDir = resolveGraphPath(options.graphPath);
  if (!graphDir) {
    log.error("Could not find reponova-out directory. Use --graph flag, set REPONOVA_GRAPH_PATH, or run from a directory containing reponova-out/.");
    process.exit(1);
  }

  const dbPath = resolveSearchDb(graphDir);
  if (!dbPath) {
    log.error(`Search database not found in ${graphDir}. Run 'reponova index' first.`);
    process.exit(1);
  }

  const graphJsonPath = resolveGraphJson(graphDir);
  const db = await openDatabase(dbPath, { readonly: true });

  // Initialize similarity search (best-effort, non-blocking)
  const defaultEmbeddingsConfig = { enabled: true, method: "tfidf" as const, model: "all-MiniLM-L6-v2", dimensions: 384, batch_size: 128, cache_dir: "~/.cache/reponova/models" };
  initSimilaritySearch(graphDir, defaultEmbeddingsConfig).catch(() => {
    // Silently degrade — graph_similar will return appropriate error
  });

  // Initialize context builder (best-effort, non-blocking)
  initContextBuilder(db, graphDir, defaultEmbeddingsConfig).catch(() => {
    // Silently degrade — graph_context will lazy-init without embeddings
  });

  const server = new Server(
    { name: "reponova", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

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
      { name: "graph_ask", description: "Natural language question about the codebase — automatically routes to the best strategy (search, impact, path, explain, similar, or context).", inputSchema: { type: "object" as const, properties: { question: { type: "string", description: "Natural language question (English or Italian)" }, max_tokens: { type: "number", description: "Max response tokens (default: 2048)" } }, required: ["question"] } },
      { name: "graph_docs", description: "Search documentation nodes (markdown, text, rst) with linked code references.", inputSchema: { type: "object" as const, properties: { query: { type: "string", description: "Search text" }, top_k: { type: "number", description: "Max results (default: 10)" }, repo: { type: "string", description: "Filter by repo" } }, required: ["query"] } },
      { name: "graph_status", description: "Graph status: metadata, counts, repos.", inputSchema: { type: "object" as const, properties: {} } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case "graph_search": return handleSearch(db, args as Record<string, unknown>);
        case "graph_impact": return handleImpact(db, args as Record<string, unknown>);
        case "graph_outline": return handleOutline(db, graphDir, args as Record<string, unknown>);
        case "graph_path": return handlePath(db, args as Record<string, unknown>);
        case "graph_explain": return handleExplain(db, graphDir, args as Record<string, unknown>);
        case "graph_community": return handleCommunity(db, args as Record<string, unknown>);
        case "graph_hotspots": return handleHotspots(db, args as Record<string, unknown>);
        case "graph_similar": return await handleSimilar(db, args as Record<string, unknown>);
        case "graph_context": return await handleContext(db, graphDir, args as Record<string, unknown>);
        case "graph_ask": return await handleAsk(db, graphDir, args as Record<string, unknown>);
        case "graph_docs": return handleDocs(db, args as Record<string, unknown>);
        case "graph_status": return handleStatus(db, graphDir, graphJsonPath);
        default: return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "graph://status", name: "Graph Status", description: "Current graph metadata", mimeType: "text/plain" }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "graph://status") {
      const result = handleStatus(db, graphDir, graphJsonPath);
      return { contents: [{ uri: request.params.uri, text: result.content[0]?.text ?? "", mimeType: "text/plain" }] };
    }
    return { contents: [{ uri: request.params.uri, text: "Not found", mimeType: "text/plain" }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("reponova MCP server running on stdio");

  process.on("SIGINT", async () => { await disposeSimilaritySearch(); await disposeContextBuilder(); db.close(); await server.close(); process.exit(0); });
  process.on("SIGTERM", async () => { await disposeSimilaritySearch(); await disposeContextBuilder(); db.close(); await server.close(); process.exit(0); });
}
