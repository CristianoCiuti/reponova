import type { Database } from "../../core/db.js";
import { getNodeDetail, getNodeSuggestions, formatNodeDetailMarkdown } from "../../core/node-detail.js";
import { handleOutline } from "./outline.js";

export function handleExplain(db: Database, graphDir: string, args: Record<string, unknown>) {
  const symbol = args.symbol as string;
  if (!symbol) return { content: [{ type: "text" as const, text: "Error: 'symbol' is required" }], isError: true };

  const detail = getNodeDetail(db, symbol);
  if (!detail) {
    const suggestions = getNodeSuggestions(db, symbol);
    const sugList = suggestions.length > 0 ? `\n\nDid you mean:\n${suggestions.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}` : "";
    return { content: [{ type: "text" as const, text: `## Node not found: "${symbol}"${sugList}` }] };
  }

  let text = formatNodeDetailMarkdown(detail);
  if ((args.include_code as boolean) && detail.source_file) {
    const outlineResult = handleOutline(db, graphDir, { file_path: detail.source_file, format: "markdown" });
    if (outlineResult.content[0] && !outlineResult.isError) {
      text += "\n\n---\n\n### Source File Outline\n\n" + outlineResult.content[0].text;
    }
  }
  return { content: [{ type: "text" as const, text }] };
}
