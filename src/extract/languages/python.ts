/**
 * Python language extractor — reference implementation for the extraction engine.
 *
 * Extracts functions, classes, methods, imports, and call references from Python
 * source code using tree-sitter AST parsing.
 *
 * Tree-sitter node types used:
 *   function_definition, class_definition, decorated_definition,
 *   import_statement, import_from_statement, call, attribute,
 *   expression_statement → string (docstrings)
 */
import type {
  LanguageExtractor,
  SyntaxTree,
  SyntaxNode,
  FileExtraction,
  SymbolNode,
  ImportDeclaration,
  SymbolReference,
  SymbolKind,
} from "../types.js";
import { dirname, join } from "node:path";

export class PythonExtractor implements LanguageExtractor {
  readonly languageId = "python";
  readonly extensions = [".py", ".pyw"];
  readonly wasmFile = "tree-sitter-python.wasm";

  extract(tree: SyntaxTree, _sourceCode: string, filePath: string): FileExtraction {
    const symbols: SymbolNode[] = [];
    const imports: ImportDeclaration[] = [];
    const references: SymbolReference[] = [];

    const moduleName = this.filePathToModuleName(filePath);

    // Walk top-level children
    for (const child of tree.rootNode.namedChildren) {
      switch (child.type) {
        case "import_statement":
          imports.push(this.extractImport(child));
          break;
        case "import_from_statement":
          imports.push(this.extractFromImport(child));
          break;
        case "function_definition":
          this.extractFunction(child, symbols, references, moduleName, filePath);
          break;
        case "class_definition":
          this.extractClass(child, symbols, references, moduleName, filePath);
          break;
        case "decorated_definition":
          this.extractDecorated(child, symbols, references, moduleName, filePath);
          break;
        case "expression_statement": {
          // Module-level assignments (constants/variables)
          const expr = child.namedChildren[0];
          if (expr && expr.type === "assignment") {
            this.extractAssignment(expr, symbols, moduleName, filePath);
          }
          break;
        }
      }
    }

    return { filePath, language: "python", symbols, imports, references };
  }

  resolveImportPath(importModule: string, currentFilePath: string): string[] {
    // Relative imports: ".utils" → resolve relative to current file
    if (importModule.startsWith(".")) {
      return this.resolveRelativeImport(importModule, currentFilePath);
    }

    // Absolute imports: check if it looks like a project-internal module
    // "config.loader" → ["config/loader.py", "config/loader/__init__.py"]
    const parts = importModule.split(".");
    const basePath = parts.join("/");
    return [
      `${basePath}.py`,
      `${basePath}/__init__.py`,
    ];
  }

  // ─── Import Extraction ───────────────────────────────────────────────────

  private extractImport(node: SyntaxNode): ImportDeclaration {
    // `import os` or `import os.path` or `import os as operating_system`
    const names: string[] = [];
    let module = "";

    for (const child of node.namedChildren) {
      if (child.type === "dotted_name") {
        if (!module) module = child.text;
        else names.push(child.text);
      } else if (child.type === "aliased_import") {
        const nameNode = child.namedChildren[0];
        if (nameNode) {
          if (!module) module = nameNode.text;
          else names.push(nameNode.text);
        }
      }
    }

    return {
      module,
      names,
      isWildcard: false,
      line: node.startPosition.row + 1,
    };
  }

  private extractFromImport(node: SyntaxNode): ImportDeclaration {
    // `from module import name1, name2` or `from module import *`
    let module = "";
    const names: string[] = [];
    let isWildcard = false;

    for (const child of node.namedChildren) {
      if (child.type === "dotted_name" || child.type === "relative_import") {
        if (!module) {
          module = child.text;
        } else {
          names.push(child.text);
        }
      } else if (child.type === "aliased_import") {
        const nameNode = child.namedChildren[0];
        if (nameNode) names.push(nameNode.text);
      } else if (child.type === "wildcard_import") {
        isWildcard = true;
      }
    }

    // Handle cases where the module was not the first named child
    if (!module) {
      // Try getting the module from the raw text
      const match = node.text.match(/from\s+(\S+)\s+import/);
      if (match) module = match[1]!;
    }

    return {
      module,
      names,
      isWildcard,
      line: node.startPosition.row + 1,
    };
  }

  // ─── Function Extraction ─────────────────────────────────────────────────

  private extractFunction(
    node: SyntaxNode,
    symbols: SymbolNode[],
    references: SymbolReference[],
    moduleName: string,
    _filePath: string,
    parentClass?: string,
    decorators: string[] = [],
  ): void {
    const nameNode = node.childForFieldName("name");
    const name = nameNode?.text ?? "<anonymous>";
    const kind: SymbolKind = parentClass ? "method" : "function";

    const paramsNode = node.childForFieldName("parameters");
    const returnType = node.childForFieldName("return_type");
    const params = paramsNode?.text ?? "()";
    const ret = returnType ? ` -> ${returnType.text}` : "";
    const signature = `${name}${params}${ret}`;

    const docstring = this.extractDocstring(node);
    const calls = this.extractCalls(node);

    const qualifiedName = parentClass
      ? `${moduleName}.${parentClass}.${name}`
      : `${moduleName}.${name}`;

    symbols.push({
      name,
      qualifiedName,
      kind,
      signature,
      decorators,
      docstring,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      parent: parentClass,
      calls,
    });

    // Create references for each call
    for (const call of calls) {
      references.push({
        name: call,
        fromSymbol: qualifiedName,
        kind: "call",
        line: node.startPosition.row + 1,
      });
    }
  }

  // ─── Class Extraction ────────────────────────────────────────────────────

  private extractClass(
    node: SyntaxNode,
    symbols: SymbolNode[],
    references: SymbolReference[],
    moduleName: string,
    filePath: string,
    decorators: string[] = [],
  ): void {
    const nameNode = node.childForFieldName("name");
    const name = nameNode?.text ?? "<anonymous>";
    const qualifiedName = `${moduleName}.${name}`;

    // Extract base classes
    const bases: string[] = [];
    const superclassNode = node.childForFieldName("superclasses")
      ?? node.namedChildren.find((c) => c.type === "argument_list");
    if (superclassNode) {
      for (const arg of superclassNode.namedChildren) {
        if (arg.type === "identifier" || arg.type === "dotted_name" || arg.type === "attribute") {
          bases.push(arg.text);
        }
      }
    }

    const docstring = this.extractDocstring(node);

    symbols.push({
      name,
      qualifiedName,
      kind: "class",
      decorators,
      docstring,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      bases,
      calls: [],
    });

    // Create inheritance references
    for (const base of bases) {
      references.push({
        name: base,
        fromSymbol: qualifiedName,
        kind: "inheritance",
        line: node.startPosition.row + 1,
      });
    }

    // Extract methods
    const body = node.childForFieldName("body");
    if (body) {
      for (const child of body.namedChildren) {
        if (child.type === "function_definition") {
          this.extractFunction(child, symbols, references, moduleName, filePath, name);
        } else if (child.type === "decorated_definition") {
          const decs = this.extractDecoratorList(child);
          const funcNode = child.namedChildren.find((c) => c.type === "function_definition");
          if (funcNode) {
            this.extractFunction(funcNode, symbols, references, moduleName, filePath, name, decs);
          }
          const classNode = child.namedChildren.find((c) => c.type === "class_definition");
          if (classNode) {
            // Nested decorated class — extract as separate class
            this.extractClass(classNode, symbols, references, moduleName, filePath, decs);
          }
        } else if (child.type === "class_definition") {
          // Nested class
          this.extractClass(child, symbols, references, moduleName, filePath);
        }
      }
    }
  }

  // ─── Decorated Definition ────────────────────────────────────────────────

  private extractDecorated(
    node: SyntaxNode,
    symbols: SymbolNode[],
    references: SymbolReference[],
    moduleName: string,
    filePath: string,
  ): void {
    const decorators = this.extractDecoratorList(node);
    const definition = node.namedChildren.find(
      (c) => c.type === "function_definition" || c.type === "class_definition",
    );
    if (!definition) return;

    if (definition.type === "function_definition") {
      this.extractFunction(definition, symbols, references, moduleName, filePath, undefined, decorators);
    } else {
      this.extractClass(definition, symbols, references, moduleName, filePath, decorators);
    }
  }

  // ─── Assignment Extraction (module-level constants) ──────────────────────

  private extractAssignment(
    node: SyntaxNode,
    symbols: SymbolNode[],
    moduleName: string,
    _filePath: string,
  ): void {
    const left = node.childForFieldName("left");
    if (!left || left.type !== "identifier") return;

    const name = left.text;
    // Only extract UPPER_CASE or Title_Case names as constants/variables
    const isConstant = /^[A-Z][A-Z0-9_]*$/.test(name);
    if (!isConstant) return;

    symbols.push({
      name,
      qualifiedName: `${moduleName}.${name}`,
      kind: "constant",
      decorators: [],
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      calls: [],
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private extractDecoratorList(node: SyntaxNode): string[] {
    return node.namedChildren
      .filter((c) => c.type === "decorator")
      .map((c) => {
        const text = c.text.trim();
        return text.startsWith("@") ? text.slice(1) : text;
      });
  }

  private extractDocstring(node: SyntaxNode): string | undefined {
    const body = node.childForFieldName("body");
    if (!body) return undefined;
    const firstChild = body.namedChildren[0];
    if (!firstChild || firstChild.type !== "expression_statement") return undefined;
    const expr = firstChild.namedChildren[0];
    if (!expr || (expr.type !== "string" && expr.type !== "concatenated_string")) return undefined;

    let text = expr.text;
    if (text.startsWith('"""') || text.startsWith("'''")) {
      text = text.slice(3, -3).trim();
    } else if (text.startsWith('"') || text.startsWith("'")) {
      text = text.slice(1, -1).trim();
    }

    // Return first line of docstring, truncated
    const firstLine = text.split("\n")[0]?.trim() ?? text;
    return firstLine.length > 300 ? firstLine.slice(0, 297) + "..." : firstLine;
  }

  private extractCalls(node: SyntaxNode): string[] {
    const calls: string[] = [];
    const visited = new Set<string>();

    const walk = (n: SyntaxNode): void => {
      if (n.type === "call") {
        const funcNode = n.childForFieldName("function");
        if (funcNode) {
          const callName = funcNode.text;
          if (!visited.has(callName)) {
            visited.add(callName);
            calls.push(callName);
          }
        }
      }
      for (const child of n.namedChildren) walk(child);
    };

    const body = node.childForFieldName("body");
    if (body) walk(body);
    return calls;
  }

  /**
   * Convert a file path to a Python module name.
   * "motore_common/src/config/loader.py" → "motore_common.src.config.loader"
   */
  private filePathToModuleName(filePath: string): string {
    const normalized = filePath.replace(/\\/g, "/");
    let modulePath = normalized;

    // Remove .py extension
    if (modulePath.endsWith(".py")) {
      modulePath = modulePath.slice(0, -3);
    }
    if (modulePath.endsWith(".pyw")) {
      modulePath = modulePath.slice(0, -4);
    }

    // Remove trailing /__init__
    if (modulePath.endsWith("/__init__")) {
      modulePath = modulePath.slice(0, -9);
    }

    return modulePath.replace(/\//g, ".");
  }

  /**
   * Resolve a relative Python import to candidate file paths.
   * ".utils" from "pkg/sub/module.py" → ["pkg/sub/utils.py", "pkg/sub/utils/__init__.py"]
   * "..config" from "pkg/sub/module.py" → ["pkg/config.py", "pkg/config/__init__.py"]
   */
  private resolveRelativeImport(importModule: string, currentFilePath: string): string[] {
    const normalized = currentFilePath.replace(/\\/g, "/");
    let currentDir = dirname(normalized);

    // Count leading dots
    let dots = 0;
    while (dots < importModule.length && importModule[dots] === ".") {
      dots++;
    }

    // Go up (dots - 1) directories (1 dot = current package)
    for (let i = 1; i < dots; i++) {
      currentDir = dirname(currentDir);
    }

    const remainder = importModule.slice(dots);
    if (!remainder) {
      return [
        join(currentDir, "__init__.py").replace(/\\/g, "/"),
      ];
    }

    const parts = remainder.split(".");
    const basePath = join(currentDir, ...parts).replace(/\\/g, "/");

    return [
      `${basePath}.py`,
      `${basePath}/__init__.py`,
    ];
  }
}
