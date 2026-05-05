import type { Database } from "../../core/db.js";
import { getNodeDetail, getNodeSuggestions, formatNodeDetailMarkdown } from "../../core/node-detail.js";
import type { PathResolver } from "../../core/path-resolver.js";
import { handleOutline } from "./outline.js";

export async function handleExplain(
  db: Database,
  graphDir: string,
  args: Record<string, unknown>,
  resolvePaths?: PathResolver | null,
) {
  const symbol = args.symbol as string;
  if (!symbol) return { content: [{ type: "text" as const, text: "Error: 'symbol' is required" }], isError: true };

  const detail = getNodeDetail(db, symbol);
  if (!detail) {
    const suggestions = getNodeSuggestions(db, symbol);
    const sugList = suggestions.length > 0 ? `\n\nDid you mean:\n${suggestions.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}` : "";
    return { content: [{ type: "text" as const, text: `## Node not found: "${symbol}"${sugList}` }] };
  }

  let text = formatNodeDetailMarkdown(detail);
  if (detail.source_file && resolvePaths) {
    const paths = resolvePaths(detail.source_file);
    if (paths.graph_rel_path) text += `\nGraph path: ${paths.graph_rel_path}`;
    if (paths.absolute_path) text += `\nAbsolute path: ${paths.absolute_path}`;
  }
  if ((args.include_code as boolean) && detail.source_file) {
    const outlineResult = await handleOutline(db, graphDir, { file_path: detail.source_file, format: "markdown" }, resolvePaths);
    if (outlineResult.content[0] && !("isError" in outlineResult && outlineResult.isError)) {
      text += "\n\n---\n\n### Source File Outline\n\n" + outlineResult.content[0].text;
    }
  }
  return { content: [{ type: "text" as const, text }] };
}
