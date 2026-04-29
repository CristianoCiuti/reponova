import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../shared/utils.js";

// web-tree-sitter types
interface TreeSitterParser {
  parse(input: string): Tree;
  setLanguage(lang: Language): void;
}

interface Language {}

interface Tree {
  rootNode: SyntaxNode;
  delete(): void;
}

export interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: SyntaxNode[];
  namedChildren: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
  childrenForFieldName?(name: string): SyntaxNode[];
}

let parserInstance: TreeSitterParser | null = null;
let languageLoaded = false;

/**
 * Initialize tree-sitter WASM parser with Python grammar.
 */
export async function initParser(grammarPath?: string): Promise<TreeSitterParser> {
  if (parserInstance && languageLoaded) return parserInstance;

  try {
    // Dynamic import for web-tree-sitter
    const TreeSitter = (await import("web-tree-sitter")).default;
    await TreeSitter.init();

    const parser = new TreeSitter();

    // Resolve grammar path
    const defaultGrammarPath = resolve(
      new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
      "../../grammars/tree-sitter-python.wasm",
    );
    const wasmPath = grammarPath ?? defaultGrammarPath;

    log.debug(`Loading grammar from: ${wasmPath}`);
    const language = await TreeSitter.Language.load(wasmPath);
    parser.setLanguage(language);

    parserInstance = parser as unknown as TreeSitterParser;
    languageLoaded = true;
    log.info("Tree-sitter parser initialized with Python grammar");
    return parserInstance;
  } catch (error) {
    log.error(`Failed to initialize tree-sitter: ${error}`);
    throw error;
  }
}

/**
 * Parse a Python source file and return its AST root node.
 */
export function parseFile(parser: TreeSitterParser, filePath: string): SyntaxNode {
  const source = readFileSync(filePath, "utf-8");
  return parseSource(parser, source);
}

/**
 * Parse Python source code and return its AST root node.
 */
export function parseSource(parser: TreeSitterParser, source: string): SyntaxNode {
  const tree = parser.parse(source);
  return tree.rootNode;
}

export { TreeSitterParser };
