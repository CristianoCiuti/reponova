/**
 * Batch preparation — creates input batch files for each enrichment step.
 *
 * Called by `enrich:prepare <step>`. Reads prerequisites (merged files from prior steps)
 * and writes structured input batches that the agent (or LLM provider) will process.
 */
import { existsSync, readFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config, GraphData } from "../../shared/types.js";
import { atomicWriteJson } from "../../shared/atomic-write.js";
import { packBatches } from "./batcher.js";
import type { CandidatesFile, CommunityProfile, DescriptionEntry } from "./types.js";

export type PrepareStep = "descriptions" | "profiles" | "routing" | "restructure" | "updated-profiles";

export interface PrepareOptions {
  outputDir: string;
  config: Config;
  configDir: string;
}

export interface PrepareResult {
  step: PrepareStep;
  batchCount: number;
  inputDir: string;
}

/**
 * Prepare input batches for a given step.
 * Returns the number of batch files created and their directory.
 */
export function runPrepare(options: PrepareOptions, step: PrepareStep): PrepareResult {
  const { outputDir, config, configDir } = options;
  const enrichDir = join(outputDir, ".enrich");

  switch (step) {
    case "descriptions":
      return prepareDescriptions(enrichDir, outputDir, config, configDir);
    case "profiles":
      return prepareProfiles(enrichDir, outputDir);
    case "routing":
      return prepareRouting(enrichDir, outputDir, config);
    case "restructure":
      return prepareRestructure(enrichDir, outputDir, config);
    case "updated-profiles":
      return prepareUpdatedProfiles(enrichDir);
    default:
      throw new Error(`Unknown prepare step: ${step}`);
  }
}

/**
 * Count existing input batches for a step (for resumability check).
 */
export function countInputBatches(outputDir: string, step: PrepareStep): number {
  const inputDir = join(outputDir, ".enrich", "input", step);
  if (!existsSync(inputDir)) return 0;
  return readdirSync(inputDir).filter((f) => f.endsWith(".json")).length;
}

// ─── Step 1: Descriptions ────────────────────────────────────────────────────

function prepareDescriptions(enrichDir: string, outputDir: string, config: Config, configDir: string): PrepareResult {
  const candidatesPath = join(enrichDir, "candidates.json");
  const graphJsonPath = join(outputDir, "graph.json");

  if (!existsSync(candidatesPath)) {
    throw new Error(`Missing prerequisite: ${candidatesPath}. Run \`reponova enrich:metrics\` first.`);
  }
  if (!existsSync(graphJsonPath)) {
    throw new Error(`Missing prerequisite: ${graphJsonPath}. Run \`reponova build --target communities\` first.`);
  }

  const inputDir = join(enrichDir, "input", "descriptions");
  if (existsSync(inputDir)) rmSync(inputDir, { recursive: true, force: true });
      mkdirSync(inputDir, { recursive: true });

  const graphData = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as GraphData;
  const candidatesFile = JSON.parse(readFileSync(candidatesPath, "utf-8")) as CandidatesFile;

  // Get candidate node IDs
  const candidateIds = new Set(
    candidatesFile.candidates
      .filter((c) => c.status === "candidate")
      .map((c) => c.nodeId),
  );

  // Filter graph nodes to candidates only
  const candidateNodes = graphData.nodes.filter((n) => candidateIds.has(n.id));

  // Resolve repo roots for source code extraction
  const repoRoots = new Map<string, string>();
  for (const repo of config.repos) {
    repoRoots.set(repo.name, resolve(configDir, repo.path));
  }

  // Pack into token-budgeted batches (grouped by directory)
  const batches = packBatches(candidateNodes, repoRoots, config.enrich.description_batch_tokens);

  // Write each batch as an input file
  for (const batch of batches) {
    const fileName = `batch-${String(batch.id).padStart(3, "0")}.json`;
    atomicWriteJson(join(inputDir, fileName), {
      batchId: batch.id,
      totalBatches: batches.length,
      items: batch.items.map((item) => ({
        nodeId: item.nodeId,
        qualifiedName: item.qualifiedName,
        filePath: item.filePath,
        startLine: item.startLine,
        endLine: item.endLine,
        code: item.code,
      })),
    });
  }

  return { step: "descriptions", batchCount: batches.length, inputDir };
}

// ─── Step 2: Profiles ────────────────────────────────────────────────────────

function prepareProfiles(enrichDir: string, outputDir: string): PrepareResult {
  const descriptionsPath = join(enrichDir, "descriptions.json");
  const graphJsonPath = join(outputDir, "graph.json");

  if (!existsSync(descriptionsPath)) {
    throw new Error(`Missing prerequisite: ${descriptionsPath}. Run \`reponova enrich:merge descriptions\` first.`);
  }

  const inputDir = join(enrichDir, "input", "profiles");
  if (existsSync(inputDir)) rmSync(inputDir, { recursive: true, force: true });
      mkdirSync(inputDir, { recursive: true });

  const graphData = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as GraphData;
  const descriptions: DescriptionEntry[] = JSON.parse(readFileSync(descriptionsPath, "utf-8"));
  const descMap = new Map(descriptions.map((d) => [d.id, d.description]));

  // Group nodes by community
  const communities = new Map<string, Array<{ id: string; description: string }>>();
  for (const node of graphData.nodes) {
    const comm = node.community ?? "unclustered";
    if (!communities.has(comm)) communities.set(comm, []);
    communities.get(comm)!.push({ id: node.id, description: descMap.get(node.id) ?? "" });
  }

  // Compute internal edges per community
  const nodeCommMap = new Map(graphData.nodes.map((n) => [n.id, n.community ?? "unclustered"]));
  const commEdges = new Map<string, Array<{ source: string; target: string; type: string }>>();
  for (const edge of graphData.edges) {
    const srcComm = nodeCommMap.get(edge.source);
    const tgtComm = nodeCommMap.get(edge.target);
    if (srcComm && tgtComm && srcComm === tgtComm) {
      if (!commEdges.has(srcComm)) commEdges.set(srcComm, []);
      commEdges.get(srcComm)!.push({ source: edge.source, target: edge.target, type: edge.type });
    }
  }

  // Write one input file per community (>= 3 members, not unclustered)
  let batchId = 0;
  for (const [commId, members] of communities) {
    if (commId === "unclustered" || members.length < 3) continue;
    batchId++;
    const fileName = `community-${String(batchId).padStart(3, "0")}.json`;
    atomicWriteJson(join(inputDir, fileName), {
      communityId: commId,
      members,
      internalEdges: commEdges.get(commId) ?? [],
    });
  }

  return { step: "profiles", batchCount: batchId, inputDir };
}

// ─── Step 3: Routing ─────────────────────────────────────────────────────────

function prepareRouting(enrichDir: string, outputDir: string, config: Config): PrepareResult {
  const candidatesPath = join(enrichDir, "candidates.json");
  const profilesPath = join(enrichDir, "profiles.json");
  const descriptionsPath = join(enrichDir, "descriptions.json");
  const graphJsonPath = join(outputDir, "graph.json");

  for (const [path, cmd] of [
    [profilesPath, "enrich:merge profiles"],
    [descriptionsPath, "enrich:merge descriptions"],
    [candidatesPath, "enrich:metrics"],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(`Missing prerequisite: ${path}. Run \`reponova ${cmd}\` first.`);
    }
  }

  const inputDir = join(enrichDir, "input", "routing");
  if (existsSync(inputDir)) rmSync(inputDir, { recursive: true, force: true });
      mkdirSync(inputDir, { recursive: true });

  const graphData = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as GraphData;
  const candidatesFile = JSON.parse(readFileSync(candidatesPath, "utf-8")) as CandidatesFile;
  const profiles: CommunityProfile[] = JSON.parse(readFileSync(profilesPath, "utf-8"));
  const descriptions: DescriptionEntry[] = JSON.parse(readFileSync(descriptionsPath, "utf-8"));
  const descMap = new Map(descriptions.map((d) => [d.id, d.description]));
  const profileMap = new Map(profiles.map((p) => [p.communityId, p]));
  const nodeCommMap = new Map(graphData.nodes.map((n) => [n.id, n.community ?? "unclustered"]));

  // Collect all candidate IDs (boundary ratio + misfits from profiling)
  const allCandidateIds = new Set(
    candidatesFile.candidates
      .filter((c) => c.status === "candidate")
      .map((c) => c.nodeId),
  );
  for (const p of profiles) {
    for (const misfit of p.misfits) {
      allCandidateIds.add(misfit.nodeId);
    }
  }

  // Compute adjacent communities per candidate
  const nodeAdjacent = new Map<string, Map<string, number>>();
  for (const edge of graphData.edges) {
    for (const [src, tgt] of [[edge.source, edge.target], [edge.target, edge.source]] as [string, string][]) {
      if (allCandidateIds.has(src)) {
        const tgtComm = nodeCommMap.get(tgt) ?? "unclustered";
        const srcComm = nodeCommMap.get(src) ?? "unclustered";
        if (tgtComm !== srcComm) {
          if (!nodeAdjacent.has(src)) nodeAdjacent.set(src, new Map());
          const adj = nodeAdjacent.get(src)!;
          adj.set(tgtComm, (adj.get(tgtComm) ?? 0) + 1);
        }
      }
    }
  }

  // Build candidate list with full context
  const candidateList = [...allCandidateIds].map((nodeId) => ({
    nodeId,
    description: descMap.get(nodeId) ?? "",
    currentCommunity: nodeCommMap.get(nodeId) ?? "unclustered",
    currentCommunityProfile: profileMap.get(nodeCommMap.get(nodeId) ?? "")?.profile ?? "",
    adjacentCommunities: [...(nodeAdjacent.get(nodeId)?.entries() ?? [])]
      .map(([id, count]) => ({ id, edgeCount: count, profile: profileMap.get(id)?.profile ?? "" }))
      .sort((a, b) => b.edgeCount - a.edgeCount)
      .slice(0, 5),
  }));

  // Chunk into batches
  const batchSize = config.enrich.routing_batch_size;
  let batchId = 0;
  for (let i = 0; i < candidateList.length; i += batchSize) {
    batchId++;
    const batch = candidateList.slice(i, i + batchSize);
    const fileName = `batch-${String(batchId).padStart(3, "0")}.json`;
    atomicWriteJson(join(inputDir, fileName), {
      batchId,
      totalBatches: Math.ceil(candidateList.length / batchSize),
      candidates: batch,
    });
  }

  return { step: "routing", batchCount: batchId, inputDir };
}

// ─── Step 4: Restructure ─────────────────────────────────────────────────────

function prepareRestructure(enrichDir: string, outputDir: string, config: Config): PrepareResult {
  const profilesPath = join(enrichDir, "profiles.json");
  const edgeDensityPath = join(enrichDir, "edge-density.json");
  const routingPath = join(enrichDir, "routing.json");
  const graphJsonPath = join(outputDir, "graph.json");

  for (const [path, cmd] of [
    [profilesPath, "enrich:merge profiles"],
    [edgeDensityPath, "enrich:metrics"],
    [routingPath, "enrich:merge routing"],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(`Missing prerequisite: ${path}. Run \`reponova ${cmd}\` first.`);
    }
  }

  const inputDir = join(enrichDir, "input", "restructure");
  if (existsSync(inputDir)) rmSync(inputDir, { recursive: true, force: true });
      mkdirSync(inputDir, { recursive: true });

  const profiles: CommunityProfile[] = JSON.parse(readFileSync(profilesPath, "utf-8"));
  const edgeDensity = JSON.parse(readFileSync(edgeDensityPath, "utf-8")) as { pairs: Array<{ communityA: string; communityB: string; edgeCount: number }> };
  const routing = JSON.parse(readFileSync(routingPath, "utf-8")) as Array<{ action: string; to?: string }>;

  // Compute which communities gained nodes
  const gainedNodes = new Map<string, number>();
  for (const r of routing) {
    if (r.action === "move" && r.to) {
      gainedNodes.set(r.to, (gainedNodes.get(r.to) ?? 0) + 1);
    }
  }

  // Compute size outliers
  const graphData = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as GraphData;
  const commSizes = new Map<string, number>();
  for (const node of graphData.nodes) {
    const c = node.community ?? "unclustered";
    commSizes.set(c, (commSizes.get(c) ?? 0) + 1);
  }
  const sizeValues = [...commSizes.values()].sort((a, b) => a - b);
  const median = sizeValues[Math.floor(sizeValues.length / 2)] ?? 10;
  const sizeOutliers = [...commSizes.entries()]
    .filter(([_, size]) => size > median * 2)
    .map(([id, size]) => ({ communityId: id, nodeCount: size }));

  // Single input file with full context
  atomicWriteJson(join(inputDir, "restructure-input.json"), {
    profiles: profiles.map((p) => ({ communityId: p.communityId, label: p.label, profile: p.profile })),
    topEdgeDensityPairs: edgeDensity.pairs.slice(0, config.enrich.restructure_max_pairs),
    gainedNodes: Object.fromEntries(gainedNodes),
    sizeOutliers,
  });

  return { step: "restructure", batchCount: 1, inputDir };
}

// ─── Step 6: Updated Profiles ────────────────────────────────────────────────

function prepareUpdatedProfiles(enrichDir: string): PrepareResult {
  const modifiedPath = join(enrichDir, "modified-communities.json");
  const graphAppliedPath = join(enrichDir, "graph-applied.json");
  const descriptionsPath = join(enrichDir, "descriptions.json");

  for (const [path, cmd] of [
    [modifiedPath, "enrich:apply"],
    [graphAppliedPath, "enrich:apply"],
    [descriptionsPath, "enrich:merge descriptions"],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(`Missing prerequisite: ${path}. Run \`reponova ${cmd}\` first.`);
    }
  }

  const inputDir = join(enrichDir, "input", "updated-profiles");
  if (existsSync(inputDir)) rmSync(inputDir, { recursive: true, force: true });
      mkdirSync(inputDir, { recursive: true });

  const modified = JSON.parse(readFileSync(modifiedPath, "utf-8")) as { created: string[]; modified: string[] };
  const allModified = new Set([...modified.created, ...modified.modified]);

  if (allModified.size === 0) {
    return { step: "updated-profiles", batchCount: 0, inputDir };
  }

  const graphApplied = JSON.parse(readFileSync(graphAppliedPath, "utf-8")) as GraphData;
  const descriptions: DescriptionEntry[] = JSON.parse(readFileSync(descriptionsPath, "utf-8"));
  const descMap = new Map(descriptions.map((d) => [d.id, d.description]));
  const nodeCommMap = new Map(graphApplied.nodes.map((n) => [n.id, n.community ?? "unclustered"]));

  let batchId = 0;
  for (const commId of allModified) {
    const members = graphApplied.nodes
      .filter((n) => (n.community ?? "unclustered") === commId)
      .map((n) => ({ id: n.id, description: descMap.get(n.id) ?? "" }));
    if (members.length < 3) continue;

    batchId++;
    const commEdges = graphApplied.edges
      .filter((e) => nodeCommMap.get(e.source) === commId && nodeCommMap.get(e.target) === commId)
      .map((e) => ({ source: e.source, target: e.target, type: e.type }));

    const fileName = `community-${String(batchId).padStart(3, "0")}.json`;
    atomicWriteJson(join(inputDir, fileName), {
      communityId: commId,
      members,
      internalEdges: commEdges,
    });
  }

  return { step: "updated-profiles", batchCount: batchId, inputDir };
}
