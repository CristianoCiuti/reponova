/**
 * Community summary generator.
 */
import { log, ProgressTimer } from "../shared/utils.js";
import type { EnrichConfig, GraphNode } from "../shared/types.js";
import type { LlmProvider } from "./llm-provider.js";
import {
  buildAlgorithmicSummary,
  findHubs,
  findPrimaryPath,
  type CommunityData,
  type CommunitySummary,
} from "../pipeline/enrich/algorithmic.js";

export type CommunitySummaryGeneratorConfig = Pick<EnrichConfig, "enabled" | "max_communities" | "provider">;
export type { CommunitySummary, CommunityData };

export class CommunitySummaryGenerator {
  private config: CommunitySummaryGeneratorConfig;
  private llm: LlmProvider | null;

  constructor(config: CommunitySummaryGeneratorConfig, llm: LlmProvider | null) {
    this.config = config;
    this.llm = llm;
  }

  async generate(communities: CommunityData[]): Promise<CommunitySummary[]> {
    const maxNumber = this.config.max_communities;
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
    const algorithmicLabel = `Community ${community.id}`;

    let summary = algorithmicSummary;
    let label = algorithmicLabel;

    if (this.llm?.isAvailable && nodes.length >= 3) {
      const llmResult = await this.llm.generate({
        systemPrompt:
          "You are a software architect. For a code community (cluster of related symbols), provide:\n" +
          "1. A short label (3-5 words max) that names the community's purpose\n" +
          "2. A concise 1-2 sentence summary focusing on architecture role\n\n" +
          "IMPORTANT: Do NOT reference the community by name, ID, or label in your response.\n" +
          "Write the summary as a direct description, not \"Community X is/does...\".\n" +
          "Good: \"Handles JWT authentication and session lifecycle.\"\n" +
          "Bad: \"Community 0 is responsible for authentication.\"\n\n" +
          "Format your response exactly as:\n" +
          "Label: <short label>\n" +
          "Summary: <summary text>",
        userPrompt: composeCommunityPrompt(community),
        maxTokens: 200,
        temperature: 0.5,
      });

      if (llmResult) {
        const parsed = parseLlmResponse(llmResult.trim());
        if (parsed.summary) summary = parsed.summary;
        if (parsed.label) label = parsed.label;
      }
    }

    return {
      id: community.id,
      label,
      nodeCount: nodes.length,
      summary,
      hub_nodes: hubNodes.map((n) => n.label),
      primary_path: primaryPath,
      repos,
    };
  }
}

/** Parse LLM response that should contain "Label: ..." and "Summary: ..." lines. */
export function parseLlmResponse(text: string): { label?: string; summary?: string } {
  const labelMatch = text.match(/^Label:\s*(.+)$/m);
  const summaryMatch = text.match(/^Summary:\s*(.+(?:\n(?!Label:).+)*)$/m);

  return {
    label: labelMatch?.[1]?.trim() || undefined,
    summary: summaryMatch?.[1]?.trim() || undefined,
  };
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
