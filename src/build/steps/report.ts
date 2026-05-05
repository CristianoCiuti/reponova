import { writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { GraphData, GraphNode } from "../../shared/types.js";
import type { BuildStep, StepContext } from "../types.js";

interface RankedCommunity {
  id: string;
  members: string[];
  name: string;
  repos: string[];
  keyMembers: string[];
}

interface LoadedCommunitySummary {
  id: string | number;
  summary: string;
  hub_nodes: string[];
}

export const runReportStep: BuildStep = async (ctx: StepContext) => {
  const outputPath = join(ctx.outputDir, "report.md");
  const summariesPath = join(ctx.outputDir, "community_summaries.json");

  if (!shouldRunReport(ctx.graphJsonPath, outputPath, summariesPath, ctx.force)) {
    return { processed: 0, skipped: true, skipReason: "up to date" };
  }

  const graphData = JSON.parse(readFileSync(ctx.graphJsonPath, "utf-8")) as GraphData;
  generateGraphReport({ graphData, outputDir: ctx.outputDir, outputPath });
  return { processed: graphData.nodes.length, skipped: false };
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
  const nodeMap = new Map(graphData.nodes.map((node) => [node.id, node]));
  const degreeMap = computeDegreeMap(graphData);
  let crossRepoEdgeCount = 0;

  for (const node of graphData.nodes) {
    const repo = toNonEmptyString(node.repo);
    const sourceFile = toNonEmptyString(node.source_file);

    if (repo) repoNames.add(repo);
    if (sourceFile) filePaths.add(sourceFile);
    if (sourceFile && !seenFiles.has(sourceFile) && isFileLevelNode(node.type)) {
      seenFiles.add(sourceFile);
      incrementCount(fileTypeCounts, getFileTypeLabel(sourceFile));
    }
  }

  for (const edge of graphData.edges) {
    const relation = toNonEmptyString(edge.type) || "unknown";
    incrementCount(edgeTypeCounts, relation);

    const sourceRepo = toNonEmptyString(nodeMap.get(edge.source)?.repo);
    const targetRepo = toNonEmptyString(nodeMap.get(edge.target)?.repo);
    if (sourceRepo && targetRepo && sourceRepo !== targetRepo) {
      crossRepoEdgeCount++;
      incrementCount(crossRepoCounts, `${sourceRepo} → ${targetRepo}`);
    }
  }

  const topGodNodes = graphData.nodes
    .map((node) => ({
      label: node.label || node.id,
      type: node.type || "unknown",
      repo: node.repo || "-",
      degree: degreeMap.get(node.id) ?? 0,
    }))
    .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label))
    .slice(0, 15);

  const summaryMap = loadCommunitySummaries(outputDir);
  const groupedCommunities = buildCommunityGroups(graphData.nodes);
  const rankedCommunities: RankedCommunity[] = [...groupedCommunities.entries()]
    .map(([id, members]) => buildRankedCommunity(id, members, nodeMap, degreeMap, summaryMap))
    .sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id))
    .slice(0, 10);

  const lines = [
    "# Graph Architecture Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Overall Stats",
    "",
    `- Nodes: ${graphData.nodes.length}`,
    `- Edges: ${graphData.edges.length}`,
    `- Communities: ${groupedCommunities.size}`,
    `- Repos: ${repoNames.size}`,
    `- Files: ${filePaths.size}`,
    `- Cross-repo edges: ${crossRepoEdgeCount}`,
    "",
    "## Top God Nodes",
    "",
    "| Node | Type | Repo | Degree |",
    "| --- | --- | --- | ---: |",
    ...renderTableRows(topGodNodes.map((node) => [node.label, node.type, node.repo, String(node.degree)])),
    "",
    "## Community Breakdown",
    "",
    ...rankedCommunities.flatMap((community) => [
      `### Community ${community.id} — ${escapeMarkdownText(community.name)}`,
      "",
      `- Size: ${community.members.length}`,
      `- Repos: ${community.repos.length > 0 ? community.repos.join(", ") : "-"}`,
      `- Key members: ${community.keyMembers.length > 0 ? community.keyMembers.join(", ") : "-"}`,
      "",
    ]),
    "## Edge Type Distribution",
    "",
    "| Edge Type | Count |",
    "| --- | ---: |",
    ...renderCountTable(edgeTypeCounts),
    "",
    "## Cross-Repo Dependency Summary",
    "",
    ...(crossRepoCounts.size > 0
      ? ["| Repo Flow | Edge Count |", "| --- | ---: |", ...renderCountTable(crossRepoCounts)]
      : ["No cross-repo dependencies detected."]),
    "",
    "## File Type Distribution",
    "",
    "| File Type | Count |",
    "| --- | ---: |",
    ...renderCountTable(fileTypeCounts),
    "",
  ];

  writeFileSync(outputPath, lines.join("\n"));
}

function shouldRunReport(graphJsonPath: string, outputPath: string, summariesPath: string, force: boolean): boolean {
  if (force) return true;
  if (!existsSync(outputPath)) return true;
  if (statSync(graphJsonPath).mtimeMs > statSync(outputPath).mtimeMs) return true;
  return existsSync(summariesPath) && statSync(summariesPath).mtimeMs > statSync(outputPath).mtimeMs;
}

function buildCommunityGroups(nodes: GraphNode[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const communityId = node.community;
    if (!communityId) continue;
    const members = groups.get(communityId) ?? [];
    members.push(node.id);
    groups.set(communityId, members);
  }
  return groups;
}

function buildRankedCommunity(
  id: string,
  members: string[],
  nodeMap: Map<string, GraphNode>,
  degreeMap: Map<string, number>,
  summaryMap: Map<string, string>,
): RankedCommunity {
  const rankedMembers = members
    .map((nodeId) => nodeMap.get(nodeId))
    .filter((node): node is GraphNode => node != null)
    .map((node) => ({
      label: node.label || node.id,
      degree: degreeMap.get(node.id) ?? 0,
      repo: node.repo,
      type: node.type,
    }))
    .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));

  const repos = Array.from(new Set(rankedMembers.map((member) => member.repo).filter(Boolean) as string[])).sort();
  const llmSummary = summaryMap.get(String(id));
  const name = llmSummary
    ?? (rankedMembers
      .filter((member) => member.type !== "module" && member.type !== "document")
      .slice(0, 2)
      .map((member) => member.label)
      .join(" / ") || `Community ${id}`);

  return {
    id,
    members,
    name,
    repos,
    keyMembers: rankedMembers.slice(0, 5).map((member) => `${member.label} (${member.degree})`),
  };
}

function computeDegreeMap(graphData: GraphData): Map<string, number> {
  const degreeMap = new Map<string, number>();
  for (const edge of graphData.edges) {
    degreeMap.set(edge.source, (degreeMap.get(edge.source) ?? 0) + 1);
    degreeMap.set(edge.target, (degreeMap.get(edge.target) ?? 0) + 1);
  }
  return degreeMap;
}

function renderCountTable(counts: Map<string, number>): string[] {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => `| ${escapePipe(label)} | ${count} |`);
}

function renderTableRows(rows: string[][]): string[] {
  return rows.map((row) => `| ${row.map(escapePipe).join(" | ")} |`);
}

function escapePipe(value: string): string {
  return escapeMarkdownText(value).replace(/\|/g, "\\|");
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function toNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isFileLevelNode(type: unknown): boolean {
  return type === "module" || type === "document";
}

function getFileTypeLabel(sourceFile: string): string {
  const extension = extname(sourceFile).toLowerCase();
  return extension || "[no extension]";
}

function escapeMarkdownText(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function loadCommunitySummaries(outputDir: string): Map<string, string> {
  const summaryPath = join(outputDir, "community_summaries.json");
  if (!existsSync(summaryPath)) return new Map();

  try {
    const raw = readFileSync(summaryPath, "utf-8");
    const summaries = JSON.parse(raw) as LoadedCommunitySummary[];
    const map = new Map<string, string>();
    for (const s of summaries) {
      const centeredMatch = s.summary.match(/Centered around ([^.]+)/);
      let name: string;
      if (centeredMatch) {
        name = centeredMatch[1]!.trim();
      } else {
        let cleaned = s.summary.replace(/^Community\s+\d+[\s,—-]+(?:is\s+)?/i, "");
        cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
        name = cleaned.split(/[.!?\n]/)[0]?.trim() ?? "";
      }
      if (name.length > 0) {
        map.set(String(s.id), name.length > 80 ? name.slice(0, 77) + "..." : name);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}
