import { toPosix } from "../../shared/paths.js";
import type { GraphNode, GraphData } from "../../shared/types.js";

export interface NodeDescription {
  id: string;
  description: string;
}

export interface CommunitySummary {
  id: string;
  label: string;
  nodeCount: number;
  summary: string;
  hub_nodes: string[];
  primary_path: string;
  repos: string[];
}

export interface CommunityData {
  id: string;
  nodes: GraphNode[];
}

export function computeEdgeCounts(graphData: GraphData): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of graphData.edges) {
    counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
  }
  return counts;
}

export function selectTargetNodes(nodes: GraphNode[], edgeCounts: Map<string, number>, threshold: number): GraphNode[] {
  const sorted = [...edgeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const cutoff = Math.ceil(sorted.length * (1 - threshold));
  const topNodeIds = new Set(sorted.slice(0, cutoff).map(([id]) => id));
  return nodes.filter((n) => topNodeIds.has(n.id));
}

export function algorithmicDescription(node: GraphNode, degree: number): string {
  const typeLabel = node.type.charAt(0).toUpperCase() + node.type.slice(1);
  const location = node.source_file ? ` in ${node.source_file}` : "";
  return `${typeLabel} with ${degree} connections${location}.`;
}

export function buildCommunityData(graphData: GraphData, maxCommunities: number): CommunityData[] {
  const communityMap = new Map<string, GraphNode[]>();
  for (const node of graphData.nodes) {
    const communityId = node.community != null ? String(node.community) : "unclustered";
    if (!communityMap.has(communityId)) communityMap.set(communityId, []);
    communityMap.get(communityId)!.push(node);
  }

  const communities: CommunityData[] = [];
  for (const [id, nodes] of communityMap) {
    if (id === "unclustered" || nodes.length < 3) continue;
    communities.push({ id, nodes });
  }

  communities.sort((a, b) => b.nodes.length - a.nodes.length || String(a.id).localeCompare(String(b.id)));
  return maxCommunities > 0 ? communities.slice(0, maxCommunities) : communities;
}

export function findHubs(nodes: GraphNode[]): GraphNode[] {
  const priority: Record<string, number> = { class: 3, module: 2, function: 1, method: 0 };
  return [...nodes].sort((a, b) => (priority[b.type] ?? 0) - (priority[a.type] ?? 0)).slice(0, 5);
}

export function findPrimaryPath(nodes: GraphNode[]): string {
  const paths = nodes.filter((n) => n.source_file).map((n) => n.source_file!);
  if (paths.length === 0) return "(unknown)";

  const dirs = paths.map((p) => toPosix(p).split("/").slice(0, -1).join("/"));
  const counts = new Map<string, number>();
  for (const dir of dirs) {
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }

  let maxDir = "";
  let maxCount = 0;
  for (const [dir, count] of counts) {
    if (count > maxCount) {
      maxDir = dir;
      maxCount = count;
    }
  }

  return maxDir || toPosix(paths[0] ?? "").split("/").slice(0, -1).join("/");
}

export function buildAlgorithmicSummary(nodeCount: number, hubs: GraphNode[], primaryPath: string, repos: string[]): string {
  const hubNames = hubs.slice(0, 3).map((n) => n.label).join(", ");
  const repoStr = repos.length > 0 ? ` Spans ${repos.join(", ")}.` : "";
  return `${nodeCount} nodes cluster. Centered around ${hubNames} in ${primaryPath}.${repoStr}`;
}
