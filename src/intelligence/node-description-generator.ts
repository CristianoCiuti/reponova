/**
 * Node description generator.
 */
import { log, ProgressTimer } from "../shared/utils.js";
import type { NodeDescriptionsConfig, GraphNode } from "../shared/types.js";
import type { LlmEngine } from "./llm-engine.js";

export interface NodeDescription {
  id: string;
  description: string;
}

export class NodeDescriptionGenerator {
  private config: NodeDescriptionsConfig;
  private llm: LlmEngine | null;

  constructor(config: NodeDescriptionsConfig, llm: LlmEngine | null) {
    this.config = config;
    this.llm = llm;
  }

  async generate(nodes: GraphNode[], edgeCounts: Map<string, number>): Promise<NodeDescription[]> {
    const threshold = this.config.threshold;
    const sorted = [...edgeCounts.entries()].sort((a, b) => b[1] - a[1]);
    const cutoff = Math.ceil(sorted.length * (1 - threshold));
    const topNodeIds = new Set(sorted.slice(0, cutoff).map(([id]) => id));

    const targetNodes = nodes.filter((n) => topNodeIds.has(n.id));
    log.info(
      `Node description selection: threshold=${threshold}, edgeCounts=${edgeCounts.size}, cutoff=${cutoff}, candidates=${topNodeIds.size}, matched=${targetNodes.length}`,
    );

    if (targetNodes.length === 0) {
      log.info("Node descriptions skipped: no nodes above degree threshold");
      return [];
    }

    const mode = this.llm?.isAvailable ? "LLM" : "algorithmic";
    log.info(`Generating node descriptions (${targetNodes.length} high-degree nodes, mode=${mode})...`);

    if (this.llm?.isAvailable) {
      return this.generateWithLlm(targetNodes, edgeCounts);
    }
    return this.generateAlgorithmic(targetNodes, edgeCounts);
  }

  private async generateWithLlm(
    nodes: GraphNode[],
    edgeCounts: Map<string, number>,
  ): Promise<NodeDescription[]> {
    const descriptions: NodeDescription[] = [];
    const timer = new ProgressTimer(nodes.length);
    const progressInterval = computeProgressInterval(nodes.length);
    let llmCount = 0;
    let fallbackCount = 0;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const degree = edgeCounts.get(node.id) ?? 0;

      const result = await this.llm!.generate({
        systemPrompt:
          "You are a technical documentation writer. Generate a concise one-sentence description of the given code symbol based on its metadata. Be specific about its purpose.",
        userPrompt: composeNodePrompt(node),
        maxTokens: 100,
        temperature: 0.3,
      });

      if (result) {
        descriptions.push({ id: node.id, description: result });
        llmCount++;
      } else {
        descriptions.push({ id: node.id, description: algorithmicDescription(node, degree) });
        fallbackCount++;
      }

      if (i === 9 && llmCount === 0) {
        log.warn("  LLM failed for first 10 nodes — switching to algorithmic for remaining");
        for (let j = i + 1; j < nodes.length; j++) {
          const n = nodes[j]!;
          descriptions.push({ id: n.id, description: algorithmicDescription(n, edgeCounts.get(n.id) ?? 0) });
          fallbackCount++;
        }
        break;
      }

      if ((i + 1) % progressInterval === 0) {
        const { elapsed, avgMs, remaining } = timer.tick(i);
        log.info(
          `  Node descriptions: ${i + 1}/${nodes.length} (${elapsed}s, ~${avgMs}ms/item, ~${remaining}s remaining, LLM=${llmCount} algo=${fallbackCount})`,
        );
      }
    }

    log.info(`  ✓ ${descriptions.length} node descriptions generated in ${timer.elapsedSec()}s (LLM=${llmCount}, algorithmic=${fallbackCount})`);
    return descriptions;
  }

  private generateAlgorithmic(nodes: GraphNode[], edgeCounts: Map<string, number>): NodeDescription[] {
    const descriptions: NodeDescription[] = [];
    const timer = new ProgressTimer(nodes.length);
    const progressInterval = computeProgressInterval(nodes.length);

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      descriptions.push({
        id: node.id,
        description: algorithmicDescription(node, edgeCounts.get(node.id) ?? 0),
      });

      if ((i + 1) % progressInterval === 0) {
        log.info(`  Node descriptions: ${i + 1}/${nodes.length} (algorithmic)`);
      }
    }

    log.info(`  ✓ ${descriptions.length} node descriptions generated in ${timer.elapsedSec()}s (LLM=0, algorithmic=${descriptions.length})`);
    return descriptions;
  }
}

function algorithmicDescription(node: GraphNode, degree: number): string {
  const typeLabel = node.type.charAt(0).toUpperCase() + node.type.slice(1);
  const location = node.source_file ? ` in ${node.source_file}` : "";
  return `${typeLabel} with ${degree} connections${location}.`;
}

function composeNodePrompt(node: GraphNode): string {
  const lines: string[] = [`Symbol: ${node.label}`, `Type: ${node.type}`];
  if (node.source_file) lines.push(`File: ${node.source_file}`);
  if (node.signature) lines.push(`Signature: ${node.signature}`);
  if (node.docstring) lines.push(`Docstring: ${String(node.docstring).slice(0, 200)}`);
  if (node.bases) lines.push(`Bases: ${node.bases}`);
  return lines.join("\n");
}

function computeProgressInterval(total: number): number {
  if (total <= 10) return 5;
  if (total <= 50) return 10;
  if (total <= 200) return 25;
  if (total <= 1000) return 100;
  return 250;
}
