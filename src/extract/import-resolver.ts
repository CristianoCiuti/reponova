/**
 * Cross-file import resolution engine.
 *
 * Takes FileExtraction[] and resolves imports to actual files within the
 * extraction set. This is the bridge between per-file extraction and
 * cross-file graph edges.
 */
import type { FileExtraction, ImportDeclaration, LanguageExtractor } from "./types.js";
import { getExtractorForFile } from "./languages/registry.js";

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
    const normalized = ext.filePath.replace(/\\/g, "/");
    byPath.set(normalized, ext);
    // Also index without leading ./
    if (normalized.startsWith("./")) {
      byPath.set(normalized.slice(2), ext);
    }
  }

  // Build symbol lookup: qualified name → file path
  const symbolToFile = new Map<string, string>();
  // Also: simple name within file → qualified name
  const fileSymbols = new Map<string, Map<string, string>>(); // filePath → (simpleName → qualifiedName)

  for (const ext of extractions) {
    const nameMap = new Map<string, string>();
    for (const sym of ext.symbols) {
      symbolToFile.set(sym.qualifiedName, ext.filePath);
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
    const normalized = candidate.replace(/\\/g, "/");
    if (byPath.has(normalized)) {
      targetFile = normalized;
      break;
    }
    // Try with each known file path prefix (for multi-repo scenarios)
    for (const knownPath of byPath.keys()) {
      if (knownPath.endsWith(normalized) || knownPath.endsWith("/" + normalized)) {
        targetFile = knownPath;
        break;
      }
    }
    if (targetFile) break;
  }

  // Resolve imported names to symbols
  const resolvedNames: ResolvedName[] = [];
  if (targetFile && declaration.names.length > 0) {
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

  return {
    declaration,
    sourceFile,
    targetFile,
    isExternal: targetFile === null,
    resolvedNames,
  };
}
