/**
 * JSON export — serializes graphology graph to graph.json format.
 *
 * Output format is backward-compatible with the existing graphify output:
 * loadGraphData() in src/core/graph-loader.ts handles both formats.
 *
 * Node fields: id, label, type, file_type, source_file, source_location,
 *              repo, community, norm_label, start_line, end_line
 * Edge fields: source, target, relation, confidence, confidence_score, weight
 */
import { writeFileSync } from "node:fs";
import type Graph from "graphology";
import type { CommunityResult } from "./community.js";

export interface ExportJsonOptions {
  /** The graphology graph with community attributes */
  graph: Graph;
  /** Community detection results */
  communities: CommunityResult;
  /** Output file path */
  outputPath: string;
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
  const { graph, outputPath } = options;

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

  const data = { nodes, edges };
  writeFileSync(outputPath, JSON.stringify(data, null, 2));
}
