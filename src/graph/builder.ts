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
 * Edge types: calls, imports, imports_from, extends, contains
 */
import Graph from "graphology";
import type { FileExtraction } from "../extract/types.js";
import { resolveImports } from "../extract/import-resolver.js";

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
    const filePath = extraction.filePath.replace(/\\/g, "/");
    const moduleId = filePath;
    const fileNode = extraction.fileNode;
    const label = fileNode.label ?? filePath.split("/").pop() ?? filePath;

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
    const filePath = extraction.filePath.replace(/\\/g, "/");
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

    const sourceModuleId = ri.sourceFile.replace(/\\/g, "/");

    for (const rn of ri.resolvedNames) {
      if (rn.targetSymbol) {
        const targetId = rn.targetSymbol;
        if (targetId) {
          addEdgeSafe(graph, sourceModuleId, targetId, "imports_from");
          crossFileEdges++;
        }
      } else {
        // Import of the module itself
        const targetModuleId = ri.targetFile.replace(/\\/g, "/");
        if (graph.hasNode(targetModuleId)) {
          addEdgeSafe(graph, sourceModuleId, targetModuleId, "imports");
          crossFileEdges++;
        }
      }
    }

    // If no specific names resolved but we have a target file
    if (ri.resolvedNames.length === 0 && ri.targetFile) {
      const targetModuleId = ri.targetFile.replace(/\\/g, "/");
      if (graph.hasNode(targetModuleId)) {
        addEdgeSafe(graph, sourceModuleId, targetModuleId, "imports");
        crossFileEdges++;
      }
    }
  }

  // ── 4. Resolve calls → CALLS edges ────────────────────────────────────

  // Build import mapping: for each file, which imported names → which target node IDs
  const importedNames = new Map<string, Map<string, string>>(); // filePath → (name → targetNodeId)

  for (const ri of resolvedImports) {
    if (ri.isExternal || !ri.targetFile) continue;

    const key = ri.sourceFile.replace(/\\/g, "/");
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
    const filePath = extraction.filePath.replace(/\\/g, "/");
    const fileImports = importedNames.get(filePath) ?? new Map<string, string>();

    for (const symbol of extraction.symbols) {
      if (symbol.calls.length === 0) continue;
      const callerId = symbol.qualifiedName;
      if (!graph.hasNode(callerId)) continue;

      for (const callName of symbol.calls) {
        const targetId = resolveCall(
          callName,
          filePath,
          extraction,
          fileImports,
          graph,
        );
        if (targetId && targetId !== callerId) {
          addEdgeSafe(graph, callerId, targetId, "calls");
          if (!isSameFile(graph, callerId, targetId)) {
            crossFileEdges++;
          }
        }
      }
    }
  }

  // ── 5. Resolve inheritance → EXTENDS edges ────────────────────────────

  for (const extraction of extractions) {
    const filePath = extraction.filePath.replace(/\\/g, "/");
    const fileImports = importedNames.get(filePath) ?? new Map<string, string>();

    for (const symbol of extraction.symbols) {
      if (!symbol.bases || symbol.bases.length === 0) continue;
      const classId = symbol.qualifiedName;

      for (const base of symbol.bases) {
        // Try import-based resolution first
        const baseName = base.includes(".") ? base.split(".").pop()! : base;
        let targetId = fileImports.get(baseName) ?? fileImports.get(base);

        // Try same-file resolution
        if (!targetId) {
          const sameFileSymbol = extraction.symbols.find(
            (s) => s.name === baseName && s.kind === "class",
          );
          if (sameFileSymbol) {
            targetId = sameFileSymbol.qualifiedName;
          }
        }

        if (targetId && graph.hasNode(classId) && graph.hasNode(targetId)) {
          addEdgeSafe(graph, classId, targetId, "extends");
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
 * Resolve a call name to a target node ID.
 *
 * Resolution order:
 * 1. Import-based: if call name matches an imported name
 * 2. Same-file: if call name matches a symbol in the same file
 * 3. Attribute-based: "obj.method" → try to resolve obj's type
 * 4. Global: if call name uniquely matches one symbol across all files
 */
function resolveCall(
  callName: string,
  _filePath: string,
  extraction: FileExtraction,
  fileImports: Map<string, string>,
  graph: Graph,
): string | null {
  // Handle attribute calls: "self.method" → just "method"
  let simpleName = callName;
  if (callName.includes(".")) {
    const parts = callName.split(".");
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
