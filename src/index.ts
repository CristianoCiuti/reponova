/**
 * reponova
 *
 * Knowledge graph builder & MCP server for AI code assistants:
 * search, impact analysis, and code outlines from knowledge graphs.
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
export { resolveAbsolutePath, reconstructRepos, resolveOutlinePath, createDualMatcher, stripRepoPrefix } from "./core/path-resolver.js";
export type { RepoMapping, PathContext } from "./core/path-resolver.js";

// Intelligence layer exports
export { EmbeddingEngine, composeNodeText } from "./build/embeddings.js";
export { VectorStore } from "./core/vector-store.js";
export { LlmEngine } from "./build/llm-engine.js";
export { SummaryGenerator } from "./build/community-summaries.js";
export { ContextBuilder } from "./core/context-builder.js";
export { classifyQuestion, registerLanguage, getRegisteredLanguages } from "./core/question-classifier.js";

// Extraction layer exports
export { registerExtractor } from "./extract/languages/registry.js";
export type { LanguageExtractor } from "./extract/types.js";

// Outline layer exports
export { registerOutlineLanguage } from "./outline/languages/registry.js";
export type { LanguageSupport } from "./outline/languages/types.js";

// Build API
export { build } from "./build/orchestrator.js";
export type { BuildResult } from "./build/orchestrator.js";

export type {
  GraphNode,
  GraphEdge,
  GraphData,
  GraphCommunity,
  Config,
  ModelsConfig,
  CommunitySummariesConfig,
  NodeDescriptionsConfig,
  SearchResult,
  ImpactResult,
  PathResult,
  NodeDetail,
  FileOutline,
  EmbeddingsConfig,
} from "./shared/types.js";

export type {
  ContextParams,
  ContextResult,
} from "./core/context-builder.js";

export type {
  QueryStrategy,
  ClassificationResult,
  LanguageRuleset,
  PatternRule,
} from "./core/question-classifier.js";
