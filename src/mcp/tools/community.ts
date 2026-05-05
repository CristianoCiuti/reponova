import type { Database } from "../../core/db.js";
import { queryAll } from "../../core/db.js";
import type { PathResolver } from "../../core/path-resolver.js";

export function handleCommunity(
  db: Database,
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
    const available = communities.map((c) => `  ${c.community} (${c.cnt} nodes)`).join("\n");
    return {
      content: [{
        type: "text" as const,
        text: `No nodes found in community "${communityStr}".\n\nAvailable communities:\n${available}`,
      }],
    };
  }

  const lines = [`## Community: ${communityStr} (${rows.length} nodes)`, ""];
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
