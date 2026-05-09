/**
 * JSON export — serializes graphology graph to graph.json format.
 *
 * Node fields: id, label, type, source_file, repo, community, start_line, end_line, properties
 * Edge fields: source, target, type/relation, confidence
 */
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteText } from "../shared/atomic-write.js";
import type Graph from "graphology";
import { relativePosix } from "../shared/paths.js";
import type { Config } from "../shared/types.js";
import { getVersion } from "../shared/utils.js";

export interface ExportJsonOptions {
  /** The graphology graph with community attributes */
  graph: Graph;
  /** Output file path */
  outputPath: string;
  /** Config (for metadata: repos, mode) */
  config?: Config;
  /** Config directory (for config_dir relative path in metadata) */
  configDir?: string;
  /** Output directory (for computing relative config_dir) */
  outputDir?: string;
}

interface JsonNode {
  id: string;
  label: string;
  type: string;
  file_type: string;
  source_file: string;
  source_location?: string;
  repo?: string;
  community: string;
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
  const { graph, outputPath, config, configDir, outputDir } = options;

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
      community: String(attrs.community ?? "0"),
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

    const data = {
    nodes,
    edges,
    metadata: {
      reponova_version: getVersion(),
      built_at: "",  // placeholder — resolved below
      // Path resolution metadata (relative paths for portability)
      ...(config && configDir && outputDir ? {
        config_dir: relativePosix(outputDir, configDir),
        repos: config.repos.map((r) => ({ name: r.name, path: r.path })),
        mode: config.repos.length === 1 ? "single" as const : "multi" as const,
      } : {}),
      // Runtime build config summary (used by MCP server, check, status)
      ...(config ? {
        build_config: {
          embeddings: {
            enabled: config.embeddings.enabled,
            method: config.embeddings.method,
            model: config.embeddings.model,
            dimensions: config.embeddings.dimensions,
          },
          outlines: { enabled: config.outlines.enabled },
          community_summaries: { enabled: config.community_summaries.enabled },
          node_descriptions: { enabled: config.node_descriptions.enabled },
        },
      } : {}),
    },
  };

  // Skip write if graph content hasn't changed (stable mtime for downstream steps).
  // Compare everything except built_at — if same, don't touch the file.
  if (existsSync(outputPath)) {
    try {
      const existing = readFileSync(outputPath, "utf-8");
      const parsed = JSON.parse(existing) as { metadata?: { built_at?: string } };
      const oldBuiltAt = parsed.metadata?.built_at;

      // Temporarily set same built_at for comparison
      data.metadata.built_at = oldBuiltAt ?? "";
      const newContent = JSON.stringify(data, null, 2);
      if (newContent === existing) return;

      // Content changed — use old timestamp only if we couldn't determine otherwise
      // Fall through to write with new timestamp
    } catch {
      // Can't read/parse existing file — proceed with fresh write
    }
  }

  data.metadata.built_at = new Date().toISOString();
  atomicWriteText(outputPath, JSON.stringify(data, null, 2));
}
