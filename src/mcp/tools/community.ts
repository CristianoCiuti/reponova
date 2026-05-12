import type { Database } from "../../query/db.js";
import { queryAll } from "../../query/db.js";
import type { PathResolver } from "../../shared/path-resolver.js";
import { formatCommunityName, loadCommunityLabels } from "../../shared/community-labels.js";

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
  const labels = loadCommunityLabels(graphDir);

  const rows = queryAll(
    db,
    "SELECT id, label, type, source_file, repo, in_degree, out_degree FROM nodes WHERE community = ? ORDER BY (in_degree + out_degree) DESC",
    [communityStr],
  );

  if (rows.length === 0) {
    const communities = queryAll(
      db,
      "SELECT community, COUNT(*) as cnt FROM nodes WHERE community IS NOT NULL GROUP BY community ORDER BY cnt DESC LIMIT 20",
      [],
    );
    const available = communities.map((c) => {
      const id = String(c.community);
      const label = labels.get(id) ?? `Community ${id}`;
      return `  ${formatCommunityName(id, label)} (${c.cnt} nodes)`;
    }).join("\n");
    return {
      content: [{
        type: "text" as const,
        text: `No nodes found in community "${communityStr}".\n\nAvailable communities:\n${available}`,
      }],
    };
  }

  const label = labels.get(communityStr) ?? `Community ${communityStr}`;
  const lines = [`## ${formatCommunityName(communityStr, label)} (${rows.length} nodes)`, ""];
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
