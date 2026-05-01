/**
 * Community summary generation.
 *
 * Two modes:
 * 1. Algorithmic (always available): Template-based summaries from node metadata
 * 2. LLM-enhanced (when node-llama-cpp available): Rich natural language summaries
 *
 * Also generates node descriptions for high-degree nodes.
 * Community summaries and node descriptions are fully independent features.
 */
import { log } from "../shared/utils.js";
import type { CommunitySummariesConfig, NodeDescriptionsConfig, GraphNode } from "../shared/types.js";
import type { LlmEngine } from "./llm-engine.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CommunitySummary {
  id: string;
  nodeCount: number;
  summary: string;
  hub_nodes: string[];
  primary_path: string;
  repos: string[];
}

export interface NodeDescription {
  id: string;
  description: string;
}

export interface CommunityData {
  id: string;
  nodes: GraphNode[];
}

// ─── Summary Generator ───────────────────────────────────────────────────────

export class SummaryGenerator {
  private summariesConfig: CommunitySummariesConfig;
  private descriptionsConfig: NodeDescriptionsConfig;
  private summariesLlm: LlmEngine | null;
  private descriptionsLlm: LlmEngine | null;

  constructor(
    summariesConfig: CommunitySummariesConfig,
    descriptionsConfig: NodeDescriptionsConfig,
    summariesLlm: LlmEngine | null,
    descriptionsLlm: LlmEngine | null,
  ) {
    this.summariesConfig = summariesConfig;
    this.descriptionsConfig = descriptionsConfig;
    this.summariesLlm = summariesLlm;
    this.descriptionsLlm = descriptionsLlm;
  }

  /**
   * Generate summaries for all communities.
   */
  async generateCommunitySummaries(communities: CommunityData[]): Promise<CommunitySummary[]> {
    if (!this.summariesConfig.enabled) {
      log.info("Community summaries disabled (community_summaries.enabled=false)");
      return [];
    }

    // Limit to top N communities by size (largest first) to avoid LLM timeout
    const maxNumber = this.summariesConfig.max_number;
    const sorted = [...communities].sort((a, b) => b.nodes.length - a.nodes.length);
    const selected = maxNumber > 0 ? sorted.slice(0, maxNumber) : sorted;

    const mode = this.summariesLlm?.isAvailable ? "LLM" : "algorithmic";
    log.info(`Generating community summaries (${selected.length}/${communities.length} communities, max=${maxNumber}, mode=${mode})...`);

    const summaries: CommunitySummary[] = [];
    const startTime = Date.now();
    const progressInterval = computeProgressInterval(selected.length);

    for (let i = 0; i < selected.length; i++) {
      const summary = await this.summarizeCommunity(selected[i]!);
      summaries.push(summary);

      if ((i + 1) % progressInterval === 0 || i === selected.length - 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const avgMs = ((Date.now() - startTime) / (i + 1)).toFixed(0);
        const remaining = (((Date.now() - startTime) / (i + 1)) * (selected.length - i - 1) / 1000).toFixed(0);
        log.info(`  Community summaries: ${i + 1}/${selected.length} (${elapsed}s elapsed, ~${avgMs}ms/item, ~${remaining}s remaining)`);
      }
    }

    log.info(`  ✓ ${summaries.length} community summaries generated in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    return summaries;
  }

  /**
   * Generate descriptions for high-degree nodes.
   */
  async generateNodeDescriptions(
    nodes: GraphNode[],
    edgeCounts: Map<string, number>,
  ): Promise<NodeDescription[]> {
    if (!this.descriptionsConfig.enabled) {
      log.info("Node descriptions skipped: node_descriptions.enabled=false");
      return [];
    }

    // Select top N% nodes by degree
    const threshold = this.descriptionsConfig.threshold;
    const sorted = [...edgeCounts.entries()].sort((a, b) => b[1] - a[1]);
    const cutoff = Math.ceil(sorted.length * (1 - threshold));
    const topNodeIds = new Set(sorted.slice(0, cutoff).map(([id]) => id));

    const targetNodes = nodes.filter(n => topNodeIds.has(n.id));
    log.info(`Node description selection: threshold=${threshold}, edgeCounts=${edgeCounts.size}, cutoff=${cutoff}, candidates=${topNodeIds.size}, matched=${targetNodes.length}`);

    if (targetNodes.length === 0) {
      log.info("Node descriptions skipped: no nodes above degree threshold");
      return [];
    }

    const llm = this.descriptionsLlm;
    const mode = llm?.isAvailable ? "LLM" : "algorithmic";
    log.info(`Generating node descriptions (${targetNodes.length} high-degree nodes, mode=${mode})...`);

    const descriptions: NodeDescription[] = [];
    const startTime = Date.now();
    const progressInterval = computeProgressInterval(targetNodes.length);
    let llmCount = 0;
    let fallbackCount = 0;

    if (llm?.isAvailable) {
      // LLM-enhanced descriptions (sequential with progress)
      for (let i = 0; i < targetNodes.length; i++) {
        const node = targetNodes[i]!;
        const degree = edgeCounts.get(node.id) ?? 0;

        const result = await llm.generate({
          systemPrompt: "You are a technical documentation writer. Generate a concise one-sentence description of the given code symbol based on its metadata. Be specific about its purpose.",
          userPrompt: this.composeNodePrompt(node),
          maxTokens: 100,
          temperature: 0.3,
        });

        if (result) {
          descriptions.push({ id: node.id, description: result });
          llmCount++;
        } else {
          descriptions.push({ id: node.id, description: this.algorithmicNodeDescription(node, degree) });
          fallbackCount++;
        }

        // Abort if LLM is consistently failing (first 10 all null)
        if (i === 9 && llmCount === 0) {
          log.warn("  LLM failed for first 10 nodes — switching to algorithmic for remaining");
          for (let j = i + 1; j < targetNodes.length; j++) {
            const n = targetNodes[j]!;
            descriptions.push({ id: n.id, description: this.algorithmicNodeDescription(n, edgeCounts.get(n.id) ?? 0) });
            fallbackCount++;
          }
          break;
        }

        if ((i + 1) % progressInterval === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const avgMs = ((Date.now() - startTime) / (i + 1)).toFixed(0);
          const remaining = (((Date.now() - startTime) / (i + 1)) * (targetNodes.length - i - 1) / 1000).toFixed(0);
          log.info(`  Node descriptions: ${i + 1}/${targetNodes.length} (${elapsed}s, ~${avgMs}ms/item, ~${remaining}s remaining, LLM=${llmCount} algo=${fallbackCount})`);
        }
      }
    } else {
      // Algorithmic fallback
      for (let i = 0; i < targetNodes.length; i++) {
        const node = targetNodes[i]!;
        descriptions.push({
          id: node.id,
          description: this.algorithmicNodeDescription(node, edgeCounts.get(node.id) ?? 0),
        });
        fallbackCount++;

        if ((i + 1) % progressInterval === 0) {
          log.info(`  Node descriptions: ${i + 1}/${targetNodes.length} (algorithmic)`);
        }
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log.info(`  ✓ ${descriptions.length} node descriptions generated in ${elapsed}s (LLM=${llmCount}, algorithmic=${fallbackCount})`);
    return descriptions;
  }

  private async summarizeCommunity(community: CommunityData): Promise<CommunitySummary> {
    const nodes = community.nodes;
    const hubNodes = this.findHubs(nodes);
    const primaryPath = this.findPrimaryPath(nodes);
    const repos = [...new Set(nodes.filter(n => n.repo).map(n => n.repo!))];

    const algorithmicSummary = this.algorithmicCommunitySummary(
      nodes.length,
      hubNodes,
      primaryPath,
      repos,
    );

    // Try LLM enhancement
    let summary = algorithmicSummary;
    if (this.summariesLlm?.isAvailable && nodes.length >= 3) {
      const llmSummary = await this.summariesLlm.generate({
        systemPrompt: "You are a software architect. Generate a concise 1-2 sentence summary of a code community (cluster of related symbols). Focus on the community's purpose and role in the architecture.",
        userPrompt: this.composeCommunityPrompt(community),
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
      hub_nodes: hubNodes.map(n => n.label),
      primary_path: primaryPath,
      repos,
    };
  }

  // ─── Algorithmic Fallback ────────────────────────────────────────────────────

  private algorithmicCommunitySummary(
    nodeCount: number,
    hubs: GraphNode[],
    primaryPath: string,
    repos: string[],
  ): string {
    const hubNames = hubs.slice(0, 3).map(n => n.label).join(", ");
    const repoStr = repos.length > 0 ? ` Spans ${repos.join(", ")}.` : "";
    return `${nodeCount} nodes cluster. Centered around ${hubNames} in ${primaryPath}.${repoStr}`;
  }

  private algorithmicNodeDescription(node: GraphNode, degree: number): string {
    const typeLabel = node.type.charAt(0).toUpperCase() + node.type.slice(1);
    const location = node.source_file ? ` in ${node.source_file}` : "";
    return `${typeLabel} with ${degree} connections${location}.`;
  }

  // ─── LLM Prompt Composition ──────────────────────────────────────────────────

  private composeCommunityPrompt(community: CommunityData): string {
    const nodes = community.nodes;
    const types = this.countTypes(nodes);
    const hubs = this.findHubs(nodes).slice(0, 5);
    const primaryPath = this.findPrimaryPath(nodes);

    const lines: string[] = [
      `Community ${community.id} contains ${nodes.length} symbols:`,
      `Types: ${Object.entries(types).map(([t, c]) => `${c} ${t}s`).join(", ")}`,
      `Hub nodes: ${hubs.map(n => `${n.label} (${n.type})`).join(", ")}`,
      `Primary path: ${primaryPath}`,
    ];

    // Add a sample of node labels
    const sample = nodes.slice(0, 15).map(n => `  - ${n.label} (${n.type})`);
    lines.push("Sample nodes:", ...sample);

    return lines.join("\n");
  }

  private composeNodePrompt(node: GraphNode): string {
    const lines: string[] = [
      `Symbol: ${node.label}`,
      `Type: ${node.type}`,
    ];
    if (node.source_file) lines.push(`File: ${node.source_file}`);
    if (node.properties?.signature) lines.push(`Signature: ${node.properties.signature}`);
    if (node.properties?.docstring) lines.push(`Docstring: ${String(node.properties.docstring).slice(0, 200)}`);
    if (node.properties?.bases) lines.push(`Bases: ${node.properties.bases}`);

    return lines.join("\n");
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private findHubs(nodes: GraphNode[]): GraphNode[] {
    // Hubs = nodes with most connections (we don't have edge info here, use properties)
    // Fallback: just take the first few by type priority (class > function > module)
    const priority: Record<string, number> = { class: 3, module: 2, function: 1, method: 0 };
    return [...nodes]
      .sort((a, b) => (priority[b.type] ?? 0) - (priority[a.type] ?? 0))
      .slice(0, 5);
  }

  private findPrimaryPath(nodes: GraphNode[]): string {
    // Find most common directory prefix
    const paths = nodes.filter(n => n.source_file).map(n => n.source_file!);
    if (paths.length === 0) return "(unknown)";

    // Take the most common first directory component
    const dirs = paths.map(p => p.replace(/\\/g, "/").split("/").slice(0, -1).join("/"));
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

    return maxDir || (paths[0] ?? "").replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  }

  private countTypes(nodes: GraphNode[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const node of nodes) {
      counts[node.type] = (counts[node.type] ?? 0) + 1;
    }
    return counts;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute a sensible progress logging interval:
 * ≤10 items → every 5, ≤50 → every 10, ≤200 → every 25, ≤1000 → every 100, >1000 → every 250
 */
function computeProgressInterval(total: number): number {
  if (total <= 10) return 5;
  if (total <= 50) return 10;
  if (total <= 200) return 25;
  if (total <= 1000) return 100;
  return 250;
}
