/**
 * report phase — generates markdown build report.
 *
 * Reads graph-enriched.json and generates report.md.
 */
import { atomicWriteText } from "../../shared/atomic-write.js";
import { extname, join } from "node:path";
import type { Phase, PhaseContext, PhaseResult } from "../engine/phase.js";
import { reportContract } from "../cache/contracts/report.js";
import type { GraphData, GraphNode } from "../../shared/types.js";
import { loadGraphData } from "../../graph/loader.js";
import { log, errorMessage } from "../../shared/utils.js";
import { formatCommunityName, loadCommunityLabels } from "../../shared/community-labels.js";

interface RankedCommunity {
  id: string;
  members: string[];
  name: string;
  repos: string[];
  keyMembers: string[];
}

export const reportPhase: Phase = {
  id: "report",
  label: "Report",
  dependencies: ["enrich"],
  contract: reportContract,

  async execute(ctx: PhaseContext): Promise<PhaseResult> {
    const startedAt = new Date();
    ctx.manifest.record(this.id, { status: "running", startedAt: startedAt.toISOString(), finishedAt: null, durationMs: null });
    log.info(`  [${this.id}] ${this.label}...`);

    try {
      const { outputDir } = ctx;
      const outputPath = join(outputDir, "report.md");
      const graphJsonPath = join(outputDir, "graph-enriched.json");

      const graphData = loadGraphData(graphJsonPath);
      generateGraphReport({ graphData, outputDir, outputPath });

      const result: PhaseResult = { processed: graphData.nodes.length, skipped: false };
      const finishedAt = new Date();
      const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
      ctx.manifest.record(this.id, { status: "completed", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
      log.info(`  [${this.id}] Done: ${result.processed} processed (${elapsed}s)`);

      return result;
    } catch (err) {
      const finishedAt = new Date();
      const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
      const message = errorMessage(err);
      ctx.manifest.record(this.id, { status: "failed", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
      log.warn(`  [${this.id}] Failed: ${message} (${elapsed}s)`);
      return { processed: 0, skipped: true, skipReason: `error: ${message}` };
    }
  },
};

export function generateGraphReport(options: {
  graphData: GraphData;
  outputDir: string;
  outputPath: string;
}): void {
  const { graphData, outputDir, outputPath } = options;
  const repoNames = new Set<string>();
  const edgeTypeCounts = new Map<string, number>();
  const crossRepoCounts = new Map<string, number>();
  const fileTypeCounts = new Map<string, number>();
  const filePaths = new Set<string>();
  const seenFiles = new Set<string>();
  const nodeMap = new Map(graphData.nodes.map((n) => [n.id, n]));
  const degreeMap = computeDegreeMap(graphData);
  let crossRepoEdgeCount = 0;

  for (const node of graphData.nodes) {
    const repo = toStr(node.repo);
    const sf = toStr(node.source_file);
    if (repo) repoNames.add(repo);
    if (sf) filePaths.add(sf);
    if (sf && !seenFiles.has(sf) && isFileLevelNode(node.type)) {
      seenFiles.add(sf);
      incrementCount(fileTypeCounts, getFileTypeLabel(sf));
    }
  }

  for (const edge of graphData.edges) {
    const relation = toStr(edge.type) || "unknown";
    incrementCount(edgeTypeCounts, relation);

    const srcRepo = toStr(nodeMap.get(edge.source)?.repo);
    const tgtRepo = toStr(nodeMap.get(edge.target)?.repo);
    if (srcRepo && tgtRepo && srcRepo !== tgtRepo) {
      crossRepoEdgeCount++;
      incrementCount(crossRepoCounts, `${srcRepo} → ${tgtRepo}`);
    }
  }

  const topGodNodes = graphData.nodes
    .map((n) => ({ label: godNodeLabel(n), type: n.type || "unknown", repo: n.repo || "-", degree: degreeMap.get(n.id) ?? 0 }))
    .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label))
    .slice(0, 15);

  const summaryMap = loadCommunityLabels(outputDir);
  const groupedCommunities = buildCommunityGroups(graphData.nodes);
  const rankedCommunities: RankedCommunity[] = [...groupedCommunities.entries()]
    .map(([id, members]) => buildRankedCommunity(id, members, nodeMap, degreeMap, summaryMap))
    .sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id))
    .slice(0, 10);

  const lines = [
    "# Graph Architecture Report", "",
    `Generated: ${new Date().toISOString()}`, "",
    "## Overall Stats", "",
    `- Nodes: ${graphData.nodes.length}`,
    `- Edges: ${graphData.edges.length}`,
    `- Communities: ${groupedCommunities.size}`,
    `- Repos: ${repoNames.size}`,
    `- Files: ${filePaths.size}`,
    `- Cross-repo edges: ${crossRepoEdgeCount}`, "",
    "## Top God Nodes", "",
    "| Node | Type | Repo | Degree |",
    "| --- | --- | --- | ---: |",
    ...renderTableRows(topGodNodes.map((n) => [n.label, n.type, n.repo, String(n.degree)])), "",
    "## Community Breakdown", "",
    ...rankedCommunities.flatMap((c) => [
      `### ${escMd(formatCommunityName(c.id, c.name))}`, "",
      `- Size: ${c.members.length}`,
      `- Repos: ${c.repos.length > 0 ? c.repos.join(", ") : "-"}`,
      `- Key members: ${c.keyMembers.length > 0 ? c.keyMembers.join(", ") : "-"}`, "",
    ]),
    "## Edge Type Distribution", "",
    "| Edge Type | Count |",
    "| --- | ---: |",
    ...renderCountTable(edgeTypeCounts), "",
    "## Cross-Repo Dependency Summary", "",
    ...(crossRepoCounts.size > 0
      ? ["| Repo Flow | Edge Count |", "| --- | ---: |", ...renderCountTable(crossRepoCounts)]
      : ["No cross-repo dependencies detected."]), "",
    "## File Type Distribution", "",
    "| File Type | Count |",
    "| --- | ---: |",
    ...renderCountTable(fileTypeCounts), "",
  ];

  atomicWriteText(outputPath, lines.join("\n"));
}

function computeDegreeMap(g: GraphData): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of g.edges) {
    m.set(e.source, (m.get(e.source) ?? 0) + 1);
    m.set(e.target, (m.get(e.target) ?? 0) + 1);
  }
  return m;
}

function buildCommunityGroups(nodes: GraphNode[]): Map<string, string[]> {
  const g = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.community == null) continue;
    const id = String(n.community);
    const m = g.get(id) ?? [];
    m.push(n.id);
    g.set(id, m);
  }
  return g;
}

function buildRankedCommunity(
  id: string, members: string[], nodeMap: Map<string, GraphNode>, degreeMap: Map<string, number>, labelMap: Map<string, string>,
): RankedCommunity {
  const ranked = members
    .map((nid) => nodeMap.get(nid))
    .filter((n): n is GraphNode => n != null)
    .map((n) => ({ label: n.label || n.id, degree: degreeMap.get(n.id) ?? 0, repo: n.repo, type: n.type }))
    .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));

  const repos = Array.from(new Set(ranked.map((m) => m.repo).filter(Boolean) as string[])).sort();
  const name = labelMap.get(String(id)) ?? `Community ${id}`;

  return { id, members, name, repos, keyMembers: ranked.slice(0, 5).map((m) => `${m.label} (${m.degree})`) };
}

function renderCountTable(counts: Map<string, number>): string[] {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([l, c]) => `| ${escapePipe(l)} | ${c} |`);
}

function renderTableRows(rows: string[][]): string[] {
  return rows.map((r) => `| ${r.map(escapePipe).join(" | ")} |`);
}

function escapePipe(v: string): string { return escMd(v).replace(/\|/g, "\\|"); }
function incrementCount(c: Map<string, number>, k: string): void { c.set(k, (c.get(k) ?? 0) + 1); }
function toStr(v: unknown): string | undefined { return typeof v === "string" && v.length > 0 ? v : undefined; }
function isFileLevelNode(t: unknown): boolean { return t === "module" || t === "document" || t === "diagram"; }
function godNodeLabel(n: GraphNode): string { return (isFileLevelNode(n.type) && n.source_file) ? n.source_file : (n.label || n.id); }
function getFileTypeLabel(sf: string): string { return extname(sf).toLowerCase() || "[no extension]"; }
function escMd(v: string): string { return v.replace(/\|/g, "\\|"); }
