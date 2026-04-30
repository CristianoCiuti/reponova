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
  graphify_args: string[];
  html: boolean;
  html_min_degree?: number;
  html_community_fallback: boolean;
  exclude: string[];
  mode: "monorepo" | "separate";
}

export interface OutlineConfig {
  enabled: boolean;
  /** @deprecated Auto-detected from file extension. Kept for backward compatibility. */
  language?: string;
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
    graphify_args: [],
    html: true,
    html_community_fallback: true,
    exclude: [],
    mode: "monorepo",
  },
  outlines: {
    enabled: true,
    paths: ["src/**/*.py"],
    exclude: ["**/__pycache__/**", "**/test_*.py", "**/.git/**"],
  },
  server: {},
};
