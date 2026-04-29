import type { Database } from "../../core/db.js";
import { searchNodes } from "../../core/search.js";

export function handleSearch(db: Database, args: Record<string, unknown>) {
  const query = args.query as string;
  if (!query) return { content: [{ type: "text" as const, text: "Error: 'query' is required" }], isError: true };

  const results = searchNodes(db, query, { top_k: (args.top_k as number) ?? 10, repo: args.repo as string | undefined, type: args.type as string | undefined });

  if (results.length === 0) return { content: [{ type: "text" as const, text: `No results for "${query}"` }] };

  const lines = [`## Results for "${query}" (${results.length} matches)`, ""];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    lines.push(`${i + 1}. [${r.type}] ${r.label}${r.source_file ? ` \u2014 ${r.source_file}` : ""}`);
    if (r.community) lines.push(`   Community: "${r.community}"`);
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
