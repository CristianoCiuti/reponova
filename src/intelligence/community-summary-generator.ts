/**
 * Community summary generator.
 */
import { toPosix } from "../shared/paths.js";
import { log, ProgressTimer } from "../shared/utils.js";
import type { CommunitySummariesConfig, GraphNode } from "../shared/types.js";
import type { LlmEngine } from "./llm-engine.js";

export interface CommunitySummary {
  id: string;
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

export class CommunitySummaryGenerator {
  private config: CommunitySummariesConfig;
  private llm: LlmEngine | null;

  constructor(config: CommunitySummariesConfig, llm: LlmEngine | null) {
    this.config = config;
    this.llm = llm;
  }

  async generate(communities: CommunityData[]): Promise<CommunitySummary[]> {
    const maxNumber = this.config.max_number;
    const sorted = [...communities].sort((a, b) => b.nodes.length - a.nodes.length);
    const selected = maxNumber > 0 ? sorted.slice(0, maxNumber) : sorted;

    const mode = this.llm?.isAvailable ? "LLM" : "algorithmic";
    log.info(`Generating community summaries (${selected.length}/${communities.length} communities, max=${maxNumber}, mode=${mode})...`);

    const summaries: CommunitySummary[] = [];
    const timer = new ProgressTimer(selected.length);
    const progressInterval = computeProgressInterval(selected.length);

    for (let i = 0; i < selected.length; i++) {
      const summary = await this.summarizeCommunity(selected[i]!);
      summaries.push(summary);

      if ((i + 1) % progressInterval === 0 || i === selected.length - 1) {
        const { elapsed, avgMs, remaining } = timer.tick(i);
        log.info(`  Community summaries: ${i + 1}/${selected.length} (${elapsed}s elapsed, ~${avgMs}ms/item, ~${remaining}s remaining)`);
      }
    }

    log.info(`  ✓ ${summaries.length} community summaries generated in ${timer.elapsedSec()}s`);
    return summaries;
  }

  private async summarizeCommunity(community: CommunityData): Promise<CommunitySummary> {
    const nodes = community.nodes;
    const hubNodes = findHubs(nodes);
    const primaryPath = findPrimaryPath(nodes);
    const repos = [...new Set(nodes.filter((n) => n.repo).map((n) => n.repo!))];

    const algorithmicSummary = buildAlgorithmicSummary(nodes.length, hubNodes, primaryPath, repos);

    let summary = algorithmicSummary;
    if (this.llm?.isAvailable && nodes.length >= 3) {
      const llmSummary = await this.llm.generate({
        systemPrompt:
          "You are a software architect. Generate a concise 1-2 sentence summary of a code community (cluster of related symbols). Focus on the community's purpose and role in the architecture.",
        userPrompt: composeCommunityPrompt(community),
        maxTokens: 150,
        temperature: 0.5,
      });

      if (llmSummary) {
        summary = llmSummary.trim();
      }
    }

    return {
      id: community.id,
      nodeCount: nodes.length,
      summary,
      hub_nodes: hubNodes.map((n) => n.label),
      primary_path: primaryPath,
      repos,
    };
  }
}

function buildAlgorithmicSummary(
  nodeCount: number,
  hubs: GraphNode[],
  primaryPath: string,
  repos: string[],
): string {
  const hubNames = hubs.slice(0, 3).map((n) => n.label).join(", ");
  const repoStr = repos.length > 0 ? ` Spans ${repos.join(", ")}.` : "";
  return `${nodeCount} nodes cluster. Centered around ${hubNames} in ${primaryPath}.${repoStr}`;
}

function composeCommunityPrompt(community: CommunityData): string {
  const nodes = community.nodes;
  const types = countTypes(nodes);
  const hubs = findHubs(nodes).slice(0, 5);
  const primaryPath = findPrimaryPath(nodes);

  const lines: string[] = [
    `Community ${community.id} contains ${nodes.length} symbols:`,
    `Types: ${Object.entries(types).map(([t, c]) => `${c} ${t}s`).join(", ")}`,
    `Hub nodes: ${hubs.map((n) => `${n.label} (${n.type})`).join(", ")}`,
    `Primary path: ${primaryPath}`,
  ];

  const sample = nodes.slice(0, 15).map((n) => `  - ${n.label} (${n.type})`);
  lines.push("Sample nodes:", ...sample);

  return lines.join("\n");
}

function findHubs(nodes: GraphNode[]): GraphNode[] {
  const priority: Record<string, number> = { class: 3, module: 2, function: 1, method: 0 };
  return [...nodes]
    .sort((a, b) => (priority[b.type] ?? 0) - (priority[a.type] ?? 0))
    .slice(0, 5);
}

function findPrimaryPath(nodes: GraphNode[]): string {
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

function countTypes(nodes: GraphNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes) {
    counts[node.type] = (counts[node.type] ?? 0) + 1;
  }
  return counts;
}

function computeProgressInterval(total: number): number {
  if (total <= 10) return 5;
  if (total <= 50) return 10;
  if (total <= 200) return 25;
  if (total <= 1000) return 100;
  return 250;
}
