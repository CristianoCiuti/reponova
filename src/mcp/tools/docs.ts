/**
 * graph_docs MCP tool — document-specific search with linked code references.
 *
 * Thin wrapper over text search + vector search filtered to document/section nodes.
 */
import type { Database } from "../../core/db.js";
import { queryAll } from "../../core/db.js";
import type { PathResolver } from "../../core/path-resolver.js";

/**
 * Handle the graph_docs tool call.
 */
export function handleDocs(
  db: Database,
  args: Record<string, unknown>,
  resolvePaths?: PathResolver | null,
) {
  const query = args.query as string;
  if (!query) {
    return { content: [{ type: "text" as const, text: "Error: 'query' parameter is required" }], isError: true };
  }

  const topK = (args.top_k as number) ?? 10;
  const repo = args.repo as string | undefined;

  // Search only document and section nodes
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return { content: [{ type: "text" as const, text: "Error: query must contain at least one term" }], isError: true };
  }

  const conditions: string[] = [];
  const params: unknown[] = [];

  for (const term of terms) {
    const likeTerm = `%${term}%`;
    conditions.push(`(label LIKE ? OR source_file LIKE ? OR properties LIKE ?)`);
    params.push(likeTerm, likeTerm, likeTerm);
  }

  let filterSql = " AND type IN ('document', 'section')";
  if (repo) {
    filterSql += " AND repo = ?";
    params.push(repo);
  }

  params.push(topK);

  const sql = `
    SELECT id, label, type, source_file, repo, community, properties
    FROM nodes
    WHERE ${conditions.join(" AND ")}${filterSql}
    ORDER BY label
    LIMIT ?
  `;

  const rows = queryAll(db, sql, params);

  if (rows.length === 0) {
    return { content: [{ type: "text" as const, text: `No documentation found matching "${query}"` }] };
  }

  // Format output with linked code references
  const lines: string[] = [`## Documentation Results for "${query}" (${rows.length})`, ""];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const props = row.properties ? JSON.parse(row.properties as string) as Record<string, unknown> : {};

    lines.push(`### ${i + 1}. ${row.label}`);
    lines.push(`- Type: ${row.type}`);
    if (row.source_file) {
      lines.push(`- File: ${row.source_file}`);
      if (resolvePaths) {
        const paths = resolvePaths(row.source_file as string);
        if (paths.graph_rel_path) lines.push(`  Graph path: ${paths.graph_rel_path}`);
        if (paths.absolute_path) lines.push(`  Absolute path: ${paths.absolute_path}`);
      }
    }
    if (row.repo) lines.push(`- Repo: ${row.repo}`);

    // Show code references from properties
    const codeRefs = props.code_references as string[] | undefined;
    if (codeRefs && codeRefs.length > 0) {
      lines.push(`- Code references: ${codeRefs.join(", ")}`);
    }

    // Show heading level for sections
    const level = props.heading_level as number | undefined;
    if (level) lines.push(`- Heading level: H${level}`);

    lines.push("");
  }

  // Also find linked code nodes (edges from doc nodes to code nodes)
  const docIds = rows.map(r => r.id as string);
  if (docIds.length > 0) {
    const placeholders = docIds.map(() => "?").join(",");
    const linkedEdges = queryAll(
      db,
      `SELECT DISTINCT e.target_id, n.label, n.type, n.source_file
       FROM edges e JOIN nodes n ON n.id = e.target_id
       WHERE e.source_id IN (${placeholders}) AND n.type NOT IN ('document', 'section')
       LIMIT 10`,
      docIds,
    );

    if (linkedEdges.length > 0) {
      lines.push("## Linked Code Symbols", "");
      for (const edge of linkedEdges) {
        lines.push(`- [${edge.type}] **${edge.label}**${edge.source_file ? ` (${edge.source_file})` : ""}`);
        if (resolvePaths && edge.source_file) {
          const paths = resolvePaths(edge.source_file as string);
          if (paths.graph_rel_path) lines.push(`  Graph path: ${paths.graph_rel_path}`);
          if (paths.absolute_path) lines.push(`  Absolute path: ${paths.absolute_path}`);
        }
      }
    }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
