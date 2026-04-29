import type { FileOutline } from "../shared/types.js";

/**
 * Format a file outline as markdown.
 */
export function formatOutlineMarkdown(outline: FileOutline): string {
  const lines: string[] = [];

  lines.push(`## ${outline.file_path} (${outline.line_count} lines)`);
  lines.push("");

  // Imports
  if (outline.imports.length > 0) {
    lines.push("### Imports");
    for (const imp of outline.imports) {
      if (imp.names && imp.names.length > 0) {
        lines.push(`- from ${imp.module} import ${imp.names.join(", ")}`);
      } else {
        lines.push(`- import ${imp.module}`);
      }
    }
    lines.push("");
  }

  // Functions
  if (outline.functions.length > 0) {
    lines.push("### Functions");
    lines.push("");
    for (const func of outline.functions) {
      lines.push(`#### \`${func.signature}\` [L${func.start_line}-L${func.end_line}]`);
      if (func.decorators.length > 0) {
        lines.push(func.decorators.map((d) => `@${d}`).join(" "));
      }
      if (func.docstring) {
        lines.push(func.docstring);
      }
      if (func.calls.length > 0) {
        lines.push(`Calls: ${func.calls.join(", ")}`);
      }
      lines.push("");
    }
  }

  // Classes
  if (outline.classes.length > 0) {
    lines.push("### Classes");
    lines.push("");
    for (const cls of outline.classes) {
      const bases = cls.bases.length > 0 ? `(${cls.bases.join(", ")})` : "";
      lines.push(`#### \`${cls.name}${bases}\` [L${cls.start_line}-L${cls.end_line}]`);
      if (cls.docstring) {
        lines.push(cls.docstring);
      }
      if (cls.methods.length > 0) {
        lines.push(`Methods: ${cls.methods.map((m) => m.name).join(", ")}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Format a file outline as JSON.
 */
export function formatOutlineJson(outline: FileOutline): string {
  return JSON.stringify(outline, null, 2);
}
