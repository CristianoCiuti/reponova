/**
 * Diagram/image metadata extractor.
 *
 * Extracts lightweight metadata from diagram and image files:
 * - .puml: Parse PlantUML to extract class/interface names and relationships
 * - .svg: Extract text elements from SVG XML
 * - .png/.jpg/.gif: Register as metadata node only (path, size)
 *
 * These produce "document"-type nodes in the graph with file_type "diagram".
 * They enable agents to discover visual documentation that's otherwise invisible.
 */
import type { LanguageExtractor, SyntaxTree, FileExtraction, SymbolNode, ImportDeclaration, SymbolReference } from "../types.js";

export class DiagramExtractor implements LanguageExtractor {
  readonly languageId = "diagram";
  readonly extensions = [".puml", ".plantuml", ".svg", ".png", ".jpg", ".jpeg", ".gif"];
  // No tree-sitter needed
  readonly wasmFile = undefined;

  extract(_tree: SyntaxTree | null, sourceCode: string, filePath: string): FileExtraction {
    const ext = ("." + (filePath.split(".").pop()?.toLowerCase() ?? "")) as string;

    if (ext === ".puml" || ext === ".plantuml") {
      return this.extractPlantUml(sourceCode, filePath);
    }
    if (ext === ".svg") {
      return this.extractSvg(sourceCode, filePath);
    }
    // Binary images: just register a metadata node
    return this.extractImageMetadata(filePath);
  }

  resolveImportPath(_importModule: string, _currentFilePath: string): string[] {
    return [];
  }

  // ─── PlantUML Extraction ─────────────────────────────────────────────────

  private extractPlantUml(source: string, filePath: string): FileExtraction {
    const symbols: SymbolNode[] = [];
    const references: SymbolReference[] = [];
    const lines = source.split("\n");

    const fileName = filePath.split("/").pop() ?? filePath;

    // Document node for the diagram file itself
    symbols.push({
      name: fileName,
      qualifiedName: `${filePath}/${fileName}`,
      kind: "document",
      decorators: ["plantuml"],
      docstring: this.extractPumlTitle(lines),
      startLine: 1,
      endLine: lines.length,
      calls: [],
    });

    // Extract class/interface/enum definitions
    const classRegex = /^\s*(class|interface|enum|abstract class|abstract)\s+["']?(\w+)["']?/;
    const relationRegex = /^\s*(\w+)\s*([<\-\.\|>*o]+)\s*(\w+)/;

    const definedNames = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const classMatch = line.match(classRegex);

      if (classMatch) {
        const kind = classMatch[1]!;
        const name = classMatch[2]!;
        definedNames.add(name);

        symbols.push({
          name,
          qualifiedName: `${filePath}/${name}`,
          kind: kind.includes("interface") ? "interface" : "class",
          decorators: [kind.replace("abstract ", "abstract_")],
          startLine: i + 1,
          endLine: i + 1,
          parent: fileName,
          calls: [],
        });
      }

      // Extract relationships: A --> B, A --|> B, etc.
      const relMatch = line.match(relationRegex);
      if (relMatch) {
        const from = relMatch[1]!;
        const to = relMatch[3]!;
        if (from !== to && /^\w+$/.test(from) && /^\w+$/.test(to)) {
          references.push({
            name: to,
            fromSymbol: from,
            kind: "inheritance",
            line: i + 1,
          });
        }
      }
    }

    return { filePath, language: "diagram", symbols, imports: [], references };
  }

  // ─── SVG Extraction ──────────────────────────────────────────────────────

  private extractSvg(source: string, filePath: string): FileExtraction {
    const symbols: SymbolNode[] = [];
    const fileName = filePath.split("/").pop() ?? filePath;

    // Document node
    symbols.push({
      name: fileName,
      qualifiedName: `${filePath}/${fileName}`,
      kind: "document",
      decorators: ["svg"],
      docstring: this.extractSvgTitle(source),
      startLine: 1,
      endLine: source.split("\n").length,
      calls: [],
    });

    // Extract meaningful text elements from SVG
    const textRegex = /<text[^>]*>([^<]+)<\/text>/g;
    const texts: string[] = [];
    let match;
    while ((match = textRegex.exec(source)) !== null) {
      const text = match[1]!.trim();
      if (text.length >= 3 && text.length <= 80 && !/^\d+$/.test(text)) {
        texts.push(text);
      }
    }

    // Create section nodes from unique meaningful text elements (top 20)
    const uniqueTexts = [...new Set(texts)].slice(0, 20);
    for (let i = 0; i < uniqueTexts.length; i++) {
      const text = uniqueTexts[i]!;
      const sectionName = text.replace(/[^a-zA-Z0-9_\s-]/g, "").replace(/\s+/g, "_").slice(0, 60);
      if (sectionName.length < 2) continue;

      symbols.push({
        name: sectionName,
        qualifiedName: `${filePath}/${sectionName}`,
        kind: "section",
        decorators: ["svg_text"],
        docstring: text,
        startLine: 1,
        endLine: 1,
        parent: fileName,
        calls: [],
      });
    }

    return { filePath, language: "diagram", symbols, imports: [], references: [] };
  }

  // ─── Binary Image Metadata ───────────────────────────────────────────────

  private extractImageMetadata(filePath: string): FileExtraction {
    const fileName = filePath.split("/").pop() ?? filePath;
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

    return {
      filePath,
      language: "diagram",
      symbols: [{
        name: fileName,
        qualifiedName: `${filePath}/${fileName}`,
        kind: "document",
        decorators: [ext],
        startLine: 1,
        endLine: 1,
        calls: [],
      }],
      imports: [],
      references: [],
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private extractPumlTitle(lines: string[]): string | undefined {
    for (const line of lines) {
      const titleMatch = line.match(/^\s*title\s+(.+)/i);
      if (titleMatch) return titleMatch[1]!.trim();
    }
    return undefined;
  }

  private extractSvgTitle(source: string): string | undefined {
    const titleMatch = source.match(/<title>([^<]+)<\/title>/);
    return titleMatch?.[1]?.trim();
  }
}
