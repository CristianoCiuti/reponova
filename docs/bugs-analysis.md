# Bug Analysis — Post-Refactor Status & Required Changes

**Data**: 2025-05-08
**Branch**: `refactor` (commit `e900654`)
**Fonte**: `.history/bug-analysis-comprehensive.md` (11 bugs from branch `develop`)
**Scopo**: Analisi dello stato di ogni bug dopo il refactor completo della pipeline (10 fasi, DAG engine, flat config) e piano di fix per i bug ancora validi.

---

## Indice

| ID | Severita | Stato Post-Refactor | Azione Richiesta |
|----|----------|---------------------|------------------|
| BUG-001 | ALTA | OBSOLETO | Nessuna |
| BUG-002 | MEDIA | OBSOLETO | Nessuna |
| BUG-003 | MEDIA | OBSOLETO | Nessuna |
| BUG-004 | BASSA | OBSOLETO | Nessuna |
| BUG-005 | ALTA | **VALIDO** | Eliminare `makeNodeId`, nodeId = qualifiedName, fix resolver |
| BUG-006 | MEDIA | **VALIDO** | Fix `multi:false` → `multi:true` |
| BUG-007 | BASSA | **VALIDO** | Aprire `FileNodeKind` a `string` |
| BUG-008 | BASSA | **VALIDO** | Aprire `SymbolKind` a `string` |
| BUG-009 | BASSA | **VALIDO** | Rimuovere edge type `"method"` |
| BUG-010 | TRIVIALE | **VALIDO** | Rimuovere dead code `contains_section` |
| BUG-011 | TRIVIALE | **VALIDO** | Aggiornare commento stale |
| NEW-001 | MEDIA | **NUOVO** | Normalizzare casing edge types |

---

## Bug Obsoleti (BUG-001 — BUG-004)

### BUG-001: `graph_ask` non implementato — OBSOLETO

**Motivazione**: Il tool `graph_ask` era previsto dal design spec originale ma mai implementato. Il refactor ha confermato l'architettura a 11 tool. Non e' un bug: e' una feature non implementata che non rientra nello scope attuale.

**Azione**: Nessuna. Il test suite v2 rimuove i test per `graph_ask`.

### BUG-002: `node_descriptions.threshold` change non rilevato — OBSOLETO

**Motivazione**: Il vecchio sistema `config-diff.ts` + `node-descriptions-step.ts` e' stato completamente sostituito dal nuovo pipeline a 10 fasi con DAG engine. Ogni fase ha il proprio `*-config-hash.txt` in `.cache/` per invalidazione config. Il bug non esiste piu' nel nuovo codice.

**Azione**: Nessuna. La nuova pipeline gestisce correttamente l'invalidazione config per-fase.

### BUG-003: Early return assente — build no-op ~13s — OBSOLETO

**Motivazione**: Il vecchio orchestrator monolitico (`src/build/orchestrator.ts`) e' stato eliminato. La nuova pipeline con DAG engine supporta skip per-fase basato su hash, e il build no-op e' gestito nativamente dall'engine.

**Azione**: Nessuna. La nuova architettura risolve il problema by design.

### BUG-004: `context_size` incluso in fingerprint — OBSOLETO

**Motivazione**: Il vecchio `BuildConfigFingerprint` monolitico e' stato sostituito da fingerprint per-fase. `context_size` e' un parametro runtime e non viene incluso nei config hash delle fasi di build.

**Azione**: Nessuna.

---

## Bug Validi — Analisi Dettagliata e Fix

### BUG-005: Node ID collision — soluzione definitiva (REVISED)

**Stato**: VALIDO — design rivisto dopo review approfondita.

**Severita'**: ALTA (upstream di tutti i fix)

**Root cause**: `makeNodeId()` (L43-46) introduce 3 livelli di collisione: case folding (`.toLowerCase()`), regex normalization (`[^a-zA-Z0-9]+ → _`), uso di `symbol.name` invece di `symbol.qualifiedName`. Il secondo nodo con ID collidente viene silenziosamente ignorato (`if (!graph.hasNode(nodeId))` → skip).

#### Design decision: eliminare `makeNodeId`

`makeNodeId()` e' superfluo. Se `qualifiedName` e' globalmente unico per contratto, il nodeId E' il qualifiedName. Per i file nodes, il nodeId E' il filePath. Nessun wrapper, nessuna funzione helper.

```typescript
// ELIMINARE makeNodeId(). Tutto il codice diventa:
const moduleId = filePath;                // file nodes
const nodeId = symbol.qualifiedName;      // symbol nodes
```

#### Contratto normalizzato `qualifiedName`

Aggiunta al tipo `SymbolNode` (JSDoc in `types.ts:66`):

1. `qualifiedName` e' **required** su ogni `SymbolNode` (gia' nel tipo)
2. Deve essere **globalmente unico** — include namespace derivato dal path del file
3. Formato: **dot-separated**, senza estensione file: `moduleName.parentInfo.symbolName`
4. Ogni extractor deriva `moduleName` dal filePath: strip estensione, `/` → `.`
5. `qualifiedName` **NON** deve contenere il filePath letterale (con slashes e estensione)

| Extractor | filePath | qualifiedName | nodeId |
|-----------|----------|---------------|--------|
| Python | `src/utils/helpers.py` | `src.utils.helpers.UserService.get_user` | `src.utils.helpers.UserService.get_user` |
| Diagrams | `diagrams/arch.puml` | `diagrams.arch.UserService` | `diagrams.arch.UserService` |
| Markdown | `docs/README.md` | `docs.README.Installation` | `docs.README.Installation` |
| File node | `src/utils/helpers.py` | — | `src/utils/helpers.py` |

Python gia' segue questa convenzione (`filePathToModuleName()`). Diagrams e Markdown usano `${filePath}/${name}` — da allineare.

#### Markdown: disambiguazione sezioni duplicate

Un markdown puo' avere sezioni omonime (`## Example` ripetuto). Fix: contatore per nome nell'extractor.

- Prima occorrenza: `docs.README.Example`
- Seconda: `docs.README.Example_2`
- Terza: `docs.README.Example_3`

Stabile: cambia solo se si riordinano sezioni omonime. Aggiungere righe/contenuto non impatta.

#### Mappe eliminate

| Mappa | Stato |
|-------|-------|
| `makeNodeId()` | **Eliminata** — nodeId = qualifiedName / filePath |
| `qualifiedToId` | **Eliminata** — era `Map<qualifiedName, nodeId>`, ma ora key === value |

#### `simpleNameToIds` — analisi e rimozione

`simpleNameToIds` (`Map<simpleName, nodeId[]>`) e' un fallback euristico usato in 3 punti di `resolveCall` e nella risoluzione ereditarieta'.

**Caso 1 — Attribute call `obj.method()` cross-file** (L328):
Prende `candidates[0]` arbitrario → **ROTTO**. Se esistono `UserService.get_user` e `OrderService.get_user`, prende uno a caso.
**Fix**: lookup deterministico nei figli del nodo importato:

```typescript
if (importedTarget && graph.hasNode(importedTarget)) {
  let methodId: string | null = null;
  graph.forEachOutEdge(importedTarget, (_edge, attrs, _src, target) => {
    if (attrs.relation === "contains" && graph.getNodeAttribute(target, "label") === simpleName) {
      methodId = target;
    }
  });
  if (methodId) return methodId;
}
```

**Casi 2+3 — Global unique** (L349, L263):
Solo se esiste UN SOLO simbolo con quel nome nel codebase. Compensa gap reali del resolver:
- Wildcard imports (`from module import *`) — il resolver non espande i nomi
- Re-export transitivi (`__init__.py` che re-esporta da submoduli) — il resolver non li segue

Senza questi edge, **6 tool MCP su 11 perdono informazione** a runtime:

| Tool | Traversal | Impatto |
|------|-----------|---------|
| `graph_impact` | BFS, tutti gli edge, nessun filtro tipo | Blast radius incompleto |
| `graph_path` | Dijkstra, filtro edge_types | Percorsi non trovati |
| `graph_search` | BFS/DFS context expansion | Contesto mancante |
| `graph_context` | 1-hop + centrality scoring | Scoring e relazioni |
| `graph_explain` | Incoming/outgoing grouped by type | Edge mancanti nel dettaglio |
| `graph_docs` | Edge da doc nodes a code nodes | Linked code incompleto |

Indirettamente: `graph_hotspots` e `graph_community` usano degree/betweenness che cambiano.

**Decisione**: rimuovere `simpleNameToIds` interamente, MA prima fixare il resolver per gestire wildcard e re-export. Vedi `docs/resolver-analysis.md`.

#### Ordine di implementazione

1. Eliminare `makeNodeId`, nodeId = qualifiedName / filePath
2. Normalizzare qualifiedName in `diagrams.ts` e `markdown.ts` (dot-separated)
3. Fix markdown collisioni (contatore per nome)
4. Eliminare `qualifiedToId` map
5. Sostituire caso 1 `simpleNameToIds` con graph-child lookup
6. **Dopo fix resolver** (`docs/resolver-analysis.md`): rimuovere `simpleNameToIds` e casi 2+3

#### File da modificare

| File | Modifica |
|------|----------|
| `src/extract/graph-builder.ts:43-46` | Eliminare `makeNodeId` |
| `src/extract/graph-builder.ts:62` | `moduleId = filePath` diretto |
| `src/extract/graph-builder.ts:84-104` | Eliminare `qualifiedToId`; ristrutturare `simpleNameToIds` |
| `src/extract/graph-builder.ts:94` | `nodeId = symbol.qualifiedName` |
| `src/extract/graph-builder.ts:124-125` | Parent: `extraction.symbols.find(s => s.name === parent)?.qualifiedName` |
| `src/extract/graph-builder.ts:155,166,176` | `sourceModuleId = filePath` diretto, `targetModuleId = filePath` diretto |
| `src/extract/graph-builder.ts:214` | `callerId = symbol.qualifiedName` |
| `src/extract/graph-builder.ts:244` | `classId = symbol.qualifiedName` |
| `src/extract/graph-builder.ts:328` | Caso 1 → graph-child lookup deterministico |
| `src/extract/types.ts:66` | JSDoc: documentare contratto qualifiedName |
| `src/extract/languages/markdown.ts:113-117` | qualifiedName dot-separated + contatore duplicati |
| `src/extract/languages/diagrams.ts:71,134` | qualifiedName dot-separated |

**Breaking**: SI — tutti i node ID cambiano. Accettabile.

**Dipendenza**: Rimozione completa di `simpleNameToIds` richiede fix del resolver (`docs/resolver-analysis.md`).

**Test richiesti**:
- Unit: due metodi omonimi in classi diverse (`Foo.bar` e `Baz.bar`) → ID distinti
- Unit: simboli che differiscono solo per case (`User` vs `user`) → ID distinti
- Unit: module node ID = filePath esatto (nessuna normalizzazione)
- Unit: parent resolution trova il parent corretto senza `qualifiedToId`
- Unit: attribute call `obj.method()` risolve via graph-child lookup
- Unit: markdown sezioni duplicate → qualifiedName disambiguato con contatore
- E2E: graph.json contiene tutti i nodi senza collisioni
- E2E: import resolution e call edges funzionano con i nuovi ID

---

### BUG-006: Edge loss su grafo `multi:false`

**Stato**: VALIDO — confermato nel codice attuale.

**File**: `src/extract/graph-builder.ts:53`, `src/core/graph-graphology.ts:18`

**Codice attuale**:
```typescript
// graph-builder.ts:53
const graph = new Graph({ type: "directed", multi: false, allowSelfLoops: false });

// graph-graphology.ts:18
const graph = new Graph({ type: "directed", multi: false, allowSelfLoops: false });
```

**Problema**: Con `multi: false`, graphology permette UNA sola edge tra ogni coppia (source, target). `addEdgeSafe()` (L368-393) controlla l'edge esistente e:
- Se stesso tipo → return (corretto)
- Se tipo diverso → tenta `graph.addEdge()` che fallisce silenziosamente nel catch → **edge perso**

**Scenario concreto**: Modulo A importa E chiama funzione `f` da modulo B:
- Prima edge: `A → f` con tipo `imports_from`
- Seconda edge: `A → f` con tipo `calls`
- La seconda e' PERSA.

**Nota critica**: Il DB schema (`src/core/db.ts`) supporta gia' multi-type edges con PRIMARY KEY `(source_id, target_id, type)`. La perdita avviene solo nel layer graphology in-memory.

**Edge types nel codebase**:
- Estrattore: `calls`, `imports`, `imports_from`, `extends`, `contains`, `method`
- `shortest-path.ts:18`: default `["CALLS", "IMPORTS", "EXTENDS", "MEMBER_OF"]` (UPPERCASE!)
- `export-html.ts:196-199`: color mapping per tutti i tipi

**Analisi impatto `multi:true` — nessun problema riscontrato**:

Verifica completa di tutti i consumer downstream. Con `multi:true`, `forEachEdge` itera ogni edge parallelo separatamente. Ogni consumer gestisce questo correttamente:

| Consumer | File | Comportamento con multi:true | Problema? |
|----------|------|------------------------------|-----------|
| **Community detection** | `community.ts:37-44` | `forEachEdge` itera parallel edges, ma `hasEdge` check nel grafo undirected previene duplicati. Solo UNA edge per coppia nel grafo undirected per Louvain. | NO |
| **Export JSON** | `export-json.ts:87-96` | `forEachEdge` serializza ogni edge separatamente → JSON contiene edges multiple tra stessa coppia. E' il comportamento desiderato. | NO |
| **Export HTML** | `export-html.ts:83,165` | `forEachEdge` produce vis edges separate. vis.js gestisce parallel edges con curve smooth. `graph.degree(nodeId)` conta ogni edge → degree leggermente piu' alto. | NO (display preference) |
| **DB population** | `db.ts:144-155` | `INSERT OR REPLACE` con PK `(source_id, target_id, type)`. Edges con tipo diverso → righe distinte. Funziona perfettamente. | NO |
| **Graph loader** | `graph-graphology.ts:37-49` | Con `multi:true`, `addEdge` non lancia eccezioni per parallel edges. Ogni edge dal JSON viene caricata. | NO |
| **Shortest path** | `shortest-path.ts` | Query edges dalla DB con `type IN (...)`. Trova edges che prima erano perse. E' un MIGLIORAMENTO. | NO |
| **Impact analysis** | `core/impact.ts` | Query edges dalla DB. Piu' edges = analisi piu' completa. | NO |
| **Degree calculations** | `db.ts:104-109` | In/out degree contano ogni edge separatamente. In un multi-grafo, grado = numero totale di edges, che e' semanticamente corretto (se A importa E chiama B, sono 2 relazioni). | NO |

**Conclusione**: `multi:true` NON causa problemi. Tutti i consumer gia' gestiscono parallel edges correttamente, o collassano a single-edge dove necessario (community detection).

**Fix richiesto**:

Cambiare `multi: false` → `multi: true` in entrambe le locazioni:

```typescript
// graph-builder.ts:53
const graph = new Graph({ type: "directed", multi: true, allowSelfLoops: false });

// graph-graphology.ts:18
const graph = new Graph({ type: "directed", multi: true, allowSelfLoops: false });
```

Aggiornare `addEdgeSafe()` per sfruttare multi-edge:

```typescript
function addEdgeSafe(graph: Graph, source: string, target: string, edgeType: string): void {
  if (!graph.hasNode(source) || !graph.hasNode(target)) return;
  if (source === target) return;

  // With multi:true, check if this exact relation already exists
  let duplicateFound = false;
  graph.forEachEdge(source, target, (_edge, attrs) => {
    if (attrs.relation === edgeType) duplicateFound = true;
  });
  if (duplicateFound) return;

  graph.addEdge(source, target, {
    relation: edgeType,
    confidence: "EXTRACTED",
    confidence_score: 1.0,
    weight: 1,
  });
}
```

**File da modificare**:
| File | Modifica |
|------|----------|
| `src/extract/graph-builder.ts:53` | `multi: false` → `multi: true` |
| `src/extract/graph-builder.ts:368-393` | Riscrivere `addEdgeSafe()` per multi-graph |
| `src/core/graph-graphology.ts:18` | `multi: false` → `multi: true` |

**File che NON richiedono modifiche** (verificato):
| File | Motivo |
|------|--------|
| `src/extract/export-json.ts` | `forEachEdge` gia' serializza ogni edge separatamente |
| `src/extract/export-html.ts` | `forEachEdge` gia' gestisce parallel edges, vis.js supporta |
| `src/extract/community.ts` | `hasEdge` check nel grafo undirected previene duplicati |
| `src/core/db.ts` | PK `(source_id, target_id, type)` gia' supporta multi-type |

**Breaking**: SI — graph.json avra' piu' edges. Accettabile.

**Test richiesti**:
- Unit test: stessa coppia (source, target) con due tipi diversi (`imports_from` + `calls`) → entrambi presenti nel grafo
- Unit test: `addEdgeSafe` con stesso tipo due volte → nessun duplicato
- E2E: build → graph.json contiene edges multipli tra stessa coppia
- E2E: DB edges table contiene righe distinte per tipo

---

### BUG-007: `FileNodeKind` union chiusa

**Stato**: VALIDO — confermato nel codice attuale.

**File**: `src/extract/types.ts:31`

**Codice attuale**:
```typescript
export type FileNodeKind = "module" | "document" | "diagram";
```

**Problema**: Future linguaggi non possono usare `"config"`, `"schema"`, `"test"` senza modificare `types.ts`.

**Fix richiesto**:
```typescript
/** Convention: "module" | "document" | "diagram" | ... any extractor-defined value */
export type FileNodeKind = string;
```

**File da modificare**:
| File | Modifica |
|------|----------|
| `src/extract/types.ts:31` | Aprire a `string` |

**Breaking**: NO — additive, existing code continua a funzionare.

---

### BUG-008: `SymbolKind` union chiusa

**Stato**: VALIDO — confermato nel codice attuale.

**File**: `src/extract/types.ts:87-99`

**Codice attuale**:
```typescript
export type SymbolKind =
  | "function" | "class" | "method" | "variable" | "constant"
  | "interface" | "enum" | "module" | "document" | "diagram"
  | "section" | "component";
```

**Problema**: Future linguaggi non possono emettere `"endpoint"`, `"route"`, `"service"`, `"table"`.

**Fix richiesto**:
```typescript
/** Convention: "function" | "class" | "method" | ... any extractor-defined value */
export type SymbolKind = string;
```

**File da modificare**:
| File | Modifica |
|------|----------|
| `src/extract/types.ts:87-99` | Aprire a `string` |

**Breaking**: NO — additive. Rischio medio: `switch` su kind potrebbe non gestire valori nuovi, ma tutti i `switch` nel codebase hanno `default` case.

---

### BUG-009: Edge type `"method"` — classification logic in assembler

**Stato**: VALIDO — confermato nel codice attuale.

**File**: `src/extract/graph-builder.ts:130-131`

**Codice attuale**:
```typescript
// Parent is a class or other container → use "method" for methods, "contains" otherwise
const edgeType = symbol.kind === "method" ? "method" : "contains";
addEdgeSafe(graph, parentId, nodeId, edgeType);
```

**Problema**: Il design principle dichiarato nel header del file e': "The assembler makes ZERO classification decisions." Ma questa riga ispeziona `symbol.kind` per decidere il tipo di edge — questa E' classification logic.

**Analisi downstream**:
- `export-html.ts:199` — `getEdgeColor()` gia' raggruppa `"method"` con `"contains"` nella stessa classe di colore (`#95a5a6`)
- `intelligence/embeddings.ts` — usa `node.type === "method"` (tipo nodo, NON tipo edge) — non impattato
- `README.md:356` — documenta `method` come edge type separato
- Nessun codice nel codebase fa `edge.type === "method"` per filtrare — la distinzione non serve a nessun consumer

**Fix richiesto**:

```typescript
// Parent is a class or other container
addEdgeSafe(graph, parentId, nodeId, "contains");
```

**File da modificare**:
| File | Modifica |
|------|----------|
| `src/extract/graph-builder.ts:131` | `const edgeType = symbol.kind === "method" ? "method" : "contains";` → rimuovere, usare sempre `"contains"` |
| `src/extract/graph-builder.ts:12` | Rimuovere `method` dalla lista edge types nel header comment |
| `src/extract/export-html.ts:199` | Rimuovere `case "method":` dal switch (opzionale, harmless) |
| `README.md` | Rimuovere riga `method` dalla tabella Edge Types |

**Breaking**: SI — edge type `"method"` scompare da graph.json. Accettabile.

---

### BUG-010: Dead code `contains_section` in export-html.ts

**Stato**: VALIDO — confermato nel codice attuale.

**File**: `src/extract/export-html.ts:199`

**Codice attuale**:
```typescript
case "contains": case "method": case "contains_section": return "#95a5a6";
```

**Problema**: Nessun codice nel codebase produce edges con relation `"contains_section"`. Il case e' unreachable/dead code.

**Fix richiesto**:

Rimuovere `case "contains_section":` dal switch.

Dopo fix BUG-009 (rimozione `"method"`), la riga diventa:
```typescript
case "contains": return "#95a5a6";
```

**File da modificare**:
| File | Modifica |
|------|----------|
| `src/extract/export-html.ts:199` | Rimuovere `case "contains_section":` (e `case "method":` se BUG-009 applicato) |
| `README.md:356` | Rimuovere riga `contains_section` dalla tabella Edge Types |

---

### BUG-011: Commento stale in diagrams.ts

**Stato**: VALIDO — confermato nel codice attuale.

**File**: `src/extract/languages/diagrams.ts:11`

**Codice attuale**:
```
* These produce "document"-type nodes in the graph with file_type "diagram".
```

**Realta'**: Il codice produce nodi con `kind: "diagram"` (L48, L108, L155).

**Fix richiesto**:
```
* These produce "diagram"-type file nodes in the graph (fileNode.kind === "diagram").
```

**File da modificare**:
| File | Modifica |
|------|----------|
| `src/extract/languages/diagrams.ts:11` | Aggiornare commento |

---

### NEW-001: Edge type casing inconsistency

**Stato**: NUOVO — scoperto durante l'analisi.

**File**: `src/core/shortest-path.ts:18`

**Problema**: L'estrattore produce edge types in lowercase:
```
calls, imports, imports_from, extends, contains, method
```

Ma `shortest-path.ts` usa default edge types in UPPERCASE:
```typescript
edge_types = ["CALLS", "IMPORTS", "EXTENDS", "MEMBER_OF"]
```

Inoltre, `"MEMBER_OF"` non corrisponde a nessun edge type prodotto dall'estrattore (`"contains"`, `"method"`).

**Impatto**: Se un utente non specifica `edge_types` esplicitamente, il path finding usa i default UPPERCASE che non matchano nessun edge nel grafo (edges sono lowercase). Il path finding potrebbe non trovare percorsi.

**Fix richiesto**:

Normalizzare i default a lowercase e correggere i nomi:
```typescript
edge_types = ["calls", "imports", "imports_from", "extends", "contains"]
```

**File da modificare**:
| File | Modifica |
|------|----------|
| `src/core/shortest-path.ts:18` | Normalizzare default edge_types a lowercase, correggere nomi |

**Nota**: Verificare se il matching e' case-insensitive da qualche altra parte. Se `shortest-path.ts` usa `edge.type` direttamente dalla DB, e la DB ha valori lowercase, allora i default UPPERCASE non matcheranno mai.

---

## Piano di Fix Ordinato

### Gruppo 1: Triviali (5 min totale)

| Bug | File | Modifica | Effort |
|-----|------|----------|--------|
| BUG-011 | `diagrams.ts:11` | Aggiornare commento | 1 min |
| BUG-010 | `export-html.ts:199` | Rimuovere dead code | 1 min |
| BUG-007 | `types.ts:31` | `FileNodeKind = string` | 1 min |
| BUG-008 | `types.ts:87-99` | `SymbolKind = string` | 1 min |

### Gruppo 2: Medio effort (30 min totale)

| Bug | File | Modifica | Effort |
|-----|------|----------|--------|
| BUG-005 | `graph-builder.ts:45` | Rimuovere `.toLowerCase()` | 5 min + test |
| BUG-009 | `graph-builder.ts:131` + 3 file | Unificare `"method"` → `"contains"` | 10 min |
| NEW-001 | `shortest-path.ts:18` | Normalizzare casing default | 5 min + verifica |

### Gruppo 3: Alto effort (1-2h)

| Bug | File | Modifica | Effort |
|-----|------|----------|--------|
| BUG-006 | `graph-builder.ts` + `graph-graphology.ts` + 3 file | `multi:true` + riscrivere `addEdgeSafe` | 1-2h + test |

---

## Dipendenze tra Fix

```
BUG-007, BUG-008 → indipendenti
BUG-011 → indipendente
BUG-010 → dipende da BUG-009 (rimuovere "method" prima, poi cleanup switch)
BUG-009 → indipendente
BUG-005 → dipende da resolver fix per rimozione completa di `simpleNameToIds` (vedi `docs/resolver-analysis.md`)
BUG-006 → indipendente (ma complementare a BUG-005)
NEW-001 → dipende da BUG-006 (normalizzare casing dopo aver stabilizzato edge types)
```

**Ordine consigliato**:
1. BUG-007, BUG-008 (indipendenti, triviali)
2. BUG-011 (indipendente, triviale)
3. BUG-009 (rimuove "method")
4. BUG-010 (cleanup switch dopo BUG-009)
5. BUG-005 (fix node ID)
6. BUG-006 (multi:true + addEdgeSafe)
7. NEW-001 (normalizza casing dopo stabilizzazione)
