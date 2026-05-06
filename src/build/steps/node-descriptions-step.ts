/**
 * Incremental node descriptions step.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../../shared/atomic-write.js";
import { log } from "../../shared/utils.js";
import type { GraphData, GraphNode } from "../../shared/types.js";
import type { BuildStep, StepContext, StepResult } from "../types.js";
import { NodeDescriptionGenerator, type NodeDescription } from "../intelligence/node-description-generator.js";

export const runNodeDescriptionsStep: BuildStep = async (ctx: StepContext): Promise<StepResult> => {
  const config = ctx.config.build.node_descriptions;
  const descriptionsPath = join(ctx.outputDir, "node_descriptions.json");
  const cachePath = join(ctx.outputDir, ".cache", "node-description-fingerprints.json");

  if (!config.enabled) {
    removeFile(descriptionsPath);
    removeFile(cachePath);
    return { processed: 0, skipped: true, skipReason: "disabled in config" };
  }

  const previous = ctx.previousConfig?.node_descriptions;
  const modelChanged = previous != null && (previous.model ?? null) !== (config.model ?? null);
  const contextSizeChanged = previous != null && previous.context_size !== config.context_size;
  const effectiveForce = ctx.force || modelChanged || ((config.model ?? null) != null && contextSizeChanged);

  const graphData = JSON.parse(readFileSync(ctx.graphJsonPath, "utf-8")) as GraphData;
  const edgeCounts = computeEdgeCounts(graphData);
  if (edgeCounts.size === 0) {
    return { processed: 0, skipped: true, skipReason: "graph has no edges" };
  }

  const targetNodes = selectTargetNodes(graphData.nodes, edgeCounts, config.threshold);
  if (targetNodes.length === 0) {
    atomicWriteJson(descriptionsPath, []);
    atomicWriteJson(cachePath, {});
    return { processed: 0, skipped: true, skipReason: "no qualifying nodes" };
  }

  const previousFingerprints = effectiveForce ? {} : loadFingerprints(cachePath);
  const previousDescriptions = effectiveForce ? new Map<string, string>() : loadDescriptions(descriptionsPath);

  const kept = new Map<string, string>();
  const regenNodes: GraphNode[] = [];
  const nextFingerprints: Record<string, string> = {};

  for (const node of targetNodes) {
    const fingerprint = computeNodeDescriptionFingerprint(node, edgeCounts.get(node.id) ?? 0);
    nextFingerprints[node.id] = fingerprint;

    const previousFingerprint = previousFingerprints[node.id];
    const previousDescription = previousDescriptions.get(node.id);
    if (previousFingerprint === fingerprint && previousDescription) {
      kept.set(node.id, previousDescription);
    } else {
      regenNodes.push(node);
    }
  }

  if (regenNodes.length === 0) {
    const allDescriptions = targetNodes.map<NodeDescription>((node) => ({
      id: node.id,
      description: kept.get(node.id)!,
    }));
    atomicWriteJson(descriptionsPath, allDescriptions);
    atomicWriteJson(cachePath, nextFingerprints);
    return { processed: 0, skipped: true, skipReason: "up to date" };
  }

  const modelUri = config.model ?? null;
  let llm = null;
  if (modelUri && ctx.llmPool) {
    llm = await ctx.llmPool.acquire(modelUri, config.context_size);
    if (!llm) {
      log.info("  Node descriptions LLM not available — using algorithmic");
    }
  }

  const generator = new NodeDescriptionGenerator(config, llm);
  const generated = await generator.generate(regenNodes, edgeCounts);
  const generatedMap = new Map(generated.map((entry) => [entry.id, entry.description]));

  const allDescriptions = targetNodes.map<NodeDescription>((node) => ({
    id: node.id,
    description: generatedMap.get(node.id) ?? kept.get(node.id) ?? "",
  })).filter((entry) => entry.description.length > 0);

  atomicWriteJson(descriptionsPath, allDescriptions);
  atomicWriteJson(cachePath, nextFingerprints);

  return { processed: generated.length, skipped: false };
};

function computeEdgeCounts(graphData: GraphData): Map<string, number> {
  const counts = new Map<string, number>();

  for (const edge of graphData.edges) {
    counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
  }

  return counts;
}

function selectTargetNodes(nodes: GraphNode[], edgeCounts: Map<string, number>, threshold: number): GraphNode[] {
  const sorted = [...edgeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const cutoff = Math.ceil(sorted.length * (1 - threshold));
  const topNodeIds = new Set(sorted.slice(0, cutoff).map(([id]) => id));
  return nodes.filter((node) => topNodeIds.has(node.id));
}

function computeNodeDescriptionFingerprint(node: GraphNode, degree: number): string {
  const input = [
    node.id,
    node.source_file ?? "",
    node.type,
    node.label,
    node.signature ?? "",
    node.docstring ?? "",
    String(degree),
  ].join("|");

  return createHash("sha256").update(input).digest("hex");
}

function loadFingerprints(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function loadDescriptions(path: string): Map<string, string> {
  if (!existsSync(path)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as NodeDescription[];
    return new Map(raw.map((entry) => [entry.id, entry.description]));
  } catch {
    return new Map();
  }
}

function removeFile(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
