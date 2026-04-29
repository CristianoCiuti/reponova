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
import { log } from "../shared/utils.js";

export interface McpServerOptions {
  graphPath?: string;
}

export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  const graphDir = resolveGraphPath(options.graphPath);
  if (!graphDir) {
    log.error("Could not find graphify-out directory. Use --graph flag, set GRAPHIFY_GRAPH_PATH, or run from a directory containing graphify-out/.");
    process.exit(1);
  }

  const dbPath = resolveSearchDb(graphDir);
  if (!dbPath) {
    log.error(`Search database not found in ${graphDir}. Run 'graphify-mcp-tools index' first.`);
    process.exit(1);
  }

  const graphJsonPath = resolveGraphJson(graphDir);
  const db = await openDatabase(dbPath, { readonly: true });

  const server = new Server(
    { name: "graphify-mcp-tools", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "graph_search", description: "BM25 full-text search on knowledge graph nodes.", inputSchema: { type: "object" as const, properties: { query: { type: "string", description: "Search text" }, top_k: { type: "number", description: "Max results (default: 10)" }, repo: { type: "string", description: "Filter by repo" }, type: { type: "string", description: "Filter by type: function, class, module, all" } }, required: ["query"] } },
      { name: "graph_impact", description: "Blast radius analysis: what depends on a symbol and what it depends on.", inputSchema: { type: "object" as const, properties: { symbol: { type: "string", description: "Symbol name" }, direction: { type: "string", description: "upstream, downstream, or both" }, max_depth: { type: "number", description: "Max BFS depth (default: 3)" }, include_tests: { type: "boolean", description: "Include tests (default: false)" } }, required: ["symbol"] } },
      { name: "graph_outline", description: "Compressed file outline: signatures, decorators, docstrings.", inputSchema: { type: "object" as const, properties: { file_path: { type: "string", description: "Relative file path" }, format: { type: "string", description: "markdown or json" } }, required: ["file_path"] } },
      { name: "graph_path", description: "Shortest path between two nodes in the knowledge graph.", inputSchema: { type: "object" as const, properties: { from: { type: "string", description: "Source node" }, to: { type: "string", description: "Target node" }, max_depth: { type: "number", description: "Max depth (default: 10)" }, edge_types: { type: "array", items: { type: "string" }, description: "Edge types to traverse" } }, required: ["from", "to"] } },
      { name: "graph_explain", description: "Complete detail of a node: properties, relationships, centrality.", inputSchema: { type: "object" as const, properties: { symbol: { type: "string", description: "Node name or ID" }, include_code: { type: "boolean", description: "Include file outline" } }, required: ["symbol"] } },
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
  log.info("graphify-mcp-tools MCP server running on stdio");

  process.on("SIGINT", async () => { db.close(); await server.close(); process.exit(0); });
  process.on("SIGTERM", async () => { db.close(); await server.close(); process.exit(0); });
}
