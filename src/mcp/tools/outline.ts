import type { Database } from "../../core/db.js";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OutlineCache } from "../../outline/cache.js";
import { formatOutlineMarkdown, formatOutlineJson } from "../../outline/formatter.js";
import type { FileOutline } from "../../shared/types.js";

const outlineCache = new OutlineCache();

export function handleOutline(_db: Database, graphDir: string, args: Record<string, unknown>) {
  const filePath = args.file_path as string;
  const format = (args.format as string) ?? "markdown";
  if (!filePath) return { content: [{ type: "text" as const, text: "Error: 'file_path' is required" }], isError: true };

  const cached = outlineCache.get(filePath);
  if (cached) {
    const text = format === "json" ? formatOutlineJson(cached) : formatOutlineMarkdown(cached);
    return { content: [{ type: "text" as const, text }] };
  }

  // Check pre-computed
  const preComputed = join(graphDir, "outlines", filePath + ".outline.json");
  if (existsSync(preComputed)) {
    try {
      const outline = JSON.parse(readFileSync(preComputed, "utf-8")) as FileOutline;
      outlineCache.set(filePath, outline);
      const text = format === "json" ? formatOutlineJson(outline) : formatOutlineMarkdown(outline);
      return { content: [{ type: "text" as const, text }] };
    } catch { /* fall through */ }
  }

  // Try source file
  const workspaceRoot = resolve(graphDir, "..");
  const absolutePath = resolve(workspaceRoot, filePath);
  if (!existsSync(absolutePath)) {
    return { content: [{ type: "text" as const, text: `File not found: ${filePath}` }] };
  }

  const source = readFileSync(absolutePath, "utf-8");
  const lineCount = source.split("\n").length;
  const outline = simpleOutline(filePath, source, lineCount);
  outlineCache.set(filePath, outline);
  const text = format === "json" ? formatOutlineJson(outline) : formatOutlineMarkdown(outline);
  return { content: [{ type: "text" as const, text }] };
}

function simpleOutline(filePath: string, source: string, lineCount: number): FileOutline {
  const lines = source.split("\n");
  const imports: FileOutline["imports"] = [];
  const functions: FileOutline["functions"] = [];
  const classes: FileOutline["classes"] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const impMatch = /^(?:from\s+(\S+)\s+)?import\s+(.+)/.exec(line);
    if (impMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      imports.push({ module: impMatch[1] ?? impMatch[2]!, names: impMatch[1] ? impMatch[2]!.split(",").map((n) => n.trim()) : undefined, line: i + 1 });
      continue;
    }
    const funcMatch = /^def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(.+))?\s*:/.exec(line);
    if (funcMatch) {
      functions.push({ name: funcMatch[1]!, signature: `${funcMatch[1]}(${funcMatch[2]})${funcMatch[3] ? ` -> ${funcMatch[3]}` : ""}`, decorators: [], start_line: i + 1, end_line: i + 1, calls: [] });
      continue;
    }
    const classMatch = /^class\s+(\w+)(?:\(([^)]*)\))?\s*:/.exec(line);
    if (classMatch) {
      classes.push({ name: classMatch[1]!, bases: classMatch[2] ? classMatch[2].split(",").map((b) => b.trim()) : [], start_line: i + 1, end_line: i + 1, methods: [] });
    }
  }
  return { file_path: filePath, line_count: lineCount, imports, functions, classes };
}
