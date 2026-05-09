/**
 * node-descriptions phase — generates descriptions for high-degree nodes.
 *
 * Uses per-node content fingerprinting for incremental regeneration.
 * Config invalidation via .cache/node-descriptions-config-hash.txt.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Phase, PhaseContext, PhaseResult } from "../engine/phase.js";
import type { GraphData, GraphNode } from "../../shared/types.js";
import { atomicWriteJson, atomicWriteText } from "../../shared/atomic-write.js";
import { readJsonSafe, readJsonOr } from "../../shared/fs.js";
import { log } from "../../shared/utils.js";
import { NodeDescriptionGenerator, type NodeDescription } from "../../intelligence/node-description-generator.js";
import { LlmEnginePool } from "../../intelligence/llm-engine-pool.js";

export const nodeDescriptionsPhase: Phase = {
  id: "node-descriptions",
  label: "Node Descriptions",
  dependencies: ["communities"],

  async execute(ctx: PhaseContext): Promise<PhaseResult> {
    const { config, outputDir, force } = ctx;
    const ndConfig = config.node_descriptions;
    const descriptionsPath = join(outputDir, "node_descriptions.json");
    const cachePath = join(outputDir, ".cache", "node-description-fingerprints.json");
    const configHashPath = join(outputDir, ".cache", "node-descriptions-config-hash.txt");

    if (!ndConfig.enabled) {
      removeFile(descriptionsPath);
      removeFile(cachePath);
      removeFile(configHashPath);
      return { processed: 0, skipped: true, skipReason: "disabled in config" };
    }

    // Config invalidation
    const currentConfigHash = hashConfigFields(ndConfig.model ?? null, ndConfig.context_size, ndConfig.threshold);
    const configChanged = checkConfigChanged(configHashPath, currentConfigHash);
    const effectiveForce = force || configChanged;

    const graphJsonPath = join(outputDir, "graph.json");
    const graphData = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as GraphData;
    const edgeCounts = computeEdgeCounts(graphData);

    if (edgeCounts.size === 0) {
      return { processed: 0, skipped: true, skipReason: "graph has no edges" };
    }

    const targetNodes = selectTargetNodes(graphData.nodes, edgeCounts, ndConfig.threshold);
    if (targetNodes.length === 0) {
      atomicWriteJson(descriptionsPath, []);
      atomicWriteJson(cachePath, {});
      atomicWriteText(configHashPath, currentConfigHash);
      return { processed: 0, skipped: true, skipReason: "no qualifying nodes" };
    }

    const previousFingerprints = effectiveForce ? {} : loadFingerprints(cachePath);
    const previousDescriptions = effectiveForce ? new Map<string, string>() : loadDescriptions(descriptionsPath);

    const kept = new Map<string, string>();
    const regenNodes: GraphNode[] = [];
    const nextFingerprints: Record<string, string> = {};

    for (const node of targetNodes) {
      const fingerprint = computeNodeFingerprint(node, edgeCounts.get(node.id) ?? 0);
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
      const allDescriptions = targetNodes.map<NodeDescription>((n) => ({
        id: n.id,
        description: kept.get(n.id)!,
      }));
      const existing = loadExistingDescriptions(descriptionsPath);
      if (!descriptionsEqual(existing, allDescriptions)) {
        atomicWriteJson(descriptionsPath, allDescriptions);
        atomicWriteJson(cachePath, nextFingerprints);
      }
      atomicWriteText(configHashPath, currentConfigHash);
      return { processed: 0, skipped: true, skipReason: "up to date" };
    }

    // Acquire LLM if configured
    const modelUri = ndConfig.model ?? null;
    let llm = null;
    const llmPool = modelUri ? new LlmEnginePool(config.models) : null;

    try {
      if (modelUri && llmPool) {
        llm = await llmPool.acquire(modelUri, ndConfig.context_size);
        if (!llm) {
          log.info("  Node descriptions LLM not available — using algorithmic");
        }
      }

      const generator = new NodeDescriptionGenerator(ndConfig, llm);
      const generated = await generator.generate(regenNodes, edgeCounts);
      const generatedMap = new Map(generated.map((e) => [e.id, e.description]));

      const allDescriptions = targetNodes
        .map<NodeDescription>((n) => ({
          id: n.id,
          description: generatedMap.get(n.id) ?? kept.get(n.id) ?? "",
        }))
        .filter((e) => e.description.length > 0);

      atomicWriteJson(descriptionsPath, allDescriptions);
      atomicWriteJson(cachePath, nextFingerprints);
      atomicWriteText(configHashPath, currentConfigHash);

      return { processed: generated.length, skipped: false };
    } finally {
      if (llmPool) await llmPool.disposeAll();
    }
  },
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
  return nodes.filter((n) => topNodeIds.has(n.id));
}

function computeNodeFingerprint(node: GraphNode, degree: number): string {
  const input = [node.id, node.source_file ?? "", node.type, node.label, node.signature ?? "", node.docstring ?? "", String(degree)].join("|");
  return createHash("sha256").update(input).digest("hex");
}

function hashConfigFields(model: string | null, contextSize: number, threshold: number): string {
  return createHash("sha256").update(JSON.stringify({ model, contextSize, threshold })).digest("hex");
}

function checkConfigChanged(hashPath: string, currentHash: string): boolean {
  if (!existsSync(hashPath)) return false;
  try { return readFileSync(hashPath, "utf-8").trim() !== currentHash; }
  catch { return false; }
}

function loadFingerprints(path: string): Record<string, string> {
  return readJsonOr<Record<string, string>>(path, {});
}

function loadDescriptions(path: string): Map<string, string> {
  const raw = readJsonSafe<NodeDescription[]>(path);
  return raw ? new Map(raw.map((e) => [e.id, e.description])) : new Map();
}

function loadExistingDescriptions(path: string): NodeDescription[] {
  return readJsonOr<NodeDescription[]>(path, []);
}

function descriptionsEqual(a: NodeDescription[], b: NodeDescription[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function removeFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
