import type { Database } from "../../core/db.js";
import { queryOne } from "../../core/db.js";
import { analyzeImpact, formatImpactMarkdown } from "../../core/impact.js";
import type { PathResolver } from "../../core/path-resolver.js";
import { fuzzyMatchNode } from "../../core/search.js";

export function handleImpact(
  db: Database,
  args: Record<string, unknown>,
  resolvePaths?: PathResolver | null,
) {
  const symbol = args.symbol as string;
  if (!symbol) return { content: [{ type: "text" as const, text: "Error: 'symbol' is required" }], isError: true };

  const symbolId = resolveSymbolId(db, symbol);
  if (!symbolId) {
    const suggestions = fuzzyMatchNode(db, symbol, 3);
    const sugText = suggestions.length > 0 ? `\n\nDid you mean:\n${suggestions.map((s) => `  - ${s.label} (${s.type})`).join("\n")}` : "";
    return { content: [{ type: "text" as const, text: `Symbol not found: "${symbol}"${sugText}` }] };
  }

  const result = analyzeImpact(db, symbolId, {
    direction: (args.direction as "upstream" | "downstream" | "both") ?? "both",
    max_depth: (args.max_depth as number) ?? 3,
    include_tests: (args.include_tests as boolean) ?? false,
  });

  if (!result) return { content: [{ type: "text" as const, text: `Could not analyze: "${symbol}"` }] };
  return { content: [{ type: "text" as const, text: formatImpactMarkdown(result, resolvePaths ?? undefined) }] };
}

function resolveSymbolId(db: Database, symbol: string): string | null {
  const byId = queryOne(db, "SELECT id FROM nodes WHERE id = ?", [symbol]);
  if (byId) return byId.id as string;
  const byLabel = queryOne(db, "SELECT id FROM nodes WHERE label = ?", [symbol]);
  if (byLabel) return byLabel.id as string;
  const fuzzy = fuzzyMatchNode(db, symbol, 1);
  return fuzzy.length > 0 ? fuzzy[0]!.id : null;
}
