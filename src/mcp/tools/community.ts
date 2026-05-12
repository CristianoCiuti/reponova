import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../../query/db.js";
import { queryAll } from "../../query/db.js";
import type { PathResolver } from "../../shared/path-resolver.js";

let cachedLabels: Map<string, string> | null = null;
let cachedGraphDir: string | null = null;

function getCommunityLabels(graphDir: string): Map<string, string> {
  if (cachedLabels && cachedGraphDir === graphDir) return cachedLabels;
  const map = new Map<string, string>();
  const p = join(graphDir, "community_summaries.json");
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as Array<{ id: string | number; label?: string }>;
      for (const s of raw) {
        if (s.label) map.set(String(s.id), s.label);
      }
    } catch { /* ignore parse errors */ }
  }
  cachedLabels = map;
  cachedGraphDir = graphDir;
  return map;
}

export function handleCommunity(
  db: Database,
  graphDir: string,
  args: Record<string, unknown>,
  resolvePaths?: PathResolver | null,
) {
  const communityId = args.community_id;
  if (communityId == null) {
    return { content: [{ type: "text" as const, text: "Error: 'community_id' is required" }], isError: true };
  }

  const communityStr = String(communityId);

  const rows = queryAll(
    db,
    "SELECT id, label, type, source_file, repo, in_degree, out_degree FROM nodes WHERE community = ? ORDER BY (in_degree + out_degree) DESC",
    [communityStr],
  );

  if (rows.length === 0) {
    // List available communities
    const communities = queryAll(
      db,
      "SELECT community, COUNT(*) as cnt FROM nodes WHERE community IS NOT NULL GROUP BY community ORDER BY cnt DESC LIMIT 20",
      [],
    );
    const labels = getCommunityLabels(graphDir);
    const available = communities.map((c) => {
      const label = labels.get(String(c.community));
      const labelStr = label && !label.startsWith("Community ") ? ` — ${label}` : "";
      return `  ${c.community}${labelStr} (${c.cnt} nodes)`;
    }).join("\n");
    return {
      content: [{
        type: "text" as const,
        text: `No nodes found in community "${communityStr}".\n\nAvailable communities:\n${available}`,
      }],
    };
  }

  const labels = getCommunityLabels(graphDir);
  const communityLabel = labels.get(communityStr);
  const header = communityLabel && !communityLabel.startsWith("Community ")
    ? `## ${communityLabel} (Community ${communityStr}, ${rows.length} nodes)`
    : `## Community ${communityStr} (${rows.length} nodes)`;

  const lines = [header, ""];
  for (const row of rows) {
    const degree = (row.in_degree as number) + (row.out_degree as number);
    lines.push(`- [${row.type}] ${row.label} (degree: ${degree})${row.source_file ? ` — ${row.source_file}` : ""}`);
    if (resolvePaths && row.source_file) {
      const paths = resolvePaths(row.source_file as string);
      if (paths.graph_rel_path) lines.push(`  Graph path: ${paths.graph_rel_path}`);
      if (paths.absolute_path) lines.push(`  Absolute path: ${paths.absolute_path}`);
    }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
