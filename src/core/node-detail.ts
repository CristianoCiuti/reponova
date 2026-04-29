import type { Database } from "./db.js";
import { queryAll, queryOne } from "./db.js";
import type { NodeDetail, GroupedEdges, EdgeDetail } from "../shared/types.js";
import { fuzzyMatchNode } from "./search.js";

/**
 * Get complete detail for a node.
 */
export function getNodeDetail(db: Database, symbol: string): NodeDetail | null {
  let nodeRow = queryOne(db, "SELECT id, label, type, source_file, repo, community, start_line, end_line, in_degree, out_degree, betweenness, properties FROM nodes WHERE id = ?", [symbol]);
  if (!nodeRow) {
    nodeRow = queryOne(db, "SELECT id, label, type, source_file, repo, community, start_line, end_line, in_degree, out_degree, betweenness, properties FROM nodes WHERE label = ?", [symbol]);
  }
  if (!nodeRow) return null;

  const props = nodeRow.properties ? (JSON.parse(nodeRow.properties as string) as Record<string, unknown>) : {};
  const outEdges = queryAll(db, "SELECT source_id, target_id, type FROM edges WHERE source_id = ?", [nodeRow.id as string]);
  const inEdges = queryAll(db, "SELECT source_id, target_id, type FROM edges WHERE target_id = ?", [nodeRow.id as string]);

  return {
    id: nodeRow.id as string,
    label: nodeRow.label as string,
    type: nodeRow.type as string,
    source_file: (nodeRow.source_file as string | null) ?? undefined,
    repo: (nodeRow.repo as string | null) ?? undefined,
    community: (nodeRow.community as string | null) ?? undefined,
    signature: props.signature as string | undefined,
    decorators: props.decorators as string[] | undefined,
    docstring: props.docstring as string | undefined,
    start_line: (nodeRow.start_line as number | null) ?? undefined,
    end_line: (nodeRow.end_line as number | null) ?? undefined,
    outgoing_edges: groupEdges(db, outEdges, "target", nodeRow.repo as string | null),
    incoming_edges: groupEdges(db, inEdges, "source", nodeRow.repo as string | null),
    centrality: { in_degree: nodeRow.in_degree as number, out_degree: nodeRow.out_degree as number, betweenness: nodeRow.betweenness as number },
  };
}

/**
 * Get suggestions for a not-found node.
 */
export function getNodeSuggestions(db: Database, symbol: string): string[] {
  const results = fuzzyMatchNode(db, symbol, 3);
  return results.map((r) => `${r.label} (${r.type}${r.source_file ? `, ${r.source_file}` : ""})`);
}

/**
 * Format node detail as markdown.
 */
export function formatNodeDetailMarkdown(detail: NodeDetail): string {
  const lines: string[] = [];
  lines.push(`## Node: ${detail.label}`, "");
  lines.push(`Type: ${detail.type}`);
  if (detail.source_file) {
    const lr = detail.start_line && detail.end_line ? `:${detail.start_line}-${detail.end_line}` : "";
    lines.push(`File: ${detail.source_file}${lr}`);
  }
  if (detail.repo) lines.push(`Repo: ${detail.repo}`);
  if (detail.community) lines.push(`Community: "${detail.community}"`);
  lines.push("");
  if (detail.signature) lines.push(`Signature: ${detail.signature}`);
  if (detail.decorators?.length) lines.push(`Decorators: ${detail.decorators.join(", ")}`);
  if (detail.docstring) lines.push(`Docstring: ${detail.docstring}`);
  lines.push("");

  for (const [et, edges] of Object.entries(detail.outgoing_edges)) {
    lines.push(`${et} (outgoing): ${edges.length}`);
    for (const e of edges) {
      const flags = [e.is_cross_repo && "cross-repo", e.is_external && "external"].filter(Boolean).join(", ");
      lines.push(`  ${e.label}${e.source_file ? ` (${e.source_file})` : ""}${flags ? ` [${flags}]` : ""}`);
    }
  }
  lines.push("");
  for (const [et, edges] of Object.entries(detail.incoming_edges)) {
    lines.push(`${et} (incoming): ${edges.length}`);
    for (const e of edges) lines.push(`  ${e.label}${e.source_file ? ` (${e.source_file})` : ""}`);
  }
  lines.push("", "Centrality:");
  lines.push(`  In-degree: ${detail.centrality.in_degree} | Out-degree: ${detail.centrality.out_degree} | Betweenness: ${detail.centrality.betweenness.toFixed(4)}`);
  return lines.join("\n");
}

function groupEdges(db: Database, edges: Record<string, unknown>[], direction: "source" | "target", currentRepo: string | null): GroupedEdges {
  const grouped: GroupedEdges = {};
  const cache = new Map<string, Record<string, unknown> | null>();

  for (const edge of edges) {
    const neighborId = (direction === "target" ? edge.target_id : edge.source_id) as string;
    if (!cache.has(neighborId)) cache.set(neighborId, queryOne(db, "SELECT id, label, source_file, repo FROM nodes WHERE id = ?", [neighborId]));
    const neighbor = cache.get(neighborId);

    const detail: EdgeDetail = {
      node_id: neighborId,
      label: (neighbor?.label as string) ?? neighborId,
      source_file: (neighbor?.source_file as string | null) ?? undefined,
      repo: (neighbor?.repo as string | null) ?? undefined,
      is_cross_repo: currentRepo != null && neighbor?.repo != null && (neighbor.repo as string) !== currentRepo,
      is_external: !neighbor?.source_file,
    };

    const et = edge.type as string;
    if (!grouped[et]) grouped[et] = [];
    grouped[et]!.push(detail);
  }
  return grouped;
}
