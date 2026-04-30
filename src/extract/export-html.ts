/**
 * HTML export — standalone interactive visualization using vis-network.
 *
 * Generates a self-contained HTML file with:
 * - Community-based coloring (distinct color per community)
 * - Degree-based node sizing
 * - Interactive search
 * - Physics-based layout
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

  // Collect nodes and edges, optionally filtering by degree
  const visNodes: Array<{ id: string; label: string; color: string; size: number; title: string }> = [];
  const visEdges: Array<{ from: string; to: string; label: string; color: string }> = [];
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

  const html = generateHtml(visNodes, visEdges, graph.order, graph.size);
  writeFileSync(outputPath, html);
}

function getEdgeColor(relation: string): string {
  switch (relation.toLowerCase()) {
    case "calls": return "#ff6b6b";
    case "imports": case "imports_from": return "#4ecdc4";
    case "extends": case "inherits": return "#45b7d1";
    case "contains": case "method": return "#95a5a6";
    default: return "#bdc3c7";
  }
}

function generateHtml(
  nodes: Array<{ id: string; label: string; color: string; size: number; title: string }>,
  edges: Array<{ from: string; to: string; label: string; color: string }>,
  totalNodes: number,
  totalEdges: number,
): string {
  const nodesJson = JSON.stringify(nodes);
  const edgesJson = JSON.stringify(edges);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Code Knowledge Graph</title>
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
  <div class="stats">${totalNodes} nodes, ${totalEdges} edges</div>
</div>
<div id="graph"></div>
<script>
  const nodesData = ${nodesJson};
  const edgesData = ${edgesJson};

  const nodes = new vis.DataSet(nodesData);
  const edges = new vis.DataSet(edgesData.map(function(e, i) {
    return { id: i, from: e.from, to: e.to, title: e.label, color: { color: e.color, opacity: 0.6 }, arrows: 'to', width: 1 };
  }));

  const container = document.getElementById('graph');
  const data = { nodes: nodes, edges: edges };
  const options = {
    physics: {
      solver: 'forceAtlas2Based',
      forceAtlas2Based: { gravitationalConstant: -30, centralGravity: 0.005, springLength: 100 },
      stabilization: { iterations: 150, updateInterval: 25 }
    },
    nodes: { shape: 'dot', font: { color: '#eee', size: 12, face: 'monospace' } },
    edges: { smooth: { type: 'continuous' }, font: { size: 0 } },
    interaction: { hover: true, tooltipDelay: 100, navigationButtons: true, keyboard: true }
  };

  const network = new vis.Network(container, data, options);

  document.getElementById('search').addEventListener('input', function(e) {
    var term = e.target.value.toLowerCase();
    if (!term) { nodes.forEach(function(n) { nodes.update({ id: n.id, opacity: 1, font: { color: '#eee' } }); }); return; }
    nodes.forEach(function(n) {
      var match = n.label.toLowerCase().includes(term);
      nodes.update({ id: n.id, opacity: match ? 1 : 0.1, font: { color: match ? '#fff' : '#333' } });
    });
    var matches = nodes.get({ filter: function(n) { return n.label.toLowerCase().includes(term); } });
    if (matches.length === 1) { network.focus(matches[0].id, { scale: 1.5, animation: true }); }
  });
</script>
</body>
</html>`;
}
