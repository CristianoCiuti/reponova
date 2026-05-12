/**
 * HTML export — standalone interactive visualization using Sigma.js + Graphology.
 *
 * Generates node-level and community-level HTML visualizations with
 * community-based coloring, ForceAtlas2 layout computed at build time,
 * and a modern dark UI with search, type filter, and hover info panel.
 */
import { atomicWriteText } from "../shared/atomic-write.js";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type Graph from "graphology";
import type { CommunityResult } from "./community.js";

/** Summary data for a community (from intelligence layer) */
export interface CommunitySummaryInfo {
  id: string;
  summary: string;
}

export interface ExportHtmlOptions {
  /** The graphology graph with community attributes */
  graph: Graph;
  /** Community detection results */
  communities: CommunityResult;
  /** Output file path */
  outputPath: string;
  /** Min degree to include (optional filter) */
  minDegree?: number;
  /** Community summaries from intelligence layer (optional) */
  communitySummaries?: CommunitySummaryInfo[];
}

// Community color palette — vibrant, high-contrast for dark backgrounds
const COLORS = [
  "#6366f1", "#22d3ee", "#f472b6", "#34d399", "#fbbf24",
  "#a78bfa", "#fb923c", "#2dd4bf", "#f87171", "#38bdf8",
  "#c084fc", "#4ade80", "#e879f9", "#facc15", "#67e8f9",
  "#fb7185", "#a3e635", "#818cf8", "#f97316", "#14b8a6",
];

interface SigmaNode {
  key: string;
  attributes: {
    x: number;
    y: number;
    size: number;
    color: string;
    label: string;
    nodeType: string;
    sourceFile: string;
    community: number;
    degree: number;
  };
}

interface SigmaEdge {
  source: string;
  target: string;
  attributes: {
    color: string;
    size: number;
    relation: string;
  };
}

/**
 * Assign random initial positions to nodes that lack x/y.
 */
function assignInitialPositions(graph: Graph): void {
  const order = graph.order;
  const radius = Math.sqrt(order) * 10;
  let i = 0;
  graph.forEachNode((node) => {
    const angle = (2 * Math.PI * i) / order;
    // Circular layout with jitter for better FA2 convergence
    const jitter = () => (Math.random() - 0.5) * radius * 0.3;
    graph.setNodeAttribute(node, "x", Math.cos(angle) * radius + jitter());
    graph.setNodeAttribute(node, "y", Math.sin(angle) * radius + jitter());
    i++;
  });
}

/**
 * Run ForceAtlas2 layout in-place on the graph.
 */
function computeLayout(graph: Graph): void {
  assignInitialPositions(graph);

  const settings = forceAtlas2.inferSettings(graph);
  const iterations = Math.min(600, Math.max(100, graph.order * 2));

  forceAtlas2.assign(graph, {
    iterations,
    settings: {
      ...settings,
      barnesHutOptimize: graph.order > 200,
      gravity: 1,
      slowDown: 5,
    },
  });
}

/**
 * Export graph as standalone interactive HTML visualization using Sigma.js.
 */
export function exportHtml(options: ExportHtmlOptions): void {
  const { graph, outputPath, minDegree } = options;
  const nodes: SigmaNode[] = [];
  const edges: SigmaEdge[] = [];
  const includedNodes = new Set<string>();
  const nodeTypes = new Set<string>();

  // Build a filtered subgraph for layout
  graph.forEachNode((nodeId) => {
    const degree = graph.degree(nodeId);
    if (minDegree != null && degree < minDegree) return;
    includedNodes.add(nodeId);
  });

  // Compute layout on the full graph (positions needed before extraction)
  computeLayout(graph);

  graph.forEachNode((nodeId, attrs) => {
    if (!includedNodes.has(nodeId)) return;
    const degree = graph.degree(nodeId);
    const community = Number(attrs.community) || 0;
    const color = COLORS[community % COLORS.length]!;
    const size = Math.max(3, Math.min(20, 3 + Math.sqrt(degree) * 2));
    const nodeType = (attrs.type as string) ?? "unknown";
    const sourceFile = (attrs.source_file as string) ?? "";

    nodeTypes.add(nodeType);
    nodes.push({
      key: nodeId,
      attributes: {
        x: attrs.x as number,
        y: attrs.y as number,
        size,
        color,
        label: (attrs.label as string) ?? nodeId,
        nodeType,
        sourceFile,
        community,
        degree,
      },
    });
  });

  graph.forEachEdge((_edge, attrs, source, target) => {
    if (!includedNodes.has(source) || !includedNodes.has(target)) return;
    const relation = (attrs.relation as string) ?? "";
    edges.push({
      source,
      target,
      attributes: {
        color: getEdgeColor(relation),
        size: 0.5,
        relation,
      },
    });
  });

  const html = generateNodeGraphHtml({
    title: "Code Knowledge Graph",
    nodes,
    edges,
    nodeTypes: Array.from(nodeTypes).sort(),
    communityCount: new Set(nodes.map((n) => n.attributes.community)).size,
  });
  atomicWriteText(outputPath, html);
}

/**
 * Export aggregated community graph as standalone HTML visualization.
 */
export function exportCommunityHtml(options: ExportHtmlOptions): void {
  const { graph, communities, outputPath, communitySummaries } = options;
  const nodes: SigmaNode[] = [];
  const edges: SigmaEdge[] = [];
  const edgeCounts = new Map<string, number>();

  const summaryMap = new Map<string, string>();
  if (communitySummaries) {
    for (const s of communitySummaries) {
      summaryMap.set(String(s.id), s.summary);
    }
  }

  const communityCount = communities.communities.size;
  let i = 0;

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
      .slice(0, 3)
      .map((member) => member.label);

    const summaryText = summaryMap.get(String(communityId));
    let displayLabel: string;
    if (summaryText) {
      const shortSummary = summaryText.length > 50 ? summaryText.slice(0, 47) + "..." : summaryText;
      displayLabel = `C${communityId}: ${shortSummary}`;
    } else {
      displayLabel = prominent.length > 0
        ? `C${communityId}: ${prominent.join(", ")}`
        : `Community ${communityId}`;
    }

    // Circular layout for community graph (few nodes, no FA2 needed)
    const angle = (2 * Math.PI * i) / communityCount;
    const radius = Math.max(100, communityCount * 15);

    nodes.push({
      key: String(communityId),
      attributes: {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        size: Math.max(10, Math.min(40, 10 + Math.sqrt(members.length) * 4)),
        color: COLORS[Number(communityId) % COLORS.length]!,
        label: displayLabel,
        nodeType: "community",
        sourceFile: "",
        community: Number(communityId),
        degree: members.length,
      },
    });
    i++;
  }

  graph.forEachEdge((_edge, _attrs, source, target) => {
    const sourceCommunity = graph.getNodeAttribute(source, "community") as string | undefined;
    const targetCommunity = graph.getNodeAttribute(target, "community") as string | undefined;
    if (sourceCommunity == null || targetCommunity == null || sourceCommunity === targetCommunity) return;

    const key = `${sourceCommunity}->${targetCommunity}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  });

  for (const [key, count] of edgeCounts.entries()) {
    const [from, to] = key.split("->");
    edges.push({
      source: from!,
      target: to!,
      attributes: {
        color: "rgba(148, 163, 184, 0.6)",
        size: Math.max(1, Math.min(6, 1 + Math.log2(count + 1))),
        relation: `${count} connections`,
      },
    });
  }

  const html = generateCommunityGraphHtml({
    title: "Code Knowledge Graph — Communities",
    nodes,
    edges,
    summaryMap,
  });
  atomicWriteText(outputPath, html);
}

function getEdgeColor(relation: string): string {
  switch (relation.toLowerCase()) {
    case "calls": return "rgba(251, 113, 133, 0.5)";
    case "imports": case "imports_from": return "rgba(45, 212, 191, 0.5)";
    case "extends": case "inherits": return "rgba(129, 140, 248, 0.5)";
    case "contains": return "rgba(148, 163, 184, 0.25)";
    default: return "rgba(148, 163, 184, 0.35)";
  }
}

function serializeForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ─── HTML Templates ────────────────────────────────────────────────────────────

function generateNodeGraphHtml(options: {
  title: string;
  nodes: SigmaNode[];
  edges: SigmaEdge[];
  nodeTypes: string[];
  communityCount: number;
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
<script src="https://cdn.jsdelivr.net/npm/graphology@0.25.4/dist/graphology.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/sigma@3.0.3/dist/sigma.min.js"></script>
<style>
  :root {
    --bg-primary: #0d1117;
    --bg-secondary: #161b22;
    --bg-tertiary: #21262d;
    --border: #30363d;
    --text-primary: #e6edf3;
    --text-secondary: #8b949e;
    --text-muted: #484f58;
    --accent: #6366f1;
    --accent-glow: rgba(99, 102, 241, 0.15);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
    background: var(--bg-primary);
    color: var(--text-primary);
    overflow: hidden;
    height: 100vh;
  }

  /* ─── Top Bar ─── */
  #toolbar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 100;
    height: 52px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 12px;
    padding: 0 16px;
  }
  #toolbar .logo {
    font-weight: 600; font-size: 14px; color: var(--text-primary);
    white-space: nowrap; margin-right: 8px;
  }
  #search-box {
    position: relative; flex: 0 1 320px;
  }
  #search-box input {
    width: 100%; padding: 6px 12px 6px 32px;
    border-radius: 6px; border: 1px solid var(--border);
    background: var(--bg-primary); color: var(--text-primary);
    font-size: 13px; outline: none; transition: border-color 0.15s;
  }
  #search-box input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
  #search-box::before {
    content: '\\1F50D'; position: absolute; left: 10px; top: 50%;
    transform: translateY(-50%); font-size: 12px; pointer-events: none;
  }
  .filter-chips {
    display: flex; gap: 4px; flex-wrap: nowrap; overflow-x: auto;
    scrollbar-width: none; padding: 2px 0;
  }
  .filter-chips::-webkit-scrollbar { display: none; }
  .chip {
    padding: 4px 10px; border-radius: 20px; font-size: 11px;
    border: 1px solid var(--border); background: var(--bg-primary);
    color: var(--text-secondary); cursor: pointer; white-space: nowrap;
    transition: all 0.15s; user-select: none;
  }
  .chip:hover { border-color: var(--text-secondary); color: var(--text-primary); }
  .chip.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .stats {
    margin-left: auto; font-size: 12px; color: var(--text-muted);
    white-space: nowrap;
  }

  /* ─── Graph Container ─── */
  #sigma-container {
    position: fixed; top: 52px; left: 0; right: 0; bottom: 0;
    background: var(--bg-primary);
  }

  /* ─── Info Panel ─── */
  #info-panel {
    position: fixed; bottom: 16px; left: 16px; z-index: 100;
    max-width: 340px; min-width: 240px;
    background: var(--bg-secondary); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px 16px;
    font-size: 12px; line-height: 1.6;
    opacity: 0; transform: translateY(8px);
    transition: opacity 0.2s, transform 0.2s;
    pointer-events: none;
    box-shadow: 0 4px 24px rgba(0,0,0,0.4);
  }
  #info-panel.visible { opacity: 1; transform: translateY(0); pointer-events: auto; }
  #info-panel .node-label {
    font-size: 14px; font-weight: 600; color: var(--text-primary);
    margin-bottom: 6px; word-break: break-word;
  }
  #info-panel .detail-row {
    display: flex; justify-content: space-between; gap: 8px;
    color: var(--text-secondary); padding: 2px 0;
  }
  #info-panel .detail-row .label { color: var(--text-muted); }
  #info-panel .detail-row .value { color: var(--text-primary); text-align: right; word-break: break-all; }

  /* ─── Legend ─── */
  #legend {
    position: fixed; bottom: 16px; right: 16px; z-index: 100;
    background: var(--bg-secondary); border: 1px solid var(--border);
    border-radius: 10px; padding: 12px 14px;
    font-size: 11px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.4);
  }
  #legend h4 { font-size: 11px; color: var(--text-muted); margin-bottom: 6px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
  .legend-item { display: flex; align-items: center; gap: 6px; padding: 2px 0; color: var(--text-secondary); }
  .legend-dot { width: 10px; height: 3px; border-radius: 2px; }
</style>
</head>
<body>
<div id="toolbar">
  <div class="logo">${options.title}</div>
  <div id="search-box"><input type="text" id="search" placeholder="Search nodes..." autocomplete="off" /></div>
  <div class="filter-chips" id="type-filters">
    <div class="chip active" data-type="all">All</div>
    ${options.nodeTypes.map((t) => `<div class="chip" data-type="${t}">${t}</div>`).join("\n    ")}
  </div>
  <div class="stats">${options.nodes.length} nodes &middot; ${options.edges.length} edges &middot; ${options.communityCount} communities</div>
</div>
<div id="sigma-container"></div>
<div id="info-panel">
  <div class="node-label" id="info-label"></div>
  <div id="info-details"></div>
</div>
<div id="legend">
  <h4>Edge Types</h4>
  <div class="legend-item"><div class="legend-dot" style="background:rgba(251,113,133,0.8)"></div>calls</div>
  <div class="legend-item"><div class="legend-dot" style="background:rgba(45,212,191,0.8)"></div>imports</div>
  <div class="legend-item"><div class="legend-dot" style="background:rgba(129,140,248,0.8)"></div>extends</div>
  <div class="legend-item"><div class="legend-dot" style="background:rgba(148,163,184,0.5)"></div>contains</div>
</div>
<script id="graph-data" type="application/json">${graphDataJson}</script>
<script>
(function() {
  var data = JSON.parse(document.getElementById('graph-data').textContent);

  // Build graphology graph
  var graph = new graphology.Graph();
  data.nodes.forEach(function(n) { graph.addNode(n.key, n.attributes); });
  data.edges.forEach(function(e, i) { graph.addEdge(e.source, e.target, Object.assign({ key: 'e' + i }, e.attributes)); });

  // Sigma renderer
  var container = document.getElementById('sigma-container');
  var renderer = new Sigma(graph, container, {
    renderLabels: true,
    renderEdgeLabels: false,
    labelSize: 12,
    labelColor: { color: '#e6edf3' },
    labelFont: '"Segoe UI", sans-serif',
    labelWeight: '500',
    labelRenderedSizeThreshold: 6,
    edgeLabelSize: 10,
    defaultNodeColor: '#6366f1',
    defaultEdgeColor: 'rgba(148,163,184,0.3)',
    minCameraRatio: 0.02,
    maxCameraRatio: 20,
    nodeReducer: nodeReducer,
    edgeReducer: edgeReducer,
  });

  // ─── State ───
  var state = {
    searchTerm: '',
    hoveredNode: null,
    selectedType: 'all',
    highlightedNodes: new Set(),
    highlightedEdges: new Set(),
  };

  function updateHighlights() {
    state.highlightedNodes.clear();
    state.highlightedEdges.clear();

    // Search highlighting
    if (state.searchTerm) {
      var term = state.searchTerm.toLowerCase();
      graph.forEachNode(function(node, attrs) {
        if (attrs.label.toLowerCase().includes(term)) {
          state.highlightedNodes.add(node);
        }
      });
    }

    // Hover neighbors
    if (state.hoveredNode) {
      state.highlightedNodes.add(state.hoveredNode);
      graph.forEachNeighbor(state.hoveredNode, function(neighbor) {
        state.highlightedNodes.add(neighbor);
      });
      graph.forEachEdge(state.hoveredNode, function(edge) {
        state.highlightedEdges.add(edge);
      });
    }

    renderer.refresh();
  }

  function nodeReducer(node, data) {
    var res = Object.assign({}, data);
    var hasFilter = state.searchTerm || state.hoveredNode;
    var typeMatch = state.selectedType === 'all' || data.nodeType === state.selectedType;

    if (!typeMatch) {
      res.color = '#21262d';
      res.size = Math.max(1, data.size * 0.4);
      res.label = '';
      return res;
    }

    if (hasFilter && state.highlightedNodes.size > 0) {
      if (state.highlightedNodes.has(node)) {
        res.color = data.color;
        res.size = data.size * 1.2;
        res.zIndex = 10;
        if (node === state.hoveredNode) {
          res.highlighted = true;
        }
      } else {
        res.color = '#21262d';
        res.size = Math.max(1, data.size * 0.5);
        res.label = '';
      }
    }
    return res;
  }

  function edgeReducer(edge, data) {
    var res = Object.assign({}, data);
    var hasFilter = state.searchTerm || state.hoveredNode;
    if (hasFilter && state.highlightedEdges.size > 0) {
      if (!state.highlightedEdges.has(edge)) {
        res.color = 'rgba(48,54,61,0.2)';
        res.size = 0.2;
      } else {
        res.size = 1.5;
      }
    }
    return res;
  }

  // ─── Search ───
  var searchInput = document.getElementById('search');
  var searchTimeout;
  searchInput.addEventListener('input', function(e) {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(function() {
      state.searchTerm = e.target.value.trim();
      updateHighlights();

      // Auto-focus single match
      if (state.highlightedNodes.size === 1) {
        var nodeId = state.highlightedNodes.values().next().value;
        var attrs = graph.getNodeAttributes(nodeId);
        var camera = renderer.getCamera();
        camera.animate({ x: attrs.x, y: attrs.y, ratio: 0.3 }, { duration: 300 });
      }
    }, 150);
  });

  // ─── Type Filter ───
  var chips = document.querySelectorAll('.chip[data-type]');
  chips.forEach(function(chip) {
    chip.addEventListener('click', function() {
      chips.forEach(function(c) { c.classList.remove('active'); });
      chip.classList.add('active');
      state.selectedType = chip.dataset.type;
      renderer.refresh();
    });
  });

  // ─── Hover Info Panel ───
  var infoPanel = document.getElementById('info-panel');
  var infoLabel = document.getElementById('info-label');
  var infoDetails = document.getElementById('info-details');

  renderer.on('enterNode', function(e) {
    state.hoveredNode = e.node;
    var attrs = graph.getNodeAttributes(e.node);
    showInfoPanel(attrs);
    updateHighlights();
    container.style.cursor = 'pointer';
  });

  renderer.on('leaveNode', function() {
    state.hoveredNode = null;
    hideInfoPanel();
    updateHighlights();
    container.style.cursor = 'default';
  });

  function showInfoPanel(attrs) {
    infoLabel.textContent = attrs.label;
    infoDetails.innerHTML = [
      row('Type', attrs.nodeType),
      row('File', attrs.sourceFile || '-'),
      row('Community', attrs.community),
      row('Degree', attrs.degree),
    ].join('');
    infoPanel.classList.add('visible');
  }

  function hideInfoPanel() {
    infoPanel.classList.remove('visible');
  }

  function row(label, value) {
    return '<div class="detail-row"><span class="label">' + label + '</span><span class="value">' + escHtml(String(value)) + '</span></div>';
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ─── Click to focus ───
  renderer.on('clickNode', function(e) {
    var attrs = graph.getNodeAttributes(e.node);
    var camera = renderer.getCamera();
    camera.animate({ x: attrs.x, y: attrs.y, ratio: 0.2 }, { duration: 400 });
  });
})();
</script>
</body>
</html>`;
}

function generateCommunityGraphHtml(options: {
  title: string;
  nodes: SigmaNode[];
  edges: SigmaEdge[];
  summaryMap: Map<string, string>;
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
<script src="https://cdn.jsdelivr.net/npm/graphology@0.25.4/dist/graphology.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/sigma@3.0.3/dist/sigma.min.js"></script>
<style>
  :root {
    --bg-primary: #0d1117;
    --bg-secondary: #161b22;
    --border: #30363d;
    --text-primary: #e6edf3;
    --text-secondary: #8b949e;
    --text-muted: #484f58;
    --accent: #6366f1;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg-primary); color: var(--text-primary);
    overflow: hidden; height: 100vh;
  }
  #toolbar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 100;
    height: 52px; background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; padding: 0 16px; gap: 12px;
  }
  #toolbar .logo { font-weight: 600; font-size: 14px; }
  .stats { margin-left: auto; font-size: 12px; color: var(--text-muted); }
  #sigma-container { position: fixed; top: 52px; left: 0; right: 0; bottom: 0; }
  #info-panel {
    position: fixed; bottom: 16px; left: 16px; z-index: 100;
    max-width: 380px; min-width: 260px;
    background: var(--bg-secondary); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px 16px;
    font-size: 12px; line-height: 1.7;
    opacity: 0; transform: translateY(8px);
    transition: opacity 0.2s, transform 0.2s;
    pointer-events: none;
    box-shadow: 0 4px 24px rgba(0,0,0,0.4);
  }
  #info-panel.visible { opacity: 1; transform: translateY(0); pointer-events: auto; }
  #info-panel .node-label {
    font-size: 14px; font-weight: 600; margin-bottom: 8px;
    word-break: break-word;
  }
  #info-panel .summary {
    color: var(--text-secondary); font-style: italic;
    margin-bottom: 6px;
  }
  #info-panel .detail-row {
    display: flex; justify-content: space-between; gap: 8px;
    color: var(--text-secondary); padding: 2px 0;
  }
  #info-panel .detail-row .label { color: var(--text-muted); }
  #info-panel .detail-row .value { color: var(--text-primary); }
</style>
</head>
<body>
<div id="toolbar">
  <div class="logo">${options.title}</div>
  <div class="stats">${options.nodes.length} communities &middot; ${options.edges.length} cross-community edges</div>
</div>
<div id="sigma-container"></div>
<div id="info-panel">
  <div class="node-label" id="info-label"></div>
  <div class="summary" id="info-summary"></div>
  <div id="info-details"></div>
</div>
<script id="graph-data" type="application/json">${graphDataJson}</script>
<script>
(function() {
  var data = JSON.parse(document.getElementById('graph-data').textContent);

  var graph = new graphology.Graph();
  data.nodes.forEach(function(n) { graph.addNode(n.key, n.attributes); });
  data.edges.forEach(function(e, i) { graph.addEdge(e.source, e.target, Object.assign({ key: 'e' + i }, e.attributes)); });

  var container = document.getElementById('sigma-container');
  var renderer = new Sigma(graph, container, {
    renderLabels: true,
    renderEdgeLabels: true,
    labelSize: 13,
    labelColor: { color: '#e6edf3' },
    labelRenderedSizeThreshold: 0,
    edgeLabelSize: 10,
    edgeLabelColor: { color: '#8b949e' },
    defaultEdgeColor: 'rgba(148,163,184,0.4)',
    minCameraRatio: 0.1,
    maxCameraRatio: 10,
    nodeReducer: function(node, data) {
      var res = Object.assign({}, data);
      if (hoveredNode && hoveredNode !== node && !neighbors.has(node)) {
        res.color = '#21262d';
        res.label = '';
      }
      if (hoveredNode === node) {
        res.highlighted = true;
        res.size = data.size * 1.3;
      }
      return res;
    },
    edgeReducer: function(edge, data) {
      var res = Object.assign({}, data);
      if (hoveredNode && !hoveredEdges.has(edge)) {
        res.color = 'rgba(48,54,61,0.15)';
        res.size = 0.3;
      }
      return res;
    },
  });

  var hoveredNode = null;
  var neighbors = new Set();
  var hoveredEdges = new Set();
  var infoPanel = document.getElementById('info-panel');
  var infoLabel = document.getElementById('info-label');
  var infoSummary = document.getElementById('info-summary');
  var infoDetails = document.getElementById('info-details');

  renderer.on('enterNode', function(e) {
    hoveredNode = e.node;
    neighbors.clear();
    hoveredEdges.clear();
    graph.forEachNeighbor(e.node, function(n) { neighbors.add(n); });
    graph.forEachEdge(e.node, function(edge) { hoveredEdges.add(edge); });

    var attrs = graph.getNodeAttributes(e.node);
    infoLabel.textContent = 'Community ' + attrs.community;
    infoSummary.textContent = attrs.label;
    infoDetails.innerHTML = '<div class="detail-row"><span class="label">Members</span><span class="value">' + attrs.degree + '</span></div>';
    infoPanel.classList.add('visible');
    renderer.refresh();
    container.style.cursor = 'pointer';
  });

  renderer.on('leaveNode', function() {
    hoveredNode = null;
    neighbors.clear();
    hoveredEdges.clear();
    infoPanel.classList.remove('visible');
    renderer.refresh();
    container.style.cursor = 'default';
  });

  renderer.on('clickNode', function(e) {
    var attrs = graph.getNodeAttributes(e.node);
    var camera = renderer.getCamera();
    camera.animate({ x: attrs.x, y: attrs.y, ratio: 0.3 }, { duration: 400 });
  });
})();
</script>
</body>
</html>`;
}
