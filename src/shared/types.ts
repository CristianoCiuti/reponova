/**
 * Shared types for reponova
 */

/** A node in the knowledge graph */
export interface GraphNode {
  id: string;
  label: string;
  type: string;
  source_file?: string;
  repo?: string;
  community?: string;
  start_line?: number;
  end_line?: number;
  /** Function/method signature extracted from AST */
  signature?: string;
  /** Docstring extracted from AST */
  docstring?: string;
  /** Base classes (for class nodes) */
  bases?: string[];
  properties?: Record<string, unknown>;
}

/** An edge in the knowledge graph */
export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  confidence?: number;
  properties?: Record<string, unknown>;
}

/** Community detected by community detection */
export interface GraphCommunity {
  id: string;
  name: string;
  members: string[];
  size: number;
}

/** Full graph structure */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities?: GraphCommunity[];
  metadata?: GraphMetadata;
}

/** Graph metadata */
export interface GraphMetadata {
  reponova_version?: string;
  built_at?: string;
  /** Relative path from graphDir to configDir (for reconstructing repo absolute paths) */
  config_dir?: string;
  /** Repo mappings — name + path relative to configDir (as in the YAML config) */
  repos?: Array<{ name: string; path: string }>;
  /** single = 1 repo (no prefix on source_file), multi = N repos (repo prefix on source_file) */
  mode?: "single" | "multi";
  node_count?: number;
  edge_count?: number;
  /** Runtime build config summary — used by MCP server, check, and status */
  build_config?: BuildConfigFingerprint;
}

/**
 * Minimal build config fingerprint stored in graph.json metadata.
 * Contains only what the MCP runtime needs (embeddings config,
 * feature enabled flags).
 */
export interface BuildConfigFingerprint {
  embeddings: {
    enabled: boolean;
    provider?: string;
  };
  outlines: { enabled: boolean };
  enrich: { enabled: boolean };
}

/** Adjacency map for BFS/Dijkstra */
export interface AdjacencyMap {
  /** node_id → list of outgoing edges */
  outgoing: Map<string, AdjacencyEntry[]>;
  /** node_id → list of incoming edges */
  incoming: Map<string, AdjacencyEntry[]>;
}

export interface AdjacencyEntry {
  nodeId: string;
  edgeType: string;
  weight: number;
}

/**
 * Configuration file schema — flat, no more BuildConfig wrapper.
 * All build-related fields are at the root level.
 */
export interface Config {
  output: string;
  repos: RepoConfig[];
  models: ModelsConfig;
  providers: Record<string, ProviderConfig>;
  /** Glob patterns for source code files (empty = auto-detect) */
  patterns: string[];
  /** Glob patterns to exclude from source code detection */
  exclude: string[];
  /** Exclude common non-source directories (node_modules, venv, .git, etc.) */
  exclude_common: boolean;
  /** Enable incremental builds */
  incremental: boolean;
  docs: DocsConfig;
  images: ImagesConfig;
  embeddings: EmbeddingsConfig;
  enrich: EnrichConfig;
  /** Generate interactive HTML visualizations */
  html: boolean;
  /** Minimum node degree to include in HTML visualization */
  html_min_degree?: number;
  outlines: OutlineConfig;
  server: ServerConfig;
}

export interface RepoConfig {
  name: string;
  path: string;
}

/** Centralized model management */
export interface ModelsConfig {
  cache_dir: string;
  gpu: "auto" | "cpu" | "cuda" | "metal" | "vulkan";
  threads: number;
  download_on_first_use: boolean;
}

export interface DocsConfig {
  enabled: boolean;
  patterns: string[];
  exclude: string[];
  max_file_size_kb: number;
}

export interface ImagesConfig {
  enabled: boolean;
  patterns: string[];
  exclude: string[];
  parse_puml: boolean;
  parse_svg_text: boolean;
}

export type ProviderType = "openai" | "llama-cpp" | "onnx";

export interface ProviderConfig {
  type: ProviderType;
  model?: string;
  base_url?: string;
  api_key?: string;
  timeout?: number;
  context_size?: number;
}

export interface EmbeddingsConfig {
  enabled: boolean;
  provider?: string;
  batch_size: number;
}

export interface EnrichConfig {
  enabled: boolean;
  provider?: string;
  threshold: number;
  max_communities: number;
  candidate_threshold: number;
  description_batch_tokens: number;
  routing_batch_size: number;
  concurrency: number;
  max_retry_depth: number;
}

/** Outline config — simplified. File selection comes from top-level patterns. */
export interface OutlineConfig {
  enabled: boolean;
}

export interface ServerConfig {
  [key: string]: unknown;
}

/** Search result */
export interface SearchResult {
  id: string;
  label: string;
  type: string;
  source_file?: string;
  repo?: string;
  community?: string;
  rank: number;
  properties?: Record<string, unknown>;
}

/** Impact analysis result */
export interface ImpactResult {
  target: GraphNode;
  upstream: ImpactLayer[];
  downstream: ImpactLayer[];
  cross_repo_summary: Map<string, number>;
}

export interface ImpactLayer {
  depth: number;
  nodes: ImpactNode[];
}

export interface ImpactNode {
  id: string;
  label: string;
  source_file?: string;
  repo?: string;
  edge_type: string;
  via?: string;
}

/** Shortest path result */
export interface PathResult {
  found: boolean;
  from: string;
  to: string;
  hops: number;
  path: PathStep[];
  cross_repo?: string;
  edge_types_used?: Map<string, number>;
}

export interface PathStep {
  node_id: string;
  label: string;
  source_file?: string;
  edge_type?: string;
}

export interface ContextCandidate {
  id: string;
  label: string;
  type: string;
  source_file?: string;
  repo?: string;
  community?: string;
  score: number;
  signature?: string;
  docstring?: string;
  graph_rel_path?: string | null;
  absolute_path?: string | null;
}

export interface RelationshipEntry {
  from: string;
  to: string;
  edge_type: string;
  from_label?: string;
  to_label?: string;
}

export interface CommunitySummaryEntry {
  community_id: string;
  label: string;
  summary: string;
}

export interface SourceSnippet {
  file: string;
  start_line: number;
  end_line: number;
  content: string;
}

export interface StructuredContext {
  candidates: ContextCandidate[];
  relationships: RelationshipEntry[];
  communities: CommunitySummaryEntry[];
  source_snippets: SourceSnippet[];
}

/** Node detail result */
export interface NodeDetail {
  id: string;
  label: string;
  type: string;
  source_file?: string;
  repo?: string;
  community?: string;
  signature?: string;
  decorators?: string[];
  docstring?: string;
  start_line?: number;
  end_line?: number;
  outgoing_edges: GroupedEdges;
  incoming_edges: GroupedEdges;
  centrality: CentralityMetrics;
}

export interface GroupedEdges {
  [edgeType: string]: EdgeDetail[];
}

export interface EdgeDetail {
  node_id: string;
  label: string;
  source_file?: string;
  repo?: string;
  is_cross_repo?: boolean;
  is_external?: boolean;
}

export interface CentralityMetrics {
  in_degree: number;
  out_degree: number;
  betweenness: number;
}

/** Outline structures */
export interface FileOutline {
  file_path: string;
  line_count: number;
  imports: ImportEntry[];
  functions: FunctionEntry[];
  classes: ClassEntry[];
}

export interface ImportEntry {
  module: string;
  names?: string[];
  line: number;
}

export interface FunctionEntry {
  name: string;
  signature: string;
  decorators: string[];
  docstring?: string;
  start_line: number;
  end_line: number;
  calls: string[];
}

export interface ClassEntry {
  name: string;
  bases: string[];
  docstring?: string;
  start_line: number;
  end_line: number;
  methods: FunctionEntry[];
}

/** Edge type weights for Dijkstra */
export const DEFAULT_EDGE_WEIGHTS: Record<string, number> = {
  calls: 1.0,
  imports: 0.5,
  imports_from: 0.5,
  extends: 0.8,
  contains: 0.3,
  references: 0.4,
};

/** Default config values */
export const DEFAULT_CONFIG: Config = {
  output: "reponova-out",
  repos: [],
  models: {
    cache_dir: "~/.cache/reponova/models",
    gpu: "auto",
    threads: 0,
    download_on_first_use: true,
  },
  providers: {},
  patterns: [],
  exclude: [],
  exclude_common: true,
  incremental: true,
  html: true,
  docs: {
    enabled: true,
    patterns: [],
    exclude: [],
    max_file_size_kb: 500,
  },
  images: {
    enabled: true,
    patterns: [],
    exclude: [],
    parse_puml: true,
    parse_svg_text: true,
  },
  embeddings: {
    enabled: true,
    batch_size: 128,
  },
  enrich: {
    enabled: true,
    threshold: 0.8,
    max_communities: 0,
    candidate_threshold: 0.3,
    description_batch_tokens: 40000,
    routing_batch_size: 30,
    concurrency: 4,
    max_retry_depth: 3,
  },
  outlines: {
    enabled: true,
  },
  server: {},
};
