import type { Database } from "../../core/db.js";
import { findShortestPath, formatPathMarkdown } from "../../core/shortest-path.js";

export function handlePath(db: Database, args: Record<string, unknown>) {
  const from = args.from as string;
  const to = args.to as string;
  if (!from || !to) return { content: [{ type: "text" as const, text: "Error: 'from' and 'to' are required" }], isError: true };

  const result = findShortestPath(db, from, to, { max_depth: (args.max_depth as number) ?? 10, edge_types: args.edge_types as string[] | undefined });
  return { content: [{ type: "text" as const, text: formatPathMarkdown(result) }] };
}
