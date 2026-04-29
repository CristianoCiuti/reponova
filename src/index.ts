/**
 * graphify-mcp-tools
 *
 * MCP server companion for Graphify: search, impact analysis,
 * and code outlines from knowledge graphs.
 */

export { startMcpServer } from "./mcp/server.js";
export { loadConfig } from "./core/config.js";
export { openDatabase, initializeSchema, populateDatabase, saveDatabase, getMeta, queryAll, queryOne } from "./core/db.js";
export type { Database } from "./core/db.js";
export { loadGraphData, buildAdjacencyMap, buildNodeMap } from "./core/graph-loader.js";
export { searchNodes, fuzzyMatchNode } from "./core/search.js";
export { analyzeImpact, formatImpactMarkdown } from "./core/impact.js";
export { findShortestPath, formatPathMarkdown } from "./core/shortest-path.js";
export { getNodeDetail, getNodeSuggestions, formatNodeDetailMarkdown } from "./core/node-detail.js";
export { resolveGraphPath, resolveGraphJson, resolveSearchDb } from "./core/graph-resolver.js";
export { fixPaths, fixGraphPaths } from "./core/path-fixer.js";

export type {
  GraphNode,
  GraphEdge,
  GraphData,
  GraphCommunity,
  Config,
  SearchResult,
  ImpactResult,
  PathResult,
  NodeDetail,
  FileOutline,
} from "./shared/types.js";
