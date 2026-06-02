/**
 * reponova
 *
 * Knowledge graph builder & MCP server for AI code assistants:
 * search, impact analysis, and code outlines from knowledge graphs.
 */

export { startMcpServer } from "./mcp/server.js";
export { loadConfig } from "./shared/config.js";
export { openDatabase, initializeSchema, populateDatabase, saveDatabase, getMeta, queryAll, queryOne } from "./query/db.js";
export type { Database } from "./query/db.js";
export { loadGraphData, buildAdjacencyMap, buildNodeMap } from "./graph/loader.js";
export { searchNodes, fuzzyMatchNode } from "./query/search.js";
export { analyzeImpact, formatImpactMarkdown } from "./query/impact.js";
export { findShortestPath, formatPathMarkdown } from "./query/shortest-path.js";
export { getNodeDetail, getNodeSuggestions, formatNodeDetailMarkdown } from "./query/node-detail.js";
export { resolveGraphPath, resolveGraphJson, resolveSearchDb } from "./shared/graph-resolver.js";
export { resolveAbsolutePath, reconstructRepos, resolveOutlinePath, createPatternMatcher, buildSkipDirs } from "./shared/path-resolver.js";
export type { RepoMapping, PathContext } from "./shared/path-resolver.js";

// Intelligence layer exports
export { EmbeddingEngine, composeNodeText } from "./intelligence/embeddings.js";
export { VectorStore } from "./query/vector-store.js";

export { ContextBuilder } from "./query/context-builder.js";
export { ProviderRegistry } from "./intelligence/provider-registry.js";
export type { LlmProvider, LlmCompletionOptions, EmbeddingProvider } from "./intelligence/llm-provider.js";

// Extraction layer exports
export { registerExtractor } from "./extract/languages/registry.js";
export type { LanguageExtractor, FileExtraction, SyntaxTree, SyntaxNode, FileNodeDeclaration, SymbolNode, ImportDeclaration, SymbolReference } from "./extract/types.js";

// Outline layer exports
export { registerOutlineLanguage } from "./outline/languages/registry.js";
export type { LanguageSupport } from "./outline/languages/types.js";

// Plugin layer exports
export type { LanguagePlugin } from "./plugin/types.js";
export { discoverLanguagePlugins, loadDeclaredPlugins, getDiscoveredPlugins, resolvePluginPackage } from "./plugin/discovery.js";
export { registerGrammarPath, resolveGrammarPath } from "./plugin/grammar-registry.js";

// Build API
export { build } from "./pipeline/build.js";
export type { BuildResult } from "./pipeline/engine/orchestrator.js";

export type {
  GraphNode,
  GraphEdge,
  GraphData,
  GraphCommunity,
  Config,
  ModelsConfig,
  EnrichConfig,
  EmbeddingsConfig,
  ProviderConfig,
  ProviderType,
  SearchResult,
  ImpactResult,
  PathResult,
  NodeDetail,
  FileOutline,
} from "./shared/types.js";

export type {
  ContextParams,
  ContextResult,
} from "./query/context-builder.js";
