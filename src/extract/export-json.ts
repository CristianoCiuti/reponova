/**
 * JSON export — serializes graphology graph to graph.json format.
 *
 * Node fields: id, label, type, source_file, repo, community, start_line, end_line, properties
 * Edge fields: source, target, type/relation, confidence
 */
import { writeFileSync } from "node:fs";
import type Graph from "graphology";
import type { CommunityResult } from "./community.js";
import type { Config } from "../shared/types.js";
import { getVersion } from "../shared/utils.js";

export interface ExportJsonOptions {
  /** The graphology graph with community attributes */
  graph: Graph;
  /** Community detection results */
  communities: CommunityResult;
  /** Output file path */
  outputPath: string;
  /** Build config (required for build_config fingerprint in metadata) */
  config?: Config;
}

interface JsonNode {
  id: string;
  label: string;
  type: string;
  file_type: string;
  source_file: string;
  source_location?: string;
  repo?: string;
  community: number;
  norm_label: string;
  start_line?: number;
  end_line?: number;
  docstring?: string;
  signature?: string;
  bases?: string[];
}

interface JsonEdge {
  source: string;
  target: string;
  relation: string;
  confidence: string;
  confidence_score: number;
  weight: number;
}

/**
 * Export graph to JSON format compatible with existing MCP tools.
 */
export function exportJson(options: ExportJsonOptions): void {
  const { graph, outputPath, config } = options;

  const nodes: JsonNode[] = [];
  const edges: JsonEdge[] = [];

  // Serialize nodes
  graph.forEachNode((nodeId, attrs) => {
    const node: JsonNode = {
      id: nodeId,
      label: (attrs.label as string) ?? nodeId,
      type: (attrs.type as string) ?? "unknown",
      file_type: (attrs.file_type as string) ?? "code",
      source_file: (attrs.source_file as string) ?? "",
      community: (attrs.community as number) ?? 0,
      norm_label: (attrs.norm_label as string) ?? ((attrs.label as string) ?? nodeId).toLowerCase(),
    };

    if (attrs.source_location) node.source_location = attrs.source_location as string;
    if (attrs.repo) node.repo = attrs.repo as string;
    if (attrs.start_line != null) node.start_line = attrs.start_line as number;
    if (attrs.end_line != null) node.end_line = attrs.end_line as number;
    if (attrs.docstring) node.docstring = attrs.docstring as string;
    if (attrs.signature) node.signature = attrs.signature as string;
    if (attrs.bases && Array.isArray(attrs.bases) && (attrs.bases as string[]).length > 0) {
      node.bases = attrs.bases as string[];
    }

    nodes.push(node);
  });

  // Serialize edges
  graph.forEachEdge((_edge, attrs, source, target) => {
    edges.push({
      source,
      target,
      relation: (attrs.relation as string) ?? "UNKNOWN",
      confidence: (attrs.confidence as string) ?? "EXTRACTED",
      confidence_score: (attrs.confidence_score as number) ?? 1.0,
      weight: (attrs.weight as number) ?? 1,
    });
  });

  // Build config fingerprint from config
  const buildConfig = config ? {
    embeddings: {
      enabled: config.build.embeddings.enabled,
      method: config.build.embeddings.method,
      model: config.build.embeddings.model,
      dimensions: config.build.embeddings.dimensions,
    },
    outlines: {
      enabled: config.outlines.enabled,
      paths: config.outlines.paths,
      exclude: config.outlines.exclude,
      exclude_common: config.build.exclude_common,
    },
    community_summaries: {
      enabled: config.build.community_summaries.enabled,
      max_number: config.build.community_summaries.max_number,
      model: config.build.community_summaries.model ?? null,
      context_size: config.build.community_summaries.context_size,
    },
    node_descriptions: {
      enabled: config.build.node_descriptions.enabled,
      threshold: config.build.node_descriptions.threshold,
      model: config.build.node_descriptions.model ?? null,
      context_size: config.build.node_descriptions.context_size,
    },
  } : undefined;

  const data = {
    nodes,
    edges,
    metadata: {
      reponova_version: getVersion(),
      built_at: new Date().toISOString(),
      build_config: buildConfig,
    },
  };
  writeFileSync(outputPath, JSON.stringify(data, null, 2));
}
