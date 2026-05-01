import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import type Graph from "graphology";
import type { CommunityResult } from "../extract/community.js";

export interface GenerateGraphReportOptions {
  graph: Graph;
  communities: CommunityResult;
  outputDir: string;
  outputPath: string;
}

interface RankedCommunity {
  id: number;
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

export function generateGraphReport(options: GenerateGraphReportOptions): void {
  const { graph, communities, outputDir, outputPath } = options;
  const repoNames = new Set<string>();
  const edgeTypeCounts = new Map<string, number>();
  const crossRepoCounts = new Map<string, number>();
  const fileTypeCounts = new Map<string, number>();
  const filePaths = new Set<string>();
  const seenFiles = new Set<string>();
  let crossRepoEdgeCount = 0;

  graph.forEachNode((_nodeId, attrs) => {
    const repo = toNonEmptyString(attrs.repo);
    const sourceFile = toNonEmptyString(attrs.source_file);

    if (repo) repoNames.add(repo);
    if (sourceFile) filePaths.add(sourceFile);

    if (sourceFile && !seenFiles.has(sourceFile) && isFileLevelNode(attrs.type)) {
      seenFiles.add(sourceFile);
      incrementCount(fileTypeCounts, getFileTypeLabel(sourceFile));
    }
  });

  graph.forEachEdge((_edgeId, attrs, source, target) => {
    const relation = toNonEmptyString(attrs.relation) || "unknown";
    incrementCount(edgeTypeCounts, relation);

    const sourceRepo = toNonEmptyString(graph.getNodeAttribute(source, "repo"));
    const targetRepo = toNonEmptyString(graph.getNodeAttribute(target, "repo"));
    if (sourceRepo && targetRepo && sourceRepo !== targetRepo) {
      crossRepoEdgeCount++;
      incrementCount(crossRepoCounts, `${sourceRepo} → ${targetRepo}`);
    }
  });

  const topGodNodes = graph
    .nodes()
    .map((nodeId) => {
      const attrs = graph.getNodeAttributes(nodeId);
      return {
        label: toNonEmptyString(attrs.label) || nodeId,
        type: toNonEmptyString(attrs.type) || "unknown",
        repo: toNonEmptyString(attrs.repo) || "-",
        degree: graph.degree(nodeId),
      };
    })
    .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label))
    .slice(0, 15);

  // Load community summaries if intelligence layer produced them
  const summaryMap = loadCommunitySummaries(outputDir);

  const rankedCommunities: RankedCommunity[] = Array.from(communities.communities.entries())
    .map(([id, members]) => {
      const rankedMembers = members
        .filter((nodeId) => graph.hasNode(nodeId))
        .map((nodeId) => ({
          label: toNonEmptyString(graph.getNodeAttribute(nodeId, "label")) || nodeId,
          degree: graph.degree(nodeId),
          repo: toNonEmptyString(graph.getNodeAttribute(nodeId, "repo")),
          type: toNonEmptyString(graph.getNodeAttribute(nodeId, "type")),
        }))
        .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));

      const repos = Array.from(new Set(rankedMembers.map((member) => member.repo).filter(Boolean) as string[])).sort();

      // Use LLM-generated summary as community name if available, fallback to top members
      const llmSummary = summaryMap.get(String(id));
      let name: string;
      if (llmSummary) {
        name = llmSummary;
      } else {
        const nameSeed = rankedMembers
          .filter((member) => member.type !== "module" && member.type !== "document")
          .slice(0, 2)
          .map((member) => member.label);
        name = nameSeed.length > 0 ? nameSeed.join(" / ") : `Community ${id}`;
      }

      return {
        id,
        members,
        name,
        repos,
        keyMembers: rankedMembers.slice(0, 5).map((member) => `${member.label} (${member.degree})`),
      };
    })
    .sort((a, b) => b.members.length - a.members.length || a.id - b.id)
    .slice(0, 10);

  const lines = [
    "# Graph Architecture Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Overall Stats",
    "",
    `- Nodes: ${graph.order}`,
    `- Edges: ${graph.size}`,
    `- Communities: ${communities.count}`,
    `- Repos: ${repoNames.size}`,
    `- Files: ${filePaths.size}`,
    `- Cross-repo edges: ${crossRepoEdgeCount}`,
    `- Modularity: ${communities.modularity.toFixed(4)}`,
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
  return value
    .replace(/\|/g, "\\|");
}

/**
 * Load community_summaries.json if it exists (produced by intelligence layer).
 * Returns a map of community id → first sentence of summary (for use as name).
 */
function loadCommunitySummaries(outputDir: string): Map<string, string> {
  const summaryPath = join(outputDir, "community_summaries.json");
  if (!existsSync(summaryPath)) return new Map();

  try {
    const raw = readFileSync(summaryPath, "utf-8");
    const summaries = JSON.parse(raw) as LoadedCommunitySummary[];
    const map = new Map<string, string>();
    for (const s of summaries) {
      // Extract a meaningful name from the summary.
      // Algorithmic format: "NNN nodes cluster. Centered around X, Y, Z in path. Spans repos."
      // LLM format: "Community N is a cluster of... focused on..."
      // Strategy: prefer "Centered around..." clause, else strip redundant "Community N is..." prefix and use first sentence.
      const centeredMatch = s.summary.match(/Centered around ([^.]+)/);
      let name: string;
      if (centeredMatch) {
        name = centeredMatch[1]!.trim();
      } else {
        // Strip "Community N is/are/,/—" prefix (the report header already shows the ID)
        let cleaned = s.summary.replace(/^Community\s+\d+[\s,—-]+(?:is\s+)?/i, "");
        // Capitalize first letter after stripping
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
