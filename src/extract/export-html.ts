/**
 * HTML export — standalone interactive visualization using vis-network.
 *
 * Generates node-level and community-level HTML visualizations with
 * community-based coloring and a stabilized fixed layout.
 */
import { writeFileSync } from "node:fs";
import type Graph from "graphology";
import type { CommunityResult } from "./community.js";

export interface ExportHtmlOptions {
  /** The graphology graph with community attributes */
  graph: Graph;
  /** Community detection results */
  communities: CommunityResult;
  /** Output file path */
  outputPath: string;
  /** Min degree to include (optional filter) */
  minDegree?: number;
}

interface VisNode {
  id: string;
  label: string;
  color: string;
  size: number;
  title: string;
}

interface VisEdge {
  from: string;
  to: string;
  label: string;
  color: string;
  width?: number;
}

// Community color palette (20 distinct colors)
const COLORS = [
  "#e6194B", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#469990",
  "#dcbeff", "#9A6324", "#fffac8", "#800000", "#aaffc3",
  "#808000", "#ffd8b1", "#000075", "#a9a9a9", "#000000",
];

/**
 * Export graph as standalone interactive HTML visualization.
 */
export function exportHtml(options: ExportHtmlOptions): void {
  const { graph, outputPath, minDegree } = options;
  const visNodes: VisNode[] = [];
  const visEdges: VisEdge[] = [];
  const includedNodes = new Set<string>();

  graph.forEachNode((nodeId, attrs) => {
    const degree = graph.degree(nodeId);
    if (minDegree != null && degree < minDegree) return;

    const community = (attrs.community as number) ?? 0;
    const color = COLORS[community % COLORS.length]!;
    const size = Math.max(5, Math.min(30, 5 + degree * 2));
    const nodeType = (attrs.type as string) ?? "unknown";
    const sourceFile = (attrs.source_file as string) ?? "";

    visNodes.push({
      id: nodeId,
      label: (attrs.label as string) ?? nodeId,
      color,
      size,
      title: `${attrs.label}\nType: ${nodeType}\nFile: ${sourceFile}\nCommunity: ${community}\nDegree: ${degree}`,
    });
    includedNodes.add(nodeId);
  });

  graph.forEachEdge((_edge, attrs, source, target) => {
    if (!includedNodes.has(source) || !includedNodes.has(target)) return;
    const relation = (attrs.relation as string) ?? "";
    visEdges.push({
      from: source,
      to: target,
      label: relation,
      color: getEdgeColor(relation),
    });
  });

  const html = generateHtml({
    title: "Code Knowledge Graph",
    statsLabel: `${visNodes.length} nodes, ${visEdges.length} edges`,
    nodes: visNodes,
    edges: visEdges,
  });
  writeFileSync(outputPath, html);
}

/**
 * Export aggregated community graph as standalone HTML visualization.
 */
export function exportCommunityHtml(options: ExportHtmlOptions): void {
  const { graph, communities, outputPath } = options;
  const visNodes: VisNode[] = [];
  const visEdges: VisEdge[] = [];
  const edgeCounts = new Map<string, number>();

  for (const [communityId, members] of communities.communities.entries()) {
    const rankedMembers = members
      .filter((nodeId) => graph.hasNode(nodeId))
      .map((nodeId) => ({
        label: (graph.getNodeAttribute(nodeId, "label") as string | undefined) ?? nodeId,
        degree: graph.degree(nodeId),
        repo: graph.getNodeAttribute(nodeId, "repo") as string | undefined,
        type: graph.getNodeAttribute(nodeId, "type") as string | undefined,
      }))
      .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));

    const prominent = rankedMembers
      .filter((member) => member.type !== "module" && member.type !== "document")
      .slice(0, 2)
      .map((member) => member.label);
    const repos = Array.from(new Set(rankedMembers.map((member) => member.repo).filter(Boolean) as string[])).sort();

    visNodes.push({
      id: String(communityId),
      label: prominent.length > 0
        ? `Community ${communityId}\n${prominent.join(" / ")} (${members.length})`
        : `Community ${communityId}\n(${members.length})`,
      color: COLORS[communityId % COLORS.length]!,
      size: Math.max(18, Math.min(70, 18 + Math.sqrt(members.length) * 8)),
      title: [
        `Community ${communityId}`,
        `Members: ${members.length}`,
        `Repos: ${repos.length > 0 ? repos.join(", ") : "-"}`,
        `Key members: ${rankedMembers.slice(0, 5).map((member) => `${member.label} (${member.degree})`).join(", ") || "-"}`,
      ].join("\n"),
    });
  }

  graph.forEachEdge((_edge, _attrs, source, target) => {
    const sourceCommunity = graph.getNodeAttribute(source, "community") as number | undefined;
    const targetCommunity = graph.getNodeAttribute(target, "community") as number | undefined;
    if (sourceCommunity == null || targetCommunity == null || sourceCommunity === targetCommunity) return;

    const key = `${sourceCommunity}->${targetCommunity}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  });

  for (const [key, count] of edgeCounts.entries()) {
    const [from, to] = key.split("->");
    visEdges.push({
      from: from!,
      to: to!,
      label: String(count),
      color: "#9aa5b1",
      width: Math.max(1, Math.min(10, 1 + Math.log2(count + 1))),
    });
  }

  const html = generateHtml({
    title: "Code Knowledge Graph — Communities",
    statsLabel: `${visNodes.length} communities, ${visEdges.length} cross-community edges`,
    nodes: visNodes,
    edges: visEdges,
  });
  writeFileSync(outputPath, html);
}

function getEdgeColor(relation: string): string {
  switch (relation.toLowerCase()) {
    case "calls": return "#ff6b6b";
    case "imports": case "imports_from": return "#4ecdc4";
    case "extends": case "inherits": return "#45b7d1";
    case "contains": case "method": case "contains_section": return "#95a5a6";
    default: return "#bdc3c7";
  }
}

function generateHtml(options: {
  title: string;
  statsLabel: string;
  nodes: VisNode[];
  edges: VisEdge[];
}): string {
  const graphDataJson = serializeForHtml({
    nodes: options.nodes,
    edges: options.edges,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${options.title}</title>
<script type="text/javascript" src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; }
  #controls { position: fixed; top: 0; left: 0; right: 0; z-index: 10; background: rgba(26,26,46,0.95); padding: 10px 20px; display: flex; gap: 15px; align-items: center; border-bottom: 1px solid #333; }
  #controls input { padding: 6px 12px; border-radius: 4px; border: 1px solid #555; background: #16213e; color: #eee; width: 300px; font-size: 14px; }
  #controls .stats { color: #888; font-size: 13px; margin-left: auto; }
  #graph { width: 100vw; height: 100vh; padding-top: 50px; }
</style>
</head>
<body>
<div id="controls">
  <input type="text" id="search" placeholder="Search nodes..." />
  <div class="stats">${options.statsLabel}</div>
</div>
<div id="graph"></div>
<script id="graph-data" type="application/json">${graphDataJson}</script>
<script>
  const graphDataEl = document.getElementById('graph-data');
  const graphData = JSON.parse(graphDataEl.textContent);
  const nodesData = graphData.nodes;
  const edgesData = graphData.edges;

  const nodes = new vis.DataSet(nodesData);
  const edges = new vis.DataSet(edgesData.map(function(e, i) {
    return {
      id: i,
      from: e.from,
      to: e.to,
      label: e.label,
      title: e.label,
      color: { color: e.color, opacity: 0.6 },
      arrows: 'to',
      width: e.width || 1,
    };
  }));

  const container = document.getElementById('graph');
  const data = { nodes: nodes, edges: edges };
  const options = {
    physics: {
      solver: 'forceAtlas2Based',
      forceAtlas2Based: {
        gravitationalConstant: -800,
        centralGravity: 0.001,
        springLength: 250,
        springConstant: 0.02,
        damping: 0.4,
        avoidOverlap: 0.8
      },
      stabilization: { iterations: 500, updateInterval: 50 }
    },
    nodes: {
      shape: 'dot',
      font: { color: '#eee', size: 12, face: 'monospace', multi: 'html' }
    },
    edges: {
      smooth: { type: 'continuous' },
      font: { color: '#cbd5e1', size: 10, strokeWidth: 0, align: 'middle' }
    },
    interaction: { hover: true, tooltipDelay: 100, navigationButtons: true, keyboard: true }
  };

  const network = new vis.Network(container, data, options);
  let frozen = false;
  network.on('stabilizationIterationsDone', function() {
    if (frozen) return;
    frozen = true;
    network.setOptions({ physics: false });
  });

  document.getElementById('search').addEventListener('input', function(e) {
    var term = e.target.value.toLowerCase();
    if (!term) {
      nodes.forEach(function(n) { nodes.update({ id: n.id, opacity: 1, font: { color: '#eee', size: 12, face: 'monospace', multi: 'html' } }); });
      return;
    }
    nodes.forEach(function(n) {
      var match = n.label.toLowerCase().includes(term);
      nodes.update({ id: n.id, opacity: match ? 1 : 0.1, font: { color: match ? '#fff' : '#333', size: 12, face: 'monospace', multi: 'html' } });
    });
    var matches = nodes.get({ filter: function(n) { return n.label.toLowerCase().includes(term); } });
    if (matches.length === 1) { network.focus(matches[0].id, { scale: 1.5, animation: true }); }
  });
</script>
</body>
</html>`;
}

function serializeForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
