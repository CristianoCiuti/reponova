/**
 * Shared types for graphify-mcp-tools
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

/** Community detected by Graphify */
export interface GraphCommunity {
  id: string | number;
  name: string;
  members: string[];
  size: number;
}

/** Full graph structure as produced by Graphify */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities?: GraphCommunity[];
  metadata?: GraphMetadata;
}

/** Graph metadata */
export interface GraphMetadata {
  graphify_version?: string;
  built_at?: string;
  repos?: string[];
  node_count?: number;
  edge_count?: number;
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

/** Configuration file schema */
export interface Config {
  output: string;
  repos: RepoConfig[];
  build: BuildConfig;
  outlines: OutlineConfig;
  server: ServerConfig;
}

export interface RepoConfig {
  name: string;
  path: string;
}

export interface BuildConfig {
  html: boolean;
  html_min_degree?: number;
  html_community_fallback: boolean;
  exclude: string[];
  mode: "monorepo" | "separate";
  incremental: boolean;
  docs: DocsConfig;
  images: ImagesConfig;
  embeddings: EmbeddingsConfig;
  llm: LlmConfig;
  summaries: SummariesConfig;
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

export interface EmbeddingsConfig {
  enabled: boolean;
  model: string;
  dimensions: number;
  batch_size: number;
  cache_dir: string;
}

export interface LlmConfig {
  enabled: boolean;
  model: string;
  quantization: string;
  gpu: "auto" | "cpu" | "cuda" | "metal" | "vulkan";
  context_size: number;
  threads: number;
  download_on_first_use: boolean;
  cache_dir: string;
}

export interface SummariesConfig {
  enabled: boolean;
  generate_node_descriptions: boolean;
  node_description_threshold: number;
}

export interface OutlineConfig {
  enabled: boolean;
  paths: string[];
  exclude: string[];
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
  CALLS: 1.0,
  IMPORTS: 0.5,
  EXTENDS: 0.8,
  MEMBER_OF: 0.3,
};

/** Default config values */
export const DEFAULT_CONFIG: Config = {
  output: "graphify-out",
  repos: [],
  build: {
    html: true,
    html_community_fallback: true,
    exclude: [],
    mode: "monorepo",
    incremental: true,
    docs: {
      enabled: true,
      patterns: ["**/*.md", "**/*.txt", "**/*.rst"],
      exclude: ["**/CHANGELOG.md", "**/node_modules/**"],
      max_file_size_kb: 500,
    },
    images: {
      enabled: true,
      patterns: ["**/*.puml", "**/*.plantuml", "**/*.svg"],
      exclude: ["**/node_modules/**"],
      parse_puml: true,
      parse_svg_text: true,
    },
    embeddings: {
      enabled: true,
      model: "all-MiniLM-L6-v2",
      dimensions: 384,
      batch_size: 128,
      cache_dir: "~/.cache/graphify-mcp-tools/models",
    },
    llm: {
      enabled: true,
      model: "qwen2.5-3b-instruct",
      quantization: "Q4_K_M",
      gpu: "auto",
      context_size: 4096,
      threads: 0,
      download_on_first_use: true,
      cache_dir: "~/.cache/graphify-mcp-tools/models",
    },
    summaries: {
      enabled: true,
      generate_node_descriptions: true,
      node_description_threshold: 0.8,
    },
  },
  outlines: {
    enabled: true,
    paths: ["src/**/*.ts", "src/**/*.py", "src/**/*.js"],
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
  },
  server: {},
};
