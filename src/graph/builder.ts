/**
 * Language-agnostic graph builder.
 *
 * Takes FileExtraction[] from any language and produces a graphology directed
 * graph. This is the core of the extraction pipeline.
 *
 * Design principle: The assembler makes ZERO classification decisions.
 * Each extractor declares `fileNode` with the file's nature (kind, label, docstring).
 * The assembler mechanically creates nodes and edges from that declaration.
 *
 * Node types: function, class, method, module, document, diagram, section, component, constant
 * Edge types: calls, imports, imports_from, extends, contains, references
 */
import Graph from "graphology";
import type { FileExtraction } from "../extract/types.js";
import { resolveImports } from "../extract/import-resolver.js";
import { posixBasename, toPosix } from "../shared/paths.js";

export interface BuildGraphOptions {
  /** All file extractions (can be from mixed languages) */
  extractions: FileExtraction[];
  /** Repo name for tagging (optional, single-repo mode) */
  repoName?: string;
  /** Known repo names for validation (optional, multi-repo mode) */
  repoNames?: string[];
}

export interface BuiltGraph {
  graph: Graph;
  /** Statistics about the build */
  stats: {
    nodeCount: number;
    edgeCount: number;
    fileCount: number;
    crossFileEdges: number;
    unresolvedImports: number;
  };
}

/**
 * Build a directed graph from file extractions.
 */
export function buildGraph(options: BuildGraphOptions): BuiltGraph {
  const { extractions, repoName, repoNames } = options;
  const graph = new Graph({ type: "directed", multi: true, allowSelfLoops: false });

  let crossFileEdges = 0;
  let unresolvedImports = 0;

  // ── 1. Create file-level nodes from fileNode declarations ──────────────

  for (const extraction of extractions) {
    const filePath = toPosix(extraction.filePath);
    const moduleId = filePath;
    const fileNode = extraction.fileNode;
    const label = fileNode.label ?? posixBasename(filePath);

    if (!graph.hasNode(moduleId)) {
      graph.addNode(moduleId, {
        label,
        type: fileNode.kind,
        file_type: fileNode.kind === "module" ? "code" : "doc",
        source_file: filePath,
        repo: repoName ?? inferRepoName(filePath, repoNames),
        start_line: 1,
        end_line: undefined,
        norm_label: label.toLowerCase(),
        docstring: fileNode.docstring,
        tags: fileNode.tags,
      });
    }
  }

  // ── 2. Create symbol nodes + containment edges ─────────────────────────

  for (const extraction of extractions) {
    const filePath = toPosix(extraction.filePath);
    const moduleId = filePath;

    for (const symbol of extraction.symbols) {
      const nodeId = symbol.qualifiedName;

      if (!graph.hasNode(nodeId)) {
        graph.addNode(nodeId, {
          label: symbol.name,
          type: symbol.kind,
          file_type: extraction.fileNode.kind === "module" ? "code" : "doc",
          source_file: filePath,
          source_location: `L${symbol.startLine}${symbol.endLine ? `-L${symbol.endLine}` : ""}`,
          repo: repoName ?? inferRepoName(filePath, repoNames),
          start_line: symbol.startLine,
          end_line: symbol.endLine,
          norm_label: symbol.name.toLowerCase(),
          docstring: symbol.docstring,
          signature: symbol.signature,
          bases: symbol.bases,
        });
      }

      // Determine containment edge
      if (symbol.parent) {
        const parentId = extraction.symbols.find((s) => s.name === symbol.parent)?.qualifiedName ?? null;
        if (!parentId || parentId === moduleId || !graph.hasNode(parentId)) {
          // Parent is the file node → use "contains"
          addEdgeSafe(graph, moduleId, nodeId, "contains");
        } else {
          // Parent is a class or other container — always "contains"
          addEdgeSafe(graph, parentId, nodeId, "contains");
          // Also add file→symbol edge for discoverability
          addEdgeSafe(graph, moduleId, nodeId, "contains");
        }
      } else {
        // No parent → direct child of file
        addEdgeSafe(graph, moduleId, nodeId, "contains");
      }
    }
  }

  // ── 3. Resolve imports → IMPORTS edges ─────────────────────────────────

  const resolvedImports = resolveImports(extractions);

  for (const ri of resolvedImports) {
    if (ri.isExternal) {
      unresolvedImports++;
      continue;
    }

    if (!ri.targetFile) continue;

    const sourceModuleId = toPosix(ri.sourceFile);

    for (const rn of ri.resolvedNames) {
      if (rn.targetSymbol) {
        const targetId = rn.targetSymbol;
        if (targetId) {
          addEdgeSafe(graph, sourceModuleId, targetId, "imports_from");
          crossFileEdges++;
        }
      } else {
        // Import of the module itself
        const targetModuleId = toPosix(ri.targetFile);
        if (graph.hasNode(targetModuleId)) {
          addEdgeSafe(graph, sourceModuleId, targetModuleId, "imports");
          crossFileEdges++;
        }
      }
    }

    // If no specific names resolved but we have a target file
    if (ri.resolvedNames.length === 0 && ri.targetFile) {
      const targetModuleId = toPosix(ri.targetFile);
      if (graph.hasNode(targetModuleId)) {
        addEdgeSafe(graph, sourceModuleId, targetModuleId, "imports");
        crossFileEdges++;
      }
    }
  }

  // ── 4. Resolve references → CALLS / EXTENDS / REFERENCES edges ─────────

  // Build import mapping: for each file, which imported names → which target node IDs
  const importedNames = new Map<string, Map<string, string>>(); // filePath → (name → targetNodeId)

  for (const ri of resolvedImports) {
    if (ri.isExternal || !ri.targetFile) continue;

    const key = toPosix(ri.sourceFile);
    if (!importedNames.has(key)) {
      importedNames.set(key, new Map());
    }
    const fileImports = importedNames.get(key)!;

    for (const rn of ri.resolvedNames) {
      if (rn.targetSymbol) {
        const targetId = rn.targetSymbol;
        if (targetId) {
          fileImports.set(rn.name, targetId);
        }
      }
    }
  }

  for (const extraction of extractions) {
    const filePath = toPosix(extraction.filePath);
    const fileImports = importedNames.get(filePath) ?? new Map<string, string>();
    const isDoc = extraction.fileNode.kind !== "module";

    for (const ref of extraction.references) {
      const sourceId = ref.fromSymbol;
      if (!graph.hasNode(sourceId)) continue;

      const targetId = resolveReference(
        ref.name,
        filePath,
        extraction,
        fileImports,
        graph,
      );
      if (targetId && targetId !== sourceId) {
        const edgeType = mapReferenceKind(ref.kind, isDoc);
        addEdgeSafe(graph, sourceId, targetId, edgeType);
        if (!isSameFile(graph, sourceId, targetId)) {
          crossFileEdges++;
        }
      }
    }
  }

  return {
    graph,
    stats: {
      nodeCount: graph.order,
      edgeCount: graph.size,
      fileCount: extractions.length,
      crossFileEdges,
      unresolvedImports,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a reference name to a target node ID.
 *
 * Resolution order:
 * 1. Direct node ID: if ref.name is an existing node ID (file path, qualifiedName)
 * 2. Import-based: if name matches an imported name
 * 3. Same-file: if name matches a symbol in the same file
 * 4. Attribute-based: "obj.method" → try to resolve obj's type
 */
function resolveReference(
  refName: string,
  _filePath: string,
  extraction: FileExtraction,
  fileImports: Map<string, string>,
  graph: Graph,
): string | null {
  // 0. Direct node ID match (file paths, fully qualified names)
  if (graph.hasNode(refName)) return refName;

  // Handle attribute calls: "self.method" → just "method"
  let simpleName = refName;
  if (refName.includes(".")) {
    const parts = refName.split(".");
    simpleName = parts[parts.length - 1]!;

    // "self.method" → look up method in same class
    if (parts[0] === "self") {
      const sameFileSymbol = extraction.symbols.find(
        (s) => s.name === simpleName && s.kind === "method",
      );
      if (sameFileSymbol) {
        return sameFileSymbol.qualifiedName;
      }
    }

    // "ClassName.method" or "module.function" → try import resolution
    const baseName = parts[0]!;
    const importedTarget = fileImports.get(baseName);
    if (importedTarget && graph.hasNode(importedTarget)) {
      let methodId: string | null = null;
      graph.forEachOutEdge(importedTarget, (_edge, attrs, _src, target) => {
        if (attrs.relation === "contains" && graph.getNodeAttribute(target, "label") === simpleName) {
          methodId = target;
        }
      });
      if (methodId) return methodId;
    }
  }

  // 1. Import-based resolution
  const importTarget = fileImports.get(simpleName);
  if (importTarget) return importTarget;

  // 2. Same-file resolution
  const sameFileSymbol = extraction.symbols.find(
    (s) => s.name === simpleName && (s.kind === "function" || s.kind === "class" || s.kind === "method"),
  );
  if (sameFileSymbol) {
    return sameFileSymbol.qualifiedName;
  }

  return null;
}

/**
 * Map a SymbolReference kind to a graph edge type.
 * Doc/diagram sources produce "references" for calls (semantically distinct from code calls).
 */
function mapReferenceKind(kind: string, isDoc: boolean): string {
  switch (kind) {
    case "call":
      return isDoc ? "references" : "calls";
    case "inheritance":
      return "extends";
    case "type_annotation":
    case "attribute_access":
      return "references";
    default:
      return "references";
  }
}

function isSameFile(graph: Graph, callerId: string, targetId: string): boolean {
  if (!graph.hasNode(callerId) || !graph.hasNode(targetId)) return false;
  return graph.getNodeAttribute(callerId, "source_file") === graph.getNodeAttribute(targetId, "source_file");
}

function addEdgeSafe(graph: Graph, source: string, target: string, edgeType: string): void {
  if (!graph.hasNode(source) || !graph.hasNode(target)) return;
  if (source === target) return;

  // With multi:true, check if this exact (source, target, type) already exists
  let duplicateFound = false;
  graph.forEachEdge(source, (_edge, attrs, _src, tgt) => {
    if (tgt === target && attrs.relation === edgeType) duplicateFound = true;
  });
  if (duplicateFound) return;

  graph.addEdge(source, target, {
    relation: edgeType,
    confidence: "EXTRACTED",
    confidence_score: 1.0,
    weight: 1,
  });
}

/**
 * Infer repo name from the first path component.
 * When repoNames is provided, validates against known repo names.
 */
function inferRepoName(filePath: string, repoNames?: string[]): string | undefined {
  const first = filePath.split("/")[0];
  if (!first || first === ".") return undefined;
  if (repoNames && repoNames.length > 0) {
    return repoNames.includes(first) ? first : undefined;
  }
  return first;
}
