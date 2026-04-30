/**
 * Python language support for outline generation.
 *
 * Two extraction strategies:
 * 1. tree-sitter (primary): full AST parsing via WASM grammar — accurate end_line, call graph, nested classes
 * 2. regex (fallback): pattern matching on source — no deps, handles common patterns
 */
import type { LanguageSupport, SyntaxNode } from "./types.js";
import type { FileOutline, ImportEntry, FunctionEntry, ClassEntry } from "../../shared/types.js";

export const python: LanguageSupport = {
  wasmFile: "tree-sitter-python.wasm",
  treeSitterExtract,
  regexExtract,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TREE-SITTER EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

function treeSitterExtract(rootNode: SyntaxNode, filePath: string, lineCount: number): FileOutline {
  const imports: ImportEntry[] = [];
  const functions: FunctionEntry[] = [];
  const classes: ClassEntry[] = [];

  for (const child of rootNode.namedChildren) {
    switch (child.type) {
      case "import_statement":
        imports.push(tsExtractImport(child));
        break;
      case "import_from_statement":
        imports.push(tsExtractFromImport(child));
        break;
      case "function_definition":
        functions.push(tsExtractFunction(child));
        break;
      case "decorated_definition":
        tsExtractDecorated(child, functions, classes);
        break;
      case "class_definition":
        classes.push(tsExtractClass(child));
        break;
    }
  }

  return { file_path: filePath, line_count: lineCount, imports, functions, classes };
}

function tsExtractImport(node: SyntaxNode): ImportEntry {
  const names = node.namedChildren
    .filter((c) => c.type === "dotted_name" || c.type === "aliased_import")
    .map((c) => c.text);
  return { module: names.join(", "), line: node.startPosition.row + 1 };
}

function tsExtractFromImport(node: SyntaxNode): ImportEntry {
  const moduleNode = node.namedChildren.find((c) => c.type === "dotted_name" || c.type === "relative_import");
  const module = moduleNode?.text ?? "";

  const importList = node.namedChildren.filter(
    (c) => c.type === "dotted_name" || c.type === "aliased_import",
  );
  const names = importList.slice(moduleNode?.type === "dotted_name" ? 1 : 0).map((c) => c.text);

  const importNames = node.namedChildren.find((c) => c.type === "import_prefix" || c.type === "import_from_names");
  if (importNames) {
    names.push(...importNames.namedChildren.map((c) => c.text));
  }

  return { module, names: names.length > 0 ? names : undefined, line: node.startPosition.row + 1 };
}

function tsExtractFunction(node: SyntaxNode, decorators: string[] = []): FunctionEntry {
  const nameNode = node.childForFieldName("name");
  const name = nameNode?.text ?? "<anonymous>";
  const paramsNode = node.childForFieldName("parameters");
  const returnType = node.childForFieldName("return_type");
  const params = paramsNode?.text ?? "()";
  const ret = returnType ? ` -> ${returnType.text}` : "";
  const signature = `${name}${params}${ret}`;
  const docstring = tsExtractDocstring(node);
  const calls = tsExtractCalls(node);

  return {
    name, signature, decorators, docstring,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    calls,
  };
}

function tsExtractClass(node: SyntaxNode, decorators: string[] = []): ClassEntry {
  const nameNode = node.childForFieldName("name");
  const name = nameNode?.text ?? "<anonymous>";

  const superclassNode = node.childForFieldName("superclasses") ?? node.namedChildren.find((c) => c.type === "argument_list");
  const bases: string[] = [];
  if (superclassNode) {
    for (const arg of superclassNode.namedChildren) {
      if (arg.type === "identifier" || arg.type === "dotted_name" || arg.type === "attribute") {
        bases.push(arg.text);
      }
    }
  }

  const docstring = tsExtractDocstring(node);
  const methods: FunctionEntry[] = [];
  const body = node.childForFieldName("body");
  if (body) {
    for (const child of body.namedChildren) {
      if (child.type === "function_definition") {
        methods.push(tsExtractFunction(child));
      } else if (child.type === "decorated_definition") {
        const decs = tsExtractDecoratorList(child);
        const funcNode = child.namedChildren.find((c) => c.type === "function_definition");
        if (funcNode) methods.push(tsExtractFunction(funcNode, decs));
      }
    }
  }

  return {
    name, bases, docstring,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    methods,
  };
}

function tsExtractDecorated(node: SyntaxNode, functions: FunctionEntry[], classes: ClassEntry[]): void {
  const decorators = tsExtractDecoratorList(node);
  const definition = node.namedChildren.find(
    (c) => c.type === "function_definition" || c.type === "class_definition",
  );
  if (!definition) return;
  if (definition.type === "function_definition") {
    functions.push(tsExtractFunction(definition, decorators));
  } else {
    classes.push(tsExtractClass(definition, decorators));
  }
}

function tsExtractDecoratorList(node: SyntaxNode): string[] {
  return node.namedChildren
    .filter((c) => c.type === "decorator")
    .map((c) => {
      const text = c.text.trim();
      return text.startsWith("@") ? text.slice(1) : text;
    });
}

function tsExtractDocstring(node: SyntaxNode): string | undefined {
  const body = node.childForFieldName("body");
  if (!body) return undefined;
  const firstChild = body.namedChildren[0];
  if (!firstChild || firstChild.type !== "expression_statement") return undefined;
  const expr = firstChild.namedChildren[0];
  if (!expr || (expr.type !== "string" && expr.type !== "concatenated_string")) return undefined;
  let text = expr.text;
  if (text.startsWith('"""') || text.startsWith("'''")) text = text.slice(3, -3).trim();
  else if (text.startsWith('"') || text.startsWith("'")) text = text.slice(1, -1).trim();
  return text.length > 300 ? text.slice(0, 297) + "..." : text;
}

function tsExtractCalls(node: SyntaxNode): string[] {
  const calls: string[] = [];
  const visited = new Set<string>();

  function walk(n: SyntaxNode): void {
    if (n.type === "call") {
      const funcNode = n.childForFieldName("function");
      if (funcNode && !visited.has(funcNode.text)) {
        visited.add(funcNode.text);
        calls.push(funcNode.text);
      }
    }
    for (const child of n.namedChildren) walk(child);
  }

  const body = node.childForFieldName("body");
  if (body) walk(body);
  return calls;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGEX EXTRACTION (FALLBACK)
// ═══════════════════════════════════════════════════════════════════════════════

function regexExtract(filePath: string, source: string, lineCount: number): FileOutline {
  const lines = source.split("\n");
  const imports: ImportEntry[] = [];
  const functions: FunctionEntry[] = [];
  const classes: ClassEntry[] = [];
  let currentClass: ClassEntry | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();

    // End class on non-indented non-empty line (not decorator/comment)
    if (currentClass && line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
      if (!trimmed.startsWith("@") && !trimmed.startsWith("#")) {
        currentClass.end_line = i;
        classes.push(currentClass);
        currentClass = null;
      }
    }

    // Imports (module level only)
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      const fromImport = /^from\s+(\S+)\s+import\s+(.+)/.exec(line);
      if (fromImport) {
        imports.push({
          module: fromImport[1]!,
          names: fromImport[2]!.split(",").map((n) => n.trim().split(" as ")[0]!.trim()),
          line: i + 1,
        });
        continue;
      }
      const plainImport = /^import\s+(.+)/.exec(line);
      if (plainImport) {
        imports.push({
          module: plainImport[1]!.split(",")[0]!.trim().split(" as ")[0]!.trim(),
          line: i + 1,
        });
        continue;
      }
    }

    // Top-level function
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      const funcMatch = /^def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(.+?))?\s*:/.exec(line);
      if (funcMatch) {
        const endLine = rxFindBlockEnd(lines, i, 0);
        functions.push({
          name: funcMatch[1]!,
          signature: `${funcMatch[1]}(${funcMatch[2]})${funcMatch[3] ? ` -> ${funcMatch[3]}` : ""}`,
          decorators: rxCollectDecorators(lines, i),
          docstring: rxExtractDocstring(lines, i + 1, "    "),
          start_line: i + 1,
          end_line: endLine,
          calls: [],
        });
        continue;
      }
    }

    // Class definition
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      const classMatch = /^class\s+(\w+)(?:\(([^)]*)\))?\s*:/.exec(line);
      if (classMatch) {
        if (currentClass) {
          currentClass.end_line = i;
          classes.push(currentClass);
        }
        currentClass = {
          name: classMatch[1]!,
          bases: classMatch[2] ? classMatch[2].split(",").map((b) => b.trim()) : [],
          docstring: rxExtractDocstring(lines, i + 1, "    "),
          start_line: i + 1,
          end_line: lineCount,
          methods: [],
        };
        continue;
      }
    }

    // Method inside class
    if (currentClass) {
      const methodMatch = /^(\s{4}|\t)def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(.+?))?\s*:/.exec(line);
      if (methodMatch) {
        const indent = methodMatch[1]!.length;
        const endLine = rxFindBlockEnd(lines, i, indent);
        currentClass.methods.push({
          name: methodMatch[2]!,
          signature: `${methodMatch[2]}(${methodMatch[3]})${methodMatch[4] ? ` -> ${methodMatch[4]}` : ""}`,
          decorators: rxCollectDecorators(lines, i),
          docstring: rxExtractDocstring(lines, i + 1, " ".repeat(indent + 4)),
          start_line: i + 1,
          end_line: endLine,
          calls: [],
        });
      }
    }
  }

  if (currentClass) {
    currentClass.end_line = lineCount;
    classes.push(currentClass);
  }

  return { file_path: filePath, line_count: lineCount, imports, functions, classes };
}

function rxCollectDecorators(lines: string[], defLineIdx: number): string[] {
  const decs: string[] = [];
  for (let j = defLineIdx - 1; j >= 0; j--) {
    const trimmed = lines[j]!.trimStart();
    if (trimmed.startsWith("@")) decs.unshift(trimmed.slice(1));
    else if (trimmed === "" || trimmed.startsWith("#")) continue;
    else break;
  }
  return decs;
}

function rxExtractDocstring(lines: string[], bodyStartIdx: number, expectedIndent: string): string | undefined {
  if (bodyStartIdx >= lines.length) return undefined;
  const trimmed = lines[bodyStartIdx]!.trimStart();
  if (!trimmed.startsWith('"""') && !trimmed.startsWith("'''")) return undefined;
  const quote = trimmed.slice(0, 3);

  // Single-line
  if (trimmed.length > 6 && trimmed.endsWith(quote)) return trimmed.slice(3, -3).trim();

  // Multi-line
  const docLines: string[] = [trimmed.slice(3)];
  for (let k = bodyStartIdx + 1; k < lines.length; k++) {
    const lt = lines[k]!.trimStart();
    if (lt.includes(quote)) {
      docLines.push(lt.slice(0, lt.indexOf(quote)));
      break;
    }
    const raw = lines[k]!;
    docLines.push(raw.startsWith(expectedIndent) ? raw.slice(expectedIndent.length) : raw.trimStart());
  }
  const result = docLines.join("\n").trim();
  return result.length > 300 ? result.slice(0, 297) + "..." : result;
}

function rxFindBlockEnd(lines: string[], defLineIdx: number, defIndent: number): number {
  for (let k = defLineIdx + 1; k < lines.length; k++) {
    const line = lines[k]!;
    if (line.trim() === "") continue;
    const indent = line.search(/\S/);
    if (indent >= 0 && indent <= defIndent) return k;
  }
  return lines.length;
}
