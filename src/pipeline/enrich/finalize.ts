/**
 * Step 7: Finalize — assemble final output files from .enrich/ intermediates.
 *
 * Reads: .enrich/graph-applied.json, .enrich/descriptions.json, .enrich/profiles.json,
 *        .enrich/updated-profiles.json (optional)
 * Produces: graph-enriched.json, node_descriptions.json, community_summaries.json
 */
import { existsSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../../shared/atomic-write.js";
import type { CommunityProfile, DescriptionEntry } from "./types.js";

export function runFinalize(outputDir: string): void {
  const enrichDir = join(outputDir, ".enrich");
  const graphAppliedPath = join(enrichDir, "graph-applied.json");
  const descriptionsPath = join(enrichDir, "descriptions.json");
  const profilesPath = join(enrichDir, "profiles.json");
  const updatedProfilesPath = join(enrichDir, "updated-profiles.json");

  // Validate all required inputs exist
  for (const f of [graphAppliedPath, descriptionsPath, profilesPath]) {
    if (!existsSync(f)) {
      throw new Error(`Missing required input for finalize: ${f}`);
    }
  }

  // 1. graph-applied.json → graph-enriched.json
  copyFileSync(graphAppliedPath, join(outputDir, "graph-enriched.json"));

  // 2. descriptions.json → node_descriptions.json
  const descriptions: DescriptionEntry[] = JSON.parse(readFileSync(descriptionsPath, "utf-8"));
  atomicWriteJson(join(outputDir, "node_descriptions.json"), descriptions);

  // 3. Merge profiles + updated-profiles → community_summaries.json
  const profiles: CommunityProfile[] = JSON.parse(readFileSync(profilesPath, "utf-8"));
  const updatedProfiles: CommunityProfile[] = existsSync(updatedProfilesPath)
    ? JSON.parse(readFileSync(updatedProfilesPath, "utf-8"))
    : [];

  // Updated profiles override originals for modified communities
  const profileMap = new Map(profiles.map((p) => [p.communityId, p]));
  for (const up of updatedProfiles) {
    profileMap.set(up.communityId, up);
  }

  // Compute node counts from graph-applied.json
  const graphData = JSON.parse(readFileSync(graphAppliedPath, "utf-8"));
  const commCounts = new Map<string, number>();
  for (const node of graphData.nodes) {
    const c = node.community ?? "unclustered";
    commCounts.set(c, (commCounts.get(c) ?? 0) + 1);
  }

  const summaries = [...profileMap.values()].map((p) => ({
    id: p.communityId,
    label: p.label,
    nodeCount: commCounts.get(p.communityId) ?? 0,
    summary: p.profile,
    hub_nodes: [] as string[],
    primary_path: "",
    repos: [] as string[],
  }));

  atomicWriteJson(join(outputDir, "community_summaries.json"), summaries);
}
