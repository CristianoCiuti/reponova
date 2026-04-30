/**
 * Markdown/documentation file extractor.
 *
 * Extracts document structure and cross-references to code from .md, .txt, .rst files.
 * Does NOT use tree-sitter — parses markdown directly via regex (heading extraction).
 *
 * Node types produced:
 *   - "document" — one per file (top-level)
 *   - "section" — one per heading (## Heading)
 *
 * Reference detection:
 *   - Backtick spans: `function_name` → references to code symbols
 *   - File paths: src/config/loader.py → references to files
 *   - Code blocks with imports → parsed for import references
 */
import type { LanguageExtractor, SyntaxTree, FileExtraction, SymbolNode, ImportDeclaration, SymbolReference } from "../types.js";

export class MarkdownExtractor implements LanguageExtractor {
  readonly languageId = "markdown";
  readonly extensions = [".md", ".txt", ".rst"];
  // No tree-sitter — uses regex-based parsing
  readonly wasmFile = undefined;

  extract(_tree: SyntaxTree | null, sourceCode: string, filePath: string): FileExtraction {
    const lines = sourceCode.split("\n");
    const symbols: SymbolNode[] = [];
    const imports: ImportDeclaration[] = [];
    const references: SymbolReference[] = [];

    // Create document-level node
    const docName = filePath.split("/").pop() ?? filePath;
    const docQualified = `${filePath}/${docName}`;
    symbols.push({
      name: docName,
      qualifiedName: docQualified,
      kind: "document",
      decorators: [],
      docstring: this.extractFirstParagraph(lines),
      startLine: 1,
      endLine: lines.length,
      calls: [],
    });

    // Extract sections from headings
    const sections = this.extractSections(lines, filePath, docName);
    symbols.push(...sections);

    // Extract code references (backtick spans, file paths)
    const refs = this.extractCodeReferences(lines, filePath, docName, sections);
    references.push(...refs);

    return { filePath, language: "markdown", symbols, imports, references };
  }

  resolveImportPath(_importModule: string, _currentFilePath: string): string[] {
    // Docs don't have imports in the traditional sense
    return [];
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  private extractFirstParagraph(lines: string[]): string | undefined {
    const nonEmpty: string[] = [];
    let started = false;

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip YAML frontmatter
      if (!started && trimmed === "---") {
        started = false;
        continue;
      }
      // Skip headings at the top
      if (!started && trimmed.startsWith("#")) {
        started = true;
        continue;
      }
      if (!started && trimmed === "") continue;
      started = true;

      if (trimmed === "") {
        if (nonEmpty.length > 0) break;
        continue;
      }
      if (trimmed.startsWith("#")) break;
      nonEmpty.push(trimmed);
    }

    if (nonEmpty.length === 0) return undefined;
    const paragraph = nonEmpty.join(" ");
    return paragraph.length > 200 ? paragraph.slice(0, 200) + "..." : paragraph;
  }

  private extractSections(lines: string[], filePath: string, docName: string): SymbolNode[] {
    const sections: SymbolNode[] = [];
    let currentStart = -1;
    let currentName = "";
    let currentLevel = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      // Also handle RST-style underline headings
      const rstMatch = i > 0 && /^[=\-~^]+$/.test(line.trim()) && line.trim().length >= 3
        ? lines[i - 1]?.trim()
        : null;

      const heading = headingMatch?.[2]?.trim() ?? rstMatch ?? null;
      const level = headingMatch ? headingMatch[1]!.length : (rstMatch ? 2 : 0);

      if (heading && level > 0) {
        // Close previous section
        if (currentStart > 0 && currentName) {
          sections[sections.length - 1]!.endLine = i;
        }

        const sectionName = this.sanitizeSectionName(heading);
        const qualified = `${filePath}/${sectionName}`;

        sections.push({
          name: sectionName,
          qualifiedName: qualified,
          kind: "section",
          decorators: [`h${level}`],
          docstring: heading,
          startLine: i + 1,
          endLine: lines.length, // Will be updated when next section found
          parent: docName,
          calls: [],
        });

        currentStart = i + 1;
        currentName = sectionName;
        currentLevel = level;
      }
    }

    return sections;
  }

  private extractCodeReferences(
    lines: string[],
    filePath: string,
    docName: string,
    sections: SymbolNode[],
  ): SymbolReference[] {
    const references: SymbolReference[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNum = i + 1;

      // Find the current section for context
      const currentSection = this.findSectionAtLine(lineNum, sections, docName);

      // Extract backtick code spans: `symbol_name`
      const backtickRegex = /`([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)`/g;
      let match;
      while ((match = backtickRegex.exec(line)) !== null) {
        const name = match[1]!;
        // Skip very short names and common markdown artifacts
        if (name.length < 2 || /^(true|false|null|none|if|else|for|while|return|import|from|class|def)$/i.test(name)) continue;
        const key = `${currentSection}:${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          references.push({
            name,
            fromSymbol: currentSection,
            kind: "call", // Reuse "call" for code reference
            line: lineNum,
          });
        }
      }

      // Extract file path references: src/path/file.py or ./relative/file.ts
      const pathRegex = /(?:^|[\s("`'])([a-zA-Z0-9_./-]+\.[a-z]{1,4})(?:[\s)"`']|$)/g;
      while ((match = pathRegex.exec(line)) !== null) {
        const path = match[1]!;
        // Must look like a source file path (has directory separator and code extension)
        if (!path.includes("/")) continue;
        if (!/\.(py|ts|tsx|js|jsx|java|go|rs|rb|c|cpp|h|hpp)$/.test(path)) continue;
        const key = `${currentSection}:file:${path}`;
        if (!seen.has(key)) {
          seen.add(key);
          references.push({
            name: path,
            fromSymbol: currentSection,
            kind: "attribute_access", // Reuse for file references
            line: lineNum,
          });
        }
      }
    }

    return references;
  }

  private findSectionAtLine(lineNum: number, sections: SymbolNode[], docName: string): string {
    for (let i = sections.length - 1; i >= 0; i--) {
      if (lineNum >= sections[i]!.startLine) {
        return sections[i]!.name;
      }
    }
    return docName;
  }

  private sanitizeSectionName(heading: string): string {
    // Remove markdown formatting, keep meaningful text
    return heading
      .replace(/[*_~`\[\]()]/g, "")
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 80);
  }
}
