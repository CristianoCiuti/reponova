/**
 * Cross-file import resolution engine.
 *
 * Takes FileExtraction[] and resolves imports to actual files within the
 * extraction set. This is the bridge between per-file extraction and
 * cross-file graph edges.
 */
import type { FileExtraction, ImportDeclaration, LanguageExtractor } from "./types.js";
import { getExtractorForFile } from "./languages/registry.js";
import { toPosix } from "../shared/paths.js";

export interface ResolvedImport {
  /** The original import declaration */
  declaration: ImportDeclaration;
  /** File path of the source (importing) file */
  sourceFile: string;
  /** Resolved target file path (if found) */
  targetFile: string | null;
  /** Whether this import is external (no matching file in extractions) */
  isExternal: boolean;
  /** Specific imported names that were matched to symbols */
  resolvedNames: ResolvedName[];
}

export interface ResolvedName {
  /** The imported name */
  name: string;
  /** The qualified name of the target symbol (if resolved) */
  targetSymbol: string | null;
}

/**
 * Resolve all imports across a set of file extractions.
 *
 * For each import in each file:
 * 1. Get the language extractor's resolveImportPath()
 * 2. Match candidate paths against known file extractions
 * 3. For each imported name, match against symbols in the target file
 */
export function resolveImports(extractions: FileExtraction[]): ResolvedImport[] {
  // Build lookup: normalized file path → extraction
  const byPath = new Map<string, FileExtraction>();
  for (const ext of extractions) {
    const normalized = toPosix(ext.filePath);
    byPath.set(normalized, ext);
    // Also index without leading ./
    if (normalized.startsWith("./")) {
      byPath.set(normalized.slice(2), ext);
    }
  }

  // Build symbol lookup: simple name within file → qualified name
  const fileSymbols = new Map<string, Map<string, string>>(); // filePath → (simpleName → qualifiedName)

  for (const ext of extractions) {
    const nameMap = new Map<string, string>();
    for (const sym of ext.symbols) {
      nameMap.set(sym.name, sym.qualifiedName);
    }
    fileSymbols.set(ext.filePath, nameMap);
  }

  const resolved: ResolvedImport[] = [];

  for (const extraction of extractions) {
    const extractor = getExtractorForFile(extraction.filePath);
    if (!extractor) continue;

    for (const imp of extraction.imports) {
      const result = resolveOneImport(
        imp,
        extraction.filePath,
        extractor,
        byPath,
        fileSymbols,
      );
      resolved.push(result);
    }
  }

  return resolved;
}

function resolveOneImport(
  declaration: ImportDeclaration,
  sourceFile: string,
  extractor: LanguageExtractor,
  byPath: Map<string, FileExtraction>,
  fileSymbols: Map<string, Map<string, string>>,
): ResolvedImport {
  // Get candidate file paths from the extractor
  const candidates = extractor.resolveImportPath(declaration.module, sourceFile);

  // Try to match against known files
  let targetFile: string | null = null;
  for (const candidate of candidates) {
    const normalized = toPosix(candidate);
    targetFile = findInByPath(normalized, byPath);
    if (targetFile) break;
  }

  // Resolve imported names to symbols
  const resolvedNames: ResolvedName[] = [];
  if (declaration.isWildcard && targetFile) {
    const targetExtraction = byPath.get(targetFile);
    if (targetExtraction) {
      const exportedNames = targetExtraction.exports
        ?? targetExtraction.symbols.map((s) => s.name);
      const targetSymbols = fileSymbols.get(targetFile);
      if (targetSymbols) {
        for (const name of exportedNames) {
          const qualifiedName = targetSymbols.get(name) ?? null;
          if (qualifiedName) {
            resolvedNames.push({ name, targetSymbol: qualifiedName });
          }
        }
      }
    }
  } else if (targetFile && declaration.names.length > 0) {
    const targetSymbols = fileSymbols.get(targetFile);
    if (targetSymbols) {
      for (const name of declaration.names) {
        // Handle aliased imports: "name as alias" → look up "name"
        const baseName = name.split(" as ")[0]?.trim() ?? name;
        const qualifiedName = targetSymbols.get(baseName) ?? null;
        resolvedNames.push({ name: baseName, targetSymbol: qualifiedName });
      }
    }
  } else if (targetFile && declaration.names.length === 0) {
    // `import module` — the module itself is the target
    resolvedNames.push({ name: declaration.module, targetSymbol: null });
  }

  if (targetFile) {
    for (const rn of resolvedNames) {
      if (rn.targetSymbol !== null) continue;
      const targetExtraction = byPath.get(targetFile);
      if (!targetExtraction) continue;
      const reExportedSymbol = chaseReExport(
        rn.name,
        targetExtraction,
        byPath,
        fileSymbols,
        new Set([targetFile]),
        2,
      );
      if (reExportedSymbol) {
        rn.targetSymbol = reExportedSymbol;
      }
    }
  }

  return {
    declaration,
    sourceFile,
    targetFile,
    isExternal: targetFile === null,
    resolvedNames,
  };
}

function chaseReExport(
  name: string,
  fromExtraction: FileExtraction,
  byPath: Map<string, FileExtraction>,
  fileSymbols: Map<string, Map<string, string>>,
  visited: Set<string>,
  maxDepth: number,
): string | null {
  if (maxDepth <= 0) return null;
  for (const imp of fromExtraction.imports) {
    const matchesName = imp.names.includes(name)
      || imp.names.some((n) => n.split(" as ")[0]?.trim() === name);
    const matchesWildcard = imp.isWildcard;
    if (!matchesName && !matchesWildcard) continue;
    const extractor = getExtractorForFile(fromExtraction.filePath);
    if (!extractor) continue;
    const candidates = extractor.resolveImportPath(imp.module, fromExtraction.filePath);
    for (const candidate of candidates) {
      const normalized = toPosix(candidate);
      const resolvedTarget = findInByPath(normalized, byPath);
      if (!resolvedTarget || visited.has(resolvedTarget)) continue;
      visited.add(resolvedTarget);
      const symbols = fileSymbols.get(resolvedTarget);
      if (symbols) {
        const qualifiedName = symbols.get(name);
        if (qualifiedName) return qualifiedName;
      }
      const targetExtraction = byPath.get(resolvedTarget);
      if (targetExtraction) {
        const result = chaseReExport(name, targetExtraction, byPath, fileSymbols, visited, maxDepth - 1);
        if (result) return result;
      }
    }
  }
  return null;
}

function findInByPath(normalized: string, byPath: Map<string, FileExtraction>): string | null {
  if (byPath.has(normalized)) return normalized;
  for (const knownPath of byPath.keys()) {
    if (knownPath.endsWith(normalized) || knownPath.endsWith("/" + normalized)) {
      return knownPath;
    }
  }
  return null;
}
