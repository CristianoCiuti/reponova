import type { SyntaxNode } from "./parser.js";
import type { FileOutline, ImportEntry, FunctionEntry, ClassEntry } from "../shared/types.js";

/**
 * Extract a structured outline from a Python AST root node.
 */
export function extractOutline(rootNode: SyntaxNode, filePath: string, lineCount: number): FileOutline {
  const imports: ImportEntry[] = [];
  const functions: FunctionEntry[] = [];
  const classes: ClassEntry[] = [];

  for (const child of rootNode.namedChildren) {
    switch (child.type) {
      case "import_statement":
        imports.push(extractImport(child));
        break;
      case "import_from_statement":
        imports.push(extractFromImport(child));
        break;
      case "function_definition":
        functions.push(extractFunction(child));
        break;
      case "decorated_definition":
        extractDecorated(child, functions, classes);
        break;
      case "class_definition":
        classes.push(extractClass(child));
        break;
    }
  }

  return { file_path: filePath, line_count: lineCount, imports, functions, classes };
}

function extractImport(node: SyntaxNode): ImportEntry {
  // import foo, bar
  const names = node.namedChildren
    .filter((c) => c.type === "dotted_name" || c.type === "aliased_import")
    .map((c) => c.text);

  return {
    module: names.join(", "),
    line: node.startPosition.row + 1,
  };
}

function extractFromImport(node: SyntaxNode): ImportEntry {
  // from module import name1, name2
  const moduleNode = node.namedChildren.find((c) => c.type === "dotted_name" || c.type === "relative_import");
  const module = moduleNode?.text ?? "";

  const importList = node.namedChildren.filter(
    (c) => c.type === "dotted_name" || c.type === "aliased_import",
  );
  // Skip the first dotted_name which is the module
  const names = importList.slice(moduleNode?.type === "dotted_name" ? 1 : 0).map((c) => c.text);

  // Also check for import_from_names
  const importNames = node.namedChildren.find((c) => c.type === "import_prefix" || c.type === "import_from_names");
  if (importNames) {
    names.push(...importNames.namedChildren.map((c) => c.text));
  }

  return {
    module,
    names: names.length > 0 ? names : undefined,
    line: node.startPosition.row + 1,
  };
}

function extractFunction(node: SyntaxNode, decorators: string[] = []): FunctionEntry {
  const nameNode = node.childForFieldName("name");
  const name = nameNode?.text ?? "<anonymous>";

  const paramsNode = node.childForFieldName("parameters");
  const returnType = node.childForFieldName("return_type");
  const signature = buildSignature(name, paramsNode, returnType);

  const docstring = extractDocstring(node);
  const calls = extractCalls(node);

  return {
    name,
    signature,
    decorators,
    docstring,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    calls,
  };
}

function extractClass(node: SyntaxNode, decorators: string[] = []): ClassEntry {
  const nameNode = node.childForFieldName("name");
  const name = nameNode?.text ?? "<anonymous>";

  // Extract base classes
  const superclassNode = node.childForFieldName("superclasses") ?? node.namedChildren.find((c) => c.type === "argument_list");
  const bases: string[] = [];
  if (superclassNode) {
    for (const arg of superclassNode.namedChildren) {
      if (arg.type === "identifier" || arg.type === "dotted_name" || arg.type === "attribute") {
        bases.push(arg.text);
      }
    }
  }

  const docstring = extractDocstring(node);
  const methods: FunctionEntry[] = [];

  // Extract methods from class body
  const body = node.childForFieldName("body");
  if (body) {
    for (const child of body.namedChildren) {
      if (child.type === "function_definition") {
        methods.push(extractFunction(child));
      } else if (child.type === "decorated_definition") {
        const decs = extractDecoratorList(child);
        const funcNode = child.namedChildren.find((c) => c.type === "function_definition");
        if (funcNode) {
          methods.push(extractFunction(funcNode, decs));
        }
      }
    }
  }

  return {
    name,
    bases,
    docstring,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    methods,
  };
}

function extractDecorated(
  node: SyntaxNode,
  functions: FunctionEntry[],
  classes: ClassEntry[],
): void {
  const decorators = extractDecoratorList(node);
  const definition = node.namedChildren.find(
    (c) => c.type === "function_definition" || c.type === "class_definition",
  );

  if (!definition) return;

  if (definition.type === "function_definition") {
    functions.push(extractFunction(definition, decorators));
  } else if (definition.type === "class_definition") {
    classes.push(extractClass(definition, decorators));
  }
}

function extractDecoratorList(node: SyntaxNode): string[] {
  return node.namedChildren
    .filter((c) => c.type === "decorator")
    .map((c) => {
      // Get decorator text without the @ prefix
      const text = c.text.trim();
      return text.startsWith("@") ? text.slice(1) : text;
    });
}

function buildSignature(
  name: string,
  paramsNode: SyntaxNode | null,
  returnType: SyntaxNode | null,
): string {
  const params = paramsNode?.text ?? "()";
  const ret = returnType ? ` -> ${returnType.text}` : "";
  return `${name}${params}${ret}`;
}

function extractDocstring(node: SyntaxNode): string | undefined {
  const body = node.childForFieldName("body");
  if (!body) return undefined;

  const firstChild = body.namedChildren[0];
  if (!firstChild) return undefined;

  if (firstChild.type === "expression_statement") {
    const expr = firstChild.namedChildren[0];
    if (expr && (expr.type === "string" || expr.type === "concatenated_string")) {
      // Strip triple quotes
      let text = expr.text;
      if (text.startsWith('"""') || text.startsWith("'''")) {
        text = text.slice(3, -3).trim();
      } else if (text.startsWith('"') || text.startsWith("'")) {
        text = text.slice(1, -1).trim();
      }
      return text;
    }
  }

  return undefined;
}

function extractCalls(node: SyntaxNode): string[] {
  const calls: string[] = [];
  const visited = new Set<string>();

  function walk(n: SyntaxNode): void {
    if (n.type === "call") {
      const funcNode = n.childForFieldName("function");
      if (funcNode) {
        const name = funcNode.text;
        if (!visited.has(name)) {
          visited.add(name);
          calls.push(name);
        }
      }
    }
    for (const child of n.namedChildren) {
      walk(child);
    }
  }

  const body = node.childForFieldName("body");
  if (body) walk(body);

  return calls;
}
