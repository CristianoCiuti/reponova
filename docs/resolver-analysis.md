# Import Resolver — Analisi e Piano di Fix

**Data**: 2025-05-09
**Branch**: `refactor`
**Dipendenza**: BUG-005 richiede questo fix per rimozione completa di `simpleNameToIds`

---

## Indice

1. [Architettura attuale](#architettura-attuale)
2. [Gap identificati](#gap-identificati)
3. [Analisi per linguaggio](#analisi-per-linguaggio)
4. [Impatto sui tool MCP](#impatto-sui-tool-mcp)
5. [Soluzione proposta](#soluzione-proposta)
6. [File da modificare](#file-da-modificare)
7. [Test plan](#test-plan)

---

## Architettura attuale

### Componenti

L'architettura e' gia' divisa in due layer:

**1. Language-specific** — ogni `LanguageExtractor` implementa:
- `extract()` → produce `FileExtraction` con `imports: ImportDeclaration[]`
- `resolveImportPath(importModule, currentFilePath): string[]` → converte un modulo in candidate file paths

**2. Language-agnostic** — `import-resolver.ts` orchestra:
1. Costruisce lookup: `filePath → FileExtraction`
2. Costruisce lookup: `filePath → (simpleName → qualifiedName)`
3. Per ogni import di ogni file, chiama `extractor.resolveImportPath()` per ottenere candidate paths
4. Matcha i candidati contro i file estratti noti
5. Per ogni nome importato, cerca nel symbol map del file target

### Flusso dati

```
FileExtraction[]
  │
  ├── byPath: Map<filePath, FileExtraction>         (file lookup)
  ├── fileSymbols: Map<filePath, Map<name, qName>>   (per-file symbol lookup)
  └── symbolToFile: Map<qualifiedName, filePath>      (DEAD CODE — non usata dopo costruzione)
  │
  ▼
Per ogni file.imports:
  1. extractor.resolveImportPath(module) → candidate paths
  2. Match candidate vs byPath → targetFile
  3. Per ogni imported name:
     fileSymbols.get(targetFile).get(name) → qualifiedName
  4. Output: ResolvedImport { targetFile, resolvedNames[] }
```

### Tipo `ImportDeclaration`

```typescript
interface ImportDeclaration {
  module: string;        // "os.path", "./utils", "lodash"
  names: string[];       // ["join", "dirname"] oppure [] per module import
  isWildcard: boolean;   // true per "from x import *"
  isExport?: boolean;    // true per re-export (NON usato dal resolver)
  line: number;
}
```

Nota: `symbolToFile` (L52-59) e' costruita ma **mai usata** dopo il build. E' dead code.

---

## Gap identificati

### GAP-1: Wildcard imports non espansi

**Codice**: `import-resolver.ts:116-129`

```typescript
if (targetFile && declaration.names.length > 0) {
  // Risolve nomi specifici → OK
} else if (targetFile && declaration.names.length === 0) {
  // Module import senza nomi → tratta come import del modulo stesso
  resolvedNames.push({ name: declaration.module, targetSymbol: null });
}
```

**Problema**: Quando `isWildcard === true`, `declaration.names` e' vuoto (l'extractor Python non espande i nomi). Il resolver cade nel ramo `names.length === 0` e tratta il wildcard come un import del modulo. **Nessun simbolo individuale viene risolto.**

**Scenario concreto**:
```python
# utils/__init__.py
def validate_input(data): ...
def sanitize_output(data): ...

# api.py
from utils import *
validate_input(user_data)  # ← nessun edge "calls" creato
```

L'extractor produce `{ module: "utils", names: [], isWildcard: true }`. Il resolver trova `utils/__init__.py` come target ma non espande `validate_input` nei resolvedNames. La chiamata `validate_input()` in `api.py` non ha un edge nel grafo.

### GAP-2: Re-export transitivi non seguiti

**Codice**: `import-resolver.ts:117-125`

```typescript
const targetSymbols = fileSymbols.get(targetFile);
if (targetSymbols) {
  for (const name of declaration.names) {
    const baseName = name.split(" as ")[0]?.trim() ?? name;
    const qualifiedName = targetSymbols.get(baseName) ?? null;  // ← cerca SOLO nel file target
    resolvedNames.push({ name: baseName, targetSymbol: qualifiedName });
  }
}
```

**Problema**: `targetSymbols` contiene solo i simboli **definiti direttamente** nel file target. Se il file target e' un `__init__.py` che ri-esporta simboli da submoduli, quei simboli non sono nei suoi `symbols[]` — sono negli `imports[]` del target.

**Scenario concreto**:
```python
# package/__init__.py
from .validators import validate_input   # re-export
from .sanitizers import sanitize_output  # re-export

# package/validators.py
def validate_input(data): ...

# api.py
from package import validate_input  # ← targetSymbols di __init__.py NON contiene validate_input
```

Il resolver trova `package/__init__.py` come target. Cerca `validate_input` nei simboli di `__init__.py` → non lo trova (e' solo importato, non definito). Il nome non viene risolto → nessun edge `imports_from`.

### GAP-3: `isExport` non utilizzato

Il campo `isExport` esiste su `ImportDeclaration` ma il resolver lo ignora completamente. Potrebbe essere usato per identificare re-export e seguirli.

### GAP-4: Dead code `symbolToFile`

`symbolToFile` (L52-59) viene costruita ma mai passata a `resolveOneImport()` ne' usata altrove. E' dead code da rimuovere.

---

## Analisi per linguaggio

### L'import-resolver vale per tutti i linguaggi?

**Si'**: `import-resolver.ts` e' language-agnostic by design. Ogni linguaggio fornisce il proprio `resolveImportPath()`. L'architettura e' corretta: orchestrazione condivisa + hook language-specific.

**Ma**: i GAP identificati sono nel layer condiviso, quindi impattano tutti i linguaggi attuali e futuri.

### Esiste un metodo nativo per-linguaggio per individuare la catena delle dipendenze?

**Si', ogni linguaggio ha semantiche specifiche**:

| Linguaggio | Import Model | Wildcard Semantics | Re-export Semantics |
|------------|-------------|-------------------|---------------------|
| **Python** | File-based, `__init__.py` packages | `from x import *` → espone `__all__` o tutti i nomi pubblici (no `_` prefix) | Import in `__init__.py` rende il nome disponibile ai consumatori |
| **TypeScript/JS** | File-based + node_modules + tsconfig paths | `import * as ns from './mod'` (namespace, non wildcard) | `export { name } from './mod'` e `export * from './mod'` |
| **Go** | Package-based, tutti gli exported (uppercase) disponibili | N/A — importi il package intero | N/A — no re-export, ogni package espone direttamente |
| **Java** | Classpath + package structure | `import java.util.*` → tutte le classi nel package | N/A |
| **Rust** | Crate/module system | `use crate::module::*` (glob import) | `pub use` (explicit re-export) |

### Cosa serve per ogni linguaggio

**Python** (unico linguaggio attualmente supportato per extraction):
1. **Wildcard expansion**: quando `isWildcard`, cercare `__all__` nel file target. Se assente, usare tutti i simboli il cui nome non inizia con `_`.
2. **Re-export chasing**: se un nome non e' nei `symbols` del target, cercare nei suoi `imports` — se il target importa quel nome da un altro file, seguire la catena (1 livello, con cycle detection).
3. **`__init__.py` awareness**: gli import in `__init__.py` sono implicitamente re-export.

**TypeScript/JS** (futuro):
1. `export * from './mod'` → l'extractor dovrebbe marcare come `isExport: true` e `isWildcard: true`
2. `export { name } from './mod'` → l'extractor dovrebbe marcare come `isExport: true`
3. Il resolver seguirebbe re-export come per Python
4. Module resolution (node_modules, tsconfig paths) → nel `resolveImportPath()` dell'extractor

**Go, Java, Rust** (futuro):
- Le semantiche specifiche sarebbero gestite nel `resolveImportPath()` e nell'extractor
- Il resolver language-agnostic resta valido se gestisce wildcard e re-export genericamente

### Conclusione architetturale

L'architettura a due layer e' corretta. I fix vanno nel layer condiviso (`import-resolver.ts`) con aggiunte mirate al contratto dell'extractor. Non serve un resolver per-linguaggio.

---

## Impatto sui tool MCP

Senza la fix del resolver, `simpleNameToIds` (fallback euristico in `graph-builder.ts`) compensa parzialmente i GAP. Se rimossa senza fix del resolver, **6 tool MCP su 11 perdono informazione a runtime**:

| Tool | Come traversa edge | Impatto senza fix |
|------|-------------------|-------------------|
| `graph_impact` | BFS, TUTTI gli edge, nessun filtro tipo | Blast radius incompleto — dipendenze da wildcard/re-export invisibili |
| `graph_path` | Dijkstra, filtro `edge_types` | Percorsi non trovati tra nodi connessi solo via wildcard/re-export |
| `graph_search` | BFS/DFS context expansion, tutti i tipi | Contesto mancante — nodi collegati via wildcard non scoperti |
| `graph_context` | 1-hop expansion + centrality scoring | Scoring e relazioni degradati |
| `graph_explain` | Incoming/outgoing grouped by type | Edge mancanti nel dettaglio nodo |
| `graph_docs` | Edge da doc nodes a code nodes | Linked code incompleto |

Indirettamente: `graph_hotspots` e `graph_community` usano degree/betweenness che cambiano con meno edge.

**`graph_similar`**, **`graph_outline`**, **`graph_status`** non sono impattati (vector search / file outlines / metadata).

---

## Soluzione proposta

### Principi

1. Non creare un resolver per-linguaggio — l'architettura a due layer e' corretta
2. Estendere il contratto `LanguageExtractor` con un metodo opzionale per export semantics
3. Aggiungere wildcard expansion e re-export chasing nel resolver condiviso
4. Mantenere depth limit e cycle detection per evitare loop infiniti

### Estensione interfaccia `LanguageExtractor`

```typescript
interface LanguageExtractor {
  // ... esistenti ...

  /**
   * Returns the names exported by a file extraction.
   * Used by the resolver for wildcard import expansion.
   *
   * - Python: __all__ if present, otherwise all symbols not starting with "_"
   * - TS/JS: explicitly exported names
   * - Default (if not implemented): all symbol names
   *
   * @param extraction - The file extraction to get exports from
   * @returns Array of exported simple names
   */
  getExportedNames?(extraction: FileExtraction): string[];
}
```

Se l'extractor non implementa `getExportedNames`, il resolver usa tutti i `symbols[].name` del file target (comportamento conservativo).

### Estensione `FileExtraction` (opzionale)

```typescript
interface FileExtraction {
  // ... esistenti ...

  /**
   * Explicitly exported symbol names, for languages with export semantics.
   * If undefined, all symbols are considered exported.
   * Python: derived from __all__ or public names (no _ prefix)
   * TS/JS: names with export keyword
   */
  exports?: string[];
}
```

Alternativa a `getExportedNames()` — l'extractor popola il campo durante l'estrazione. Pro: nessun metodo aggiuntivo. Contro: meno flessibile (non puo' tenere conto del contesto del resolver).

**Raccomandazione**: usare il campo `exports` su `FileExtraction`. E' piu' semplice, il dato e' gia' disponibile durante l'estrazione, e non richiede che il resolver conosca l'extractor.

### Implementazione wildcard expansion in `import-resolver.ts`

```typescript
// In resolveOneImport(), dopo aver trovato targetFile:

if (declaration.isWildcard && targetFile) {
  const targetExtraction = byPath.get(targetFile);
  if (targetExtraction) {
    // Usa exports se disponibile, altrimenti tutti i simboli
    const exportedNames = targetExtraction.exports
      ?? targetExtraction.symbols.map(s => s.name);
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
}
```

### Implementazione re-export chasing in `import-resolver.ts`

```typescript
// Dopo il lookup standard dei nomi (dove qualifiedName risulta null):

for (const rn of resolvedNames) {
  if (rn.targetSymbol !== null) continue;  // gia' risolto

  // Il nome non e' nei simboli del target → cercare nei suoi import (re-export)
  const targetExtraction = byPath.get(targetFile!);
  if (!targetExtraction) continue;

  const reExportedSymbol = chaseReExport(
    rn.name,
    targetExtraction,
    byPath,
    fileSymbols,
    new Set([targetFile!]),  // visited, per cycle detection
    1,                        // max depth
  );
  if (reExportedSymbol) {
    rn.targetSymbol = reExportedSymbol;
  }
}
```

```typescript
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
    // Cerca import che importano il nome cercato
    const matchesName = imp.names.includes(name)
      || imp.names.some(n => n.split(" as ")[0]?.trim() === name);
    const matchesWildcard = imp.isWildcard;

    if (!matchesName && !matchesWildcard) continue;

    // Risolvi il target di questo import
    const extractor = getExtractorForFile(fromExtraction.filePath);
    if (!extractor) continue;

    const candidates = extractor.resolveImportPath(imp.module, fromExtraction.filePath);
    for (const candidate of candidates) {
      const normalized = candidate.replace(/\\/g, "/");
      const resolvedTarget = findInByPath(normalized, byPath);
      if (!resolvedTarget || visited.has(resolvedTarget)) continue;
      visited.add(resolvedTarget);

      // Cerca il nome nei simboli del file risolto
      const symbols = fileSymbols.get(resolvedTarget);
      if (symbols) {
        const qualifiedName = symbols.get(name);
        if (qualifiedName) return qualifiedName;
      }

      // Ricorsione (con depth limit)
      const targetExtraction = byPath.get(resolvedTarget);
      if (targetExtraction) {
        const result = chaseReExport(name, targetExtraction, byPath, fileSymbols, visited, maxDepth - 1);
        if (result) return result;
      }
    }
  }

  return null;
}
```

### Implementazione `exports` nel Python extractor

```typescript
// In python.ts extract():

// Dopo aver estratto tutti i symbols, calcolare exports
const exports = this.computeExports(tree, symbols);
return { filePath, language: "python", fileNode, symbols, imports, references, exports };

// ...

private computeExports(tree: SyntaxTree, symbols: SymbolNode[]): string[] {
  // Cercare __all__ nel modulo
  const allList = this.extractDunderAll(tree);
  if (allList) return allList;

  // Fallback: tutti i simboli il cui nome non inizia con "_"
  return symbols
    .filter(s => !s.name.startsWith("_"))
    .map(s => s.name);
}

private extractDunderAll(tree: SyntaxTree): string[] | null {
  // Cercare: __all__ = ["name1", "name2", ...]
  for (const child of tree.rootNode.namedChildren) {
    if (child.type !== "expression_statement") continue;
    const expr = child.namedChildren[0];
    if (!expr || expr.type !== "assignment") continue;

    const left = expr.childForFieldName("left");
    if (!left || left.text !== "__all__") continue;

    const right = expr.childForFieldName("right");
    if (!right || right.type !== "list") continue;

    const names: string[] = [];
    for (const element of right.namedChildren) {
      if (element.type === "string") {
        // Rimuovi quotes: "name" → name
        const text = element.text.replace(/^["']|["']$/g, "");
        if (text) names.push(text);
      }
    }
    return names.length > 0 ? names : null;
  }
  return null;
}
```

### Gestione `__init__.py`

In Python, ogni import a livello di modulo in `__init__.py` rende il nome disponibile per i consumatori del package. L'extractor Python dovrebbe:

1. Detectare se il file e' un `__init__.py` (dal filePath)
2. Se si', marcare tutti gli import come `isExport: true`

```typescript
// In python.ts extract(), dopo aver estratto gli import:
const isInit = filePath.endsWith("__init__.py") || filePath.endsWith("__init__");
if (isInit) {
  for (const imp of imports) {
    imp.isExport = true;
  }
}
```

Il resolver puo' usare `isExport` come segnale per seguire il re-export anche senza depth recursion: se il target file ha un import marcato `isExport: true` per il nome cercato, segue la catena.

---

## File da modificare

### Resolver (`src/extract/import-resolver.ts`)

| Modifica | Descrizione |
|----------|-------------|
| Wildcard expansion | Quando `isWildcard && targetFile`, espandere con `exports` o `symbols[].name` del target |
| Re-export chasing | Aggiungere `chaseReExport()` per seguire import nel target file (depth=1, cycle detection) |
| Usare `isExport` | Quando un nome non si trova nei simboli del target, controllare se il target ha un import `isExport: true` per quel nome |
| Rimuovere `symbolToFile` | Dead code (L52-59) — costruita ma mai usata |

### Tipi (`src/extract/types.ts`)

| Modifica | Descrizione |
|----------|-------------|
| `FileExtraction.exports?` | Aggiungere campo opzionale `exports?: string[]` |

### Python extractor (`src/extract/languages/python.ts`)

| Modifica | Descrizione |
|----------|-------------|
| `computeExports()` | Calcolare exported names: `__all__` se presente, altrimenti simboli non-`_` |
| `extractDunderAll()` | Parsare `__all__ = [...]` dal AST |
| `__init__.py` detection | Marcare tutti gli import come `isExport: true` in `__init__.py` |

### Graph builder (`src/extract/graph-builder.ts`)

| Modifica | Descrizione |
|----------|-------------|
| Rimuovere `simpleNameToIds` | Dopo che il resolver gestisce wildcard e re-export, il fallback euristico non serve piu' |
| Caso 1 (attribute call) | Sostituire con graph-child lookup deterministico (indipendente dal resolver fix) |

### Markdown / Diagrams extractors

Nessuna modifica richiesta per il resolver. Questi extractors non hanno import significativi.

---

## Ordine di implementazione

```
1. Aggiungere `exports?: string[]` a FileExtraction           (types.ts)
2. Implementare computeExports + extractDunderAll              (python.ts)
3. Marcare isExport in __init__.py                             (python.ts)
4. Implementare wildcard expansion                             (import-resolver.ts)
5. Implementare chaseReExport con depth limit + cycle detect   (import-resolver.ts)
6. Rimuovere symbolToFile dead code                            (import-resolver.ts)
7. Test: wildcard, re-export, __init__.py, cycle detection
8. Rimuovere simpleNameToIds da graph-builder.ts               (dipende da step 1-7)
```

Step 1-7 sono indipendenti da BUG-005 (makeNodeId). Step 8 dipende sia dal resolver fix che dal BUG-005.

---

## Test plan

### Unit test: wildcard expansion

```
Scenario: from utils import *
Setup:
  - utils.py definisce validate_input, sanitize_output, _private_helper
  - api.py ha: from utils import *
Expected:
  - resolvedNames contiene validate_input e sanitize_output
  - _private_helper NON incluso (prefix _)
  - Edge imports_from creati per entrambi
```

### Unit test: wildcard con `__all__`

```
Scenario: from utils import * (con __all__)
Setup:
  - utils.py definisce validate_input, sanitize_output, helper
  - utils.py ha __all__ = ["validate_input", "sanitize_output"]
  - api.py ha: from utils import *
Expected:
  - resolvedNames contiene SOLO validate_input e sanitize_output
  - helper NON incluso (non in __all__)
```

### Unit test: re-export via __init__.py

```
Scenario: from package import validate_input
Setup:
  - package/__init__.py ha: from .validators import validate_input
  - package/validators.py definisce validate_input
  - api.py ha: from package import validate_input
Expected:
  - resolvedNames contiene validate_input
  - targetSymbol punta al qualifiedName di validate_input in validators.py
  - Edge imports_from creato verso il simbolo corretto
```

### Unit test: cycle detection

```
Scenario: re-export circolare
Setup:
  - a.py ha: from b import foo
  - b.py ha: from a import foo
Expected:
  - Nessun loop infinito
  - foo non risolto (cycle detected)
```

### Unit test: __init__.py isExport marking

```
Scenario: __init__.py con import
Setup:
  - package/__init__.py ha: from .sub import helper
Expected:
  - L'import ha isExport === true
```

### Unit test: depth limit

```
Scenario: catena di re-export a 3 livelli
Setup:
  - a/__init__.py re-esporta da b/__init__.py
  - b/__init__.py re-esporta da c.py
  - c.py definisce il simbolo
Expected:
  - Con depth=1: non risolto (troppo profondo)
  - Con depth=2: risolto
  - Verificare che il default depth e' sufficiente per casi reali
```

### E2E test: graph completo con wildcard

```
Scenario: build con wildcard imports
Setup:
  - Progetto Python con from utils import *
  - utils definisce funzioni usate nel codice
Expected:
  - graph.json contiene edge calls/imports_from per i simboli wildcard
  - graph_impact su quei simboli mostra il blast radius completo
  - graph_path trova percorsi attraverso le dipendenze wildcard
```

### E2E test: rimozione simpleNameToIds

```
Scenario: stesso progetto, confronto prima/dopo
Expected:
  - Stesso numero di edge (o piu', grazie ai wildcard espansi)
  - Nessun edge speculativo (tutti deterministic)
  - Tutti i tool MCP restituiscono risultati corretti
```

---

## Note

- Il depth limit per re-export chasing va calibrato sui casi reali. `depth=1` copre il caso tipico (`__init__.py` → `submodule.py`). `depth=2` copre catene piu' lunghe ma e' raramente necessario.
- La cycle detection via `visited: Set<string>` e' essenziale — senza, catene circolari causerebbero stack overflow.
- `exports` e' opzionale su `FileExtraction` per backward compatibility con extractor esistenti. Se assente, il resolver usa tutti i simboli.
- Per futuri linguaggi (TS/JS, Go, etc.), l'extractor implementa `exports` secondo le semantiche del linguaggio. Il resolver resta invariato.
