/**
 * Step 0: Compute graph metrics — candidate classification and inter-community edge density.
 *
 * Produces: .enrich/candidates.json, .enrich/edge-density.json
 * Invalidates .enrich/ when graph.json hash differs from sealed hash.
 */
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { GraphData } from "../../shared/types.js";
import { atomicWriteJson } from "../../shared/atomic-write.js";
import { hashFile, readHashFile } from "../cache/utils.js";
import type { CandidatesFile, EdgeDensityFile, CandidateClassification, EdgeDensityEntry } from "./types.js";

export interface MetricsOptions {
  outputDir: string;
  candidateThreshold: number;
}

export function runMetrics(options: MetricsOptions): { candidateCount: number; totalNodes: number } {
  const { outputDir, candidateThreshold } = options;
  const enrichDir = join(outputDir, ".enrich");
  const graphJsonPath = join(outputDir, "graph.json");

  // Invalidation check: if graph.json hash differs from sealed, delete .enrich/
  if (existsSync(enrichDir)) {
    const currentHash = hashFile(graphJsonPath);
    const sealedHash = readHashFile(join(outputDir, ".cache", "enrich-input-hash.txt"));
    if (!sealedHash || currentHash !== sealedHash) {
      rmSync(enrichDir, { recursive: true, force: true });
    }
  }

  // Skip if already computed
  const candidatesPath = join(enrichDir, "candidates.json");
  const edgeDensityPath = join(enrichDir, "edge-density.json");
  if (existsSync(candidatesPath) && existsSync(edgeDensityPath)) {
    const existing = JSON.parse(readFileSync(candidatesPath, "utf-8")) as CandidatesFile;
    return { candidateCount: existing.candidateCount, totalNodes: existing.totalNodes };
  }

  mkdirSync(enrichDir, { recursive: true });

  const graphData = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as GraphData;

  // Build adjacency index
  const nodeEdges = new Map<string, { internal: number; external: number; community: string }>();
  for (const node of graphData.nodes) {
    nodeEdges.set(node.id, { internal: 0, external: 0, community: node.community ?? "unclustered" });
  }

  for (const edge of graphData.edges) {
    const sourceInfo = nodeEdges.get(edge.source);
    const targetInfo = nodeEdges.get(edge.target);
    if (!sourceInfo || !targetInfo) continue;

    if (sourceInfo.community === targetInfo.community) {
      sourceInfo.internal++;
      targetInfo.internal++;
    } else {
      sourceInfo.external++;
      targetInfo.external++;
    }
  }

  // Classify nodes
  const candidates: CandidateClassification[] = [];
  for (const [nodeId, info] of nodeEdges) {
    const total = info.internal + info.external;
    const boundaryRatio = total > 0 ? info.external / total : 0;
    candidates.push({
      nodeId,
      boundaryRatio,
      status: boundaryRatio >= candidateThreshold ? "candidate" : "stable",
      internalDegree: info.internal,
      externalDegree: info.external,
    });
  }

  const candidateCount = candidates.filter((c) => c.status === "candidate").length;
  const candidatesFile: CandidatesFile = {
    threshold: candidateThreshold,
    totalNodes: candidates.length,
    candidates,
    stableCount: candidates.length - candidateCount,
    candidateCount,
  };

  // Compute inter-community edge density
  const densityMap = new Map<string, number>();
  for (const edge of graphData.edges) {
    const sourceComm = nodeEdges.get(edge.source)?.community ?? "unclustered";
    const targetComm = nodeEdges.get(edge.target)?.community ?? "unclustered";
    if (sourceComm === targetComm) continue;
    const key = [sourceComm, targetComm].sort().join("\u2194");
    densityMap.set(key, (densityMap.get(key) ?? 0) + 1);
  }

  const pairs: EdgeDensityEntry[] = [];
  for (const [key, count] of densityMap) {
    const [a, b] = key.split("\u2194");
    pairs.push({ communityA: a!, communityB: b!, edgeCount: count });
  }
  pairs.sort((a, b) => b.edgeCount - a.edgeCount);

  const edgeDensityFile: EdgeDensityFile = { pairs };

  atomicWriteJson(candidatesPath, candidatesFile);
  atomicWriteJson(edgeDensityPath, edgeDensityFile);

  return { candidateCount, totalNodes: candidates.length };
}
