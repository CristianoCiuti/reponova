import type { Database } from "./db.js";
import { queryAll } from "./db.js";
import type { SearchResult } from "../shared/types.js";

export interface SearchOptions {
  top_k?: number;
  repo?: string;
  type?: string;
}

/**
 * Perform text search on knowledge graph nodes using LIKE matching.
 * Scores results by number of matching terms (higher = better match).
 */
export function searchNodes(db: Database, query: string, options: SearchOptions = {}): SearchResult[] {
  const { top_k = 10, repo, type } = options;

  const terms = sanitizeQuery(query);
  if (terms.length === 0) return [];

  // Build WHERE clause with LIKE conditions for each term
  const conditions: string[] = [];
  const params: unknown[] = [];

  // Each term must match at least one of: label, type, source_file, community, properties
  for (const term of terms) {
    const likeTerm = `%${term}%`;
    conditions.push(
      `(label LIKE ? OR type LIKE ? OR source_file LIKE ? OR community LIKE ? OR properties LIKE ?)`,
    );
    params.push(likeTerm, likeTerm, likeTerm, likeTerm, likeTerm);
  }

  // Add repo/type filters
  let filterSql = "";
  if (repo) {
    filterSql += " AND repo = ?";
    params.push(repo);
  }
  if (type && type !== "all") {
    filterSql += " AND type = ?";
    params.push(type);
  }

  params.push(top_k);

  const sql = `
    SELECT id, label, type, source_file, repo, community, properties
    FROM nodes
    WHERE ${conditions.join(" AND ")}${filterSql}
    ORDER BY
      CASE WHEN label LIKE ? THEN 0 ELSE 1 END,
      in_degree DESC
    LIMIT ?
  `;

  // Add the first term as priority sort (exact label match first)
  const firstTermLike = `%${terms[0]}%`;
  // Insert the sort param before LIMIT
  params.splice(params.length - 1, 0, firstTermLike);

  const rows = queryAll(db, sql, params);

  return rows.map((row, i) => ({
    id: row.id as string,
    label: row.label as string,
    type: row.type as string,
    source_file: (row.source_file as string | null) ?? undefined,
    repo: (row.repo as string | null) ?? undefined,
    community: (row.community as string | null) ?? undefined,
    rank: -(rows.length - i), // synthetic rank (lower is better, like BM25)
    properties: row.properties ? JSON.parse(row.properties as string) : undefined,
  }));
}

/**
 * Fuzzy match a node by name. Uses OR logic (any term matches)
 * to handle partial/typo'd names like "get_usr" matching "get_user_by_id".
 */
export function fuzzyMatchNode(db: Database, name: string, top_k = 3): SearchResult[] {
  const terms = sanitizeQuery(name);
  if (terms.length === 0) return [];

  // Split on underscores too for snake_case identifiers
  const allTerms = terms.flatMap((t) => t.split("_")).filter((t) => t.length > 0);

  // AND logic: ALL terms must match somewhere in the label
  const conditions: string[] = [];
  const params: unknown[] = [];

  for (const term of allTerms) {
    conditions.push("label LIKE ?");
    params.push(`%${term}%`);
  }

  params.push(top_k);

  const sql = `
    SELECT id, label, type, source_file, repo, community, properties
    FROM nodes
    WHERE ${conditions.join(" AND ")}
    ORDER BY in_degree DESC
    LIMIT ?
  `;

  const rows = queryAll(db, sql, params);

  return rows.map((row, i) => ({
    id: row.id as string,
    label: row.label as string,
    type: row.type as string,
    source_file: (row.source_file as string | null) ?? undefined,
    repo: (row.repo as string | null) ?? undefined,
    community: (row.community as string | null) ?? undefined,
    rank: -(rows.length - i),
    properties: row.properties ? JSON.parse(row.properties as string) : undefined,
  }));
}

function sanitizeQuery(query: string): string[] {
  return query
    .replace(/[(){}[\]"^~*:]/g, "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}
