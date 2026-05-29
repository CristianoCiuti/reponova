/**
 * Step 5: Apply routing and restructure decisions to the graph.
 *
 * Reads: .enrich/routing.json, .enrich/restructure.json, graph.json
 * Produces: .enrich/graph-applied.json, .enrich/modified-communities.json
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphData } from "../../shared/types.js";
import { atomicWriteJson } from "../../shared/atomic-write.js";
import type { RoutingDecision, RestructureFile, ModifiedCommunitiesFile } from "./types.js";

export function runApply(outputDir: string): { moved: number; merged: number; split: number } {
  const enrichDir = join(outputDir, ".enrich");
  const graphJsonPath = join(outputDir, "graph.json");

  const graphData = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as GraphData;
  const routing: RoutingDecision[] = JSON.parse(readFileSync(join(enrichDir, "routing.json"), "utf-8"));
  const restructure: RestructureFile = JSON.parse(readFileSync(join(enrichDir, "restructure.json"), "utf-8"));

  // Build node → community map
  const nodeMap = new Map(graphData.nodes.map((n) => [n.id, n]));

  const modifiedCommunities = new Set<string>();
  const createdCommunities = new Set<string>();
  const removedCommunities = new Set<string>();

  // Apply routing decisions
  let moved = 0;
  for (const decision of routing) {
    if (decision.action === "move" && decision.to) {
      const node = nodeMap.get(decision.node);
      if (node && node.community !== decision.to) {
        modifiedCommunities.add(node.community ?? "unclustered");
        modifiedCommunities.add(decision.to);
        node.community = decision.to;
        moved++;
      }
    }
  }

  // Apply merges
  let mergedCount = 0;
  for (const merge of restructure.merges) {
    // Normalize: accept both {communities: [...]} and {communityA, communityB} shapes
    const communities: string[] = merge.communities
      ?? [(merge as any).communityA, (merge as any).communityB].filter(Boolean);
    const targetId = communities[0]; // first community becomes the merge target
    if (!targetId) continue;
    for (const commId of communities.slice(1)) {
      for (const node of graphData.nodes) {
        if (node.community === commId) {
          node.community = targetId;
        }
      }
      removedCommunities.add(commId);
    }
    modifiedCommunities.add(targetId);
    mergedCount++;
  }

  // Apply splits
  let splitCount = 0;
  for (const split of restructure.splits) {
    modifiedCommunities.add(split.community);
    for (const group of split.into) {
      const newId = `split_${split.community}_${splitCount}_${group.label.replace(/\s+/g, "_").toLowerCase()}`;
      createdCommunities.add(newId);
      for (const nodeId of group.nodes) {
        const node = nodeMap.get(nodeId);
        if (node) node.community = newId;
      }
    }
    splitCount++;
  }

  // Write outputs
  atomicWriteJson(join(enrichDir, "graph-applied.json"), graphData);

  const modifiedFile: ModifiedCommunitiesFile = {
    created: [...createdCommunities],
    modified: [...modifiedCommunities],
    removed: [...removedCommunities],
  };
  atomicWriteJson(join(enrichDir, "modified-communities.json"), modifiedFile);

  return { moved, merged: mergedCount, split: splitCount };
}
