/**
 * Prompt templates for each step of the intelligent enrichment pipeline.
 *
 * Each function returns { system, user } messages for the LLM provider.
 */
import type { NodeCodeBlock } from "./batcher.js";
import type { CommunityProfile } from "./types.js";

// --- Step 1: Node descriptions ---

export function buildDescriptionPrompt(batch: NodeCodeBlock[]): { system: string; user: string } {
  const system = `For each symbol below, write a 1-2 sentence description of what it does architecturally. Focus on role, responsibilities, and key behaviors. Output as JSON array: [{"id": "qualified_name", "description": "..."}]. No markdown fences.`;

  const userParts: string[] = [];
  for (const block of batch) {
    userParts.push(`=== ${block.filePath} (${block.qualifiedName}, lines ${block.startLine}-${block.endLine}) ===`);
    userParts.push(block.code);
    userParts.push("");
  }

  return { system, user: userParts.join("\n") };
}

// --- Step 2: Community profiling ---

export function buildProfilePrompt(
  communityId: string,
  memberDescriptions: Array<{ id: string; description: string }>,
  internalEdges: Array<{ source: string; target: string; type: string }>,
): { system: string; user: string } {
  const system = `You are profiling a code community (cluster of related symbols). Provide:
1. label: 3-5 words naming the community's purpose
2. profile: 30-50 words describing architectural role
3. misfits: nodes that don't belong (with reason)
Output as JSON: {"communityId": "${communityId}", "label": "...", "profile": "...", "misfits": [{"nodeId": "...", "reason": "..."}]}. No markdown fences.`;

  const userParts: string[] = [`This community (${communityId}) contains ${memberDescriptions.length} nodes:\n`];
  userParts.push("Nodes:");
  for (const m of memberDescriptions.slice(0, 80)) {
    userParts.push(`- ${m.id}: "${m.description}"`);
  }
  if (memberDescriptions.length > 80) {
    userParts.push(`... and ${memberDescriptions.length - 80} more nodes`);
  }
  userParts.push("\nInternal edges:");
  for (const e of internalEdges.slice(0, 50)) {
    userParts.push(`- ${e.source} \u2192 ${e.target} (${e.type})`);
  }
  if (internalEdges.length > 50) {
    userParts.push(`... and ${internalEdges.length - 50} more edges`);
  }
  userParts.push("\nProvide: label, profile, misfits.");

  return { system, user: userParts.join("\n") };
}

// --- Step 3: Candidate routing ---

export function buildRoutingPrompt(
  candidates: Array<{
    nodeId: string;
    description: string;
    currentCommunity: string;
    adjacentCommunities: Array<{ id: string; edgeCount: number }>;
  }>,
  profiles: Map<string, CommunityProfile>,
): { system: string; user: string } {
  const system = `For each node below, decide: STAY in current community or MOVE to a better fit.
Output JSON array: [{"node": "...", "action": "stay"|"move", "to": "community_id_or_omit", "reason": "..."}]. No markdown fences.`;

  const userParts: string[] = ["Community profiles (reference):"];
  const relevantComms = new Set<string>();
  for (const c of candidates) {
    relevantComms.add(c.currentCommunity);
    for (const adj of c.adjacentCommunities) relevantComms.add(adj.id);
  }
  for (const commId of relevantComms) {
    const p = profiles.get(commId);
    if (p) userParts.push(`- Community ${commId} "${p.label}": "${p.profile}"`);
  }

  userParts.push("\nFor each node below, decide STAY or MOVE:\n");
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const adj = c.adjacentCommunities.map((a) => `${a.id} (${a.edgeCount} edges)`).join(", ");
    userParts.push(`${i + 1}. ${c.nodeId} (current: ${c.currentCommunity})`);
    userParts.push(`   Description: "${c.description}"`);
    userParts.push(`   Adjacent: ${adj || "none"}`);
    userParts.push("");
  }

  return { system, user: userParts.join("\n") };
}

// --- Step 4: Merge/Split detection ---

export function buildRestructurePrompt(
  profiles: CommunityProfile[],
  highDensityPairs: Array<{ communityA: string; communityB: string; edgeCount: number }>,
  gainedNodes: Map<string, number>,
  sizeOutliers: Array<{ communityId: string; nodeCount: number }>,
): { system: string; user: string } {
  const system = `Analyze communities for merges (should be combined) and splits (too large/incoherent).
Output JSON: {"merges": [{"communities": ["id1", "id2"], "newLabel": "...", "reason": "..."}], "splits": [{"community": "id", "reason": "...", "into": [{"label": "...", "nodes": ["..."]}]}]}. No markdown fences. Empty arrays if no changes needed.`;

  const userParts: string[] = [`Communities (${profiles.length} total):`];
  for (const p of profiles) {
    userParts.push(`  ${p.communityId}: "${p.label}" \u2014 "${p.profile}"`);
  }

  if (highDensityPairs.length > 0) {
    userParts.push("\nHigh cross-edge density pairs:");
    for (const pair of highDensityPairs.slice(0, 20)) {
      userParts.push(`  ${pair.communityA} \u2194 ${pair.communityB}: ${pair.edgeCount} edges`);
    }
  }

  if (gainedNodes.size > 0) {
    userParts.push("\nCommunities that gained >5 nodes from routing:");
    for (const [commId, count] of gainedNodes) {
      if (count > 5) userParts.push(`  ${commId}: gained ${count} nodes`);
    }
  }

  if (sizeOutliers.length > 0) {
    userParts.push("\nSize outliers (abnormally large):");
    for (const o of sizeOutliers) {
      userParts.push(`  ${o.communityId}: ${o.nodeCount} nodes`);
    }
  }

  userParts.push("\nPropose merges and splits (or empty arrays if none needed).");

  return { system, user: userParts.join("\n") };
}
