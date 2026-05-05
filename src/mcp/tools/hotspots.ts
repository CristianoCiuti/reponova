import type { Database } from "../../core/db.js";
import { queryAll } from "../../core/db.js";
import type { PathResolver } from "../../core/path-resolver.js";

export function handleHotspots(
  db: Database,
  args: Record<string, unknown>,
  resolvePaths?: PathResolver | null,
) {
  const topN = (args.top_n as number) ?? 10;
  const metric = (args.metric as string) ?? "degree";

  let orderBy: string;
  switch (metric) {
    case "betweenness":
      orderBy = "betweenness DESC";
      break;
    case "in_degree":
      orderBy = "in_degree DESC";
      break;
    case "out_degree":
      orderBy = "out_degree DESC";
      break;
    case "degree":
    default:
      orderBy = "(in_degree + out_degree) DESC";
      break;
  }

  const rows = queryAll(
    db,
    `SELECT id, label, type, source_file, repo, community, in_degree, out_degree, betweenness
     FROM nodes
     ORDER BY ${orderBy}
     LIMIT ?`,
    [topN],
  );

  if (rows.length === 0) {
    return { content: [{ type: "text" as const, text: "No nodes in graph." }] };
  }

  const lines = [`## Top ${rows.length} hotspots (by ${metric})`, ""];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const inDeg = r.in_degree as number;
    const outDeg = r.out_degree as number;
    const btw = (r.betweenness as number).toFixed(3);
    lines.push(`${i + 1}. [${r.type}] ${r.label}`);
    lines.push(`   Degree: ${inDeg + outDeg} (in: ${inDeg}, out: ${outDeg}) | Betweenness: ${btw}`);
    if (r.source_file) {
      lines.push(`   File: ${r.source_file}`);
      if (resolvePaths) {
        const paths = resolvePaths(r.source_file as string);
        if (paths.graph_rel_path) lines.push(`   Graph path: ${paths.graph_rel_path}`);
        if (paths.absolute_path) lines.push(`   Absolute path: ${paths.absolute_path}`);
      }
    }
    if (r.community) lines.push(`   Community: ${r.community}`);
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
