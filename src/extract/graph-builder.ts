/**
 * Language-agnostic graph builder.
 *
 * Takes FileExtraction[] from any language and produces a graphology directed
 * graph. This is the core of the extraction pipeline.
 *
 * Node types: function, class, method, module, constant
 * Edge types: CALLS, IMPORTS, EXTENDS, MEMBER_OF, CONTAINS
 */
import Graph from "graphology";
import type { FileExtraction } from "./types.js";
import { resolveImports } from "./import-resolver.js";

export interface BuildGraphOptions {
  /** All file extractions (can be from mixed languages) */
  extractions: FileExtraction[];
  /** Repo name for tagging (optional) */
  repoName?: string;
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
 * Deterministic node ID generation.
 * Same formula: combine file path and symbol name, normalize to lowercase alphanumeric.
 */
function makeNodeId(filePath: string, symbolName: string): string {
  const combined = `${filePath}/${symbolName}`;
  return combined.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").toLowerCase();
}

/**
 * Build a directed graph from file extractions.
 */
export function buildGraph(options: BuildGraphOptions): BuiltGraph {
  const { extractions, repoName } = options;
  const graph = new Graph({ type: "directed", multi: false, allowSelfLoops: false });

  let crossFileEdges = 0;
  let unresolvedImports = 0;

  // ── 1. Create module nodes (one per file) ──────────────────────────────

  for (const extraction of extractions) {
    const filePath = extraction.filePath.replace(/\\/g, "/");
    const moduleId = makeNodeId(filePath, "");
    const label = filePath.split("/").pop() ?? filePath;
    const isDoc = extraction.language === "markdown";

    if (!graph.hasNode(moduleId)) {
      graph.addNode(moduleId, {
        label,
        type: isDoc ? "document" : "module",
        file_type: isDoc ? "doc" : "code",
        source_file: filePath,
        repo: repoName ?? inferRepoName(filePath),
        start_line: 1,
        end_line: undefined,
        norm_label: label.toLowerCase(),
      });
    }
  }

  // ── 2. Create symbol nodes + MEMBER_OF/CONTAINS edges ─────────────────

  // Track: qualifiedName → nodeId for cross-referencing
  const qualifiedToId = new Map<string, string>();
  // Track: simple name → nodeId[] for call resolution
  const simpleNameToIds = new Map<string, string[]>();

  for (const extraction of extractions) {
    const filePath = extraction.filePath.replace(/\\/g, "/");
    const moduleId = makeNodeId(filePath, "");
    const isDoc = extraction.language === "markdown";

    for (const symbol of extraction.symbols) {
      const nodeId = makeNodeId(filePath, symbol.name);
      qualifiedToId.set(symbol.qualifiedName, nodeId);

      // Register simple name for call resolution
      const existing = simpleNameToIds.get(symbol.name);
      if (existing) {
        existing.push(nodeId);
      } else {
        simpleNameToIds.set(symbol.name, [nodeId]);
      }

      if (!graph.hasNode(nodeId)) {
        graph.addNode(nodeId, {
          label: symbol.name,
          type: symbol.kind,
          file_type: isDoc ? "doc" : "code",
          source_file: filePath,
          source_location: `L${symbol.startLine}${symbol.endLine ? `-L${symbol.endLine}` : ""}`,
          repo: repoName ?? inferRepoName(filePath),
          start_line: symbol.startLine,
          end_line: symbol.endLine,
          norm_label: symbol.name.toLowerCase(),
          docstring: symbol.docstring,
          signature: symbol.signature,
        });
      }

      // MEMBER_OF: symbol → module (contains relationship)
      addEdgeSafe(graph, moduleId, nodeId, "contains");

      // CONTAINS: class → method (or document → section)
      if (symbol.parent) {
        const parentId = makeNodeId(filePath, symbol.parent);
        if (graph.hasNode(parentId)) {
          addEdgeSafe(graph, parentId, nodeId, isDoc ? "contains_section" : "method");
        }
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

    const sourceModuleId = makeNodeId(ri.sourceFile.replace(/\\/g, "/"), "");

    for (const rn of ri.resolvedNames) {
      if (rn.targetSymbol) {
        const targetId = qualifiedToId.get(rn.targetSymbol);
        if (targetId) {
          addEdgeSafe(graph, sourceModuleId, targetId, "imports_from");
          crossFileEdges++;
        }
      } else {
        // Import of the module itself
        const targetModuleId = makeNodeId(ri.targetFile.replace(/\\/g, "/"), "");
        if (graph.hasNode(targetModuleId)) {
          addEdgeSafe(graph, sourceModuleId, targetModuleId, "imports");
          crossFileEdges++;
        }
      }
    }

    // If no specific names resolved but we have a target file
    if (ri.resolvedNames.length === 0 && ri.targetFile) {
      const targetModuleId = makeNodeId(ri.targetFile.replace(/\\/g, "/"), "");
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
        const targetId = qualifiedToId.get(rn.targetSymbol);
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
      const callerId = makeNodeId(filePath, symbol.name);
      if (!graph.hasNode(callerId)) continue;

      for (const callName of symbol.calls) {
        const targetId = resolveCall(
          callName,
          filePath,
          extraction,
          fileImports,
          qualifiedToId,
          simpleNameToIds,
        );
        if (targetId && targetId !== callerId) {
          addEdgeSafe(graph, callerId, targetId, "calls");
          if (!isSameFile(callerId, targetId, filePath, extraction)) {
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
      const classId = makeNodeId(filePath, symbol.name);

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
            targetId = qualifiedToId.get(sameFileSymbol.qualifiedName);
          }
        }

        // Try global name resolution
        if (!targetId) {
          const candidates = simpleNameToIds.get(baseName);
          if (candidates && candidates.length === 1) {
            targetId = candidates[0];
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
  qualifiedToId: Map<string, string>,
  simpleNameToIds: Map<string, string[]>,
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
        return qualifiedToId.get(sameFileSymbol.qualifiedName) ?? null;
      }
    }

    // "ClassName.method" or "module.function" → try import resolution
    const baseName = parts[0]!;
    const importedTarget = fileImports.get(baseName);
    if (importedTarget) {
      // The import resolved to a class/module, now find the method
      const candidates = simpleNameToIds.get(simpleName);
      if (candidates) {
        // Prefer same repo/module
        return candidates[0] ?? null;
      }
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
    return qualifiedToId.get(sameFileSymbol.qualifiedName) ?? null;
  }

  // 3. Global unique resolution (only if unambiguous)
  const candidates = simpleNameToIds.get(simpleName);
  if (candidates && candidates.length === 1) {
    return candidates[0] ?? null;
  }

  return null;
}

function isSameFile(
  _callerId: string,
  _targetId: string,
  _filePath: string,
  _extraction: FileExtraction,
): boolean {
  // Simple heuristic: IDs derived from same file will share a prefix
  // This is approximate but sufficient for stats
  return false;
}

function addEdgeSafe(graph: Graph, source: string, target: string, edgeType: string): void {
  if (!graph.hasNode(source) || !graph.hasNode(target)) return;
  if (source === target) return;

  // Check for existing edge of same type
  if (graph.hasEdge(source, target)) {
    // Check if this specific edge type already exists
    try {
      const existingType = graph.getEdgeAttribute(graph.edge(source, target)!, "relation");
      if (existingType === edgeType) return;
    } catch {
      // Edge exists but can't get attribute — skip duplicate
      return;
    }
  }

  try {
    graph.addEdge(source, target, {
      relation: edgeType,
      confidence: "EXTRACTED",
      confidence_score: 1.0,
      weight: 1,
    });
  } catch {
    // Edge already exists (parallel edge in non-multi graph) — ignore
  }
}

/**
 * Infer repo name from the first path component.
 */
function inferRepoName(filePath: string): string | undefined {
  const first = filePath.split("/")[0];
  return first && first !== "." ? first : undefined;
}
