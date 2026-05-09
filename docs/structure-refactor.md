# Ristrutturazione File — Analisi Critica e Piano

**Data**: 2025-05-09
**Branch**: `refactor`
**Scopo**: Riorganizzare `src/` in moduli atomici con responsabilità univoche e regole di layering esplicite.

---

## Indice

1. [Diagnosi](#diagnosi)
2. [Struttura proposta](#struttura-proposta)
3. [Regole di layering](#regole-di-layering)
4. [Tabella migrazione](#tabella-migrazione)
5. [Dead code eliminato](#dead-code-eliminato)
6. [Moduli invariati](#moduli-invariati)

---

## Diagnosi

### `src/extract/` — monolite con 7 responsabilità

| File | Responsabilità reale | Appartiene a `extract/`? |
|---|---|---|
| `parser.ts` | Tree-sitter WASM parsing | **NO** — usato anche da `outline/` |
| `graph-builder.ts` | Assembla il grafo DA estrazioni | **NO** — costruzione grafo, non estrazione |
| `community.ts` | Louvain community detection | **NO** — analisi grafo |
| `export-json.ts` | Serializza grafo → JSON | **NO** — output/serializzazione |
| `export-html.ts` | Serializza grafo → HTML | **NO** — output/serializzazione |
| `incremental.ts` | SHA256 caching per file | **NO** — ogni fase ha la sua incrementalità |
| `import-resolver.ts` | Risoluzione import | **SÌ** |
| `languages/*` | Estrattori per-linguaggio | **SÌ** |
| `types.ts` | Tipi di estrazione | **SÌ** |
| `index.ts` | Orchestratore mini-pipeline | **NO** — `runPipeline()` dead code (0 callers), file detection è infrastruttura |

### `src/core/` — nome vuoto, 3 layer mischiati

| File | Responsabilità reale | Problema |
|---|---|---|
| `config.ts` | Carica `reponova.yml` | Infrastruttura condivisa, non "core" |
| `path-resolver.ts` | Risoluzione path workspace | Infrastruttura condivisa |
| `graph-resolver.ts` | Auto-detect `reponova-out/` | Infrastruttura condivisa |
| `build-config-metadata.ts` | Fingerprint config da graph.json | Infrastruttura build |
| `graph-graphology.ts` | Wrapper graphology | Layer grafo |
| `graph-loader.ts` | Load graph.json | Layer grafo |
| `db.ts`, `search.ts`, `impact.ts`, `shortest-path.ts`, `node-detail.ts` | Query runtime | Layer query |
| `context-builder.ts` | Smart context assembly | Layer query, **importa da `intelligence/`** → violazione layering |
| `vector-store.ts` | Persistenza vettori | Layer query |

### Problemi specifici

1. **`extract/` = 7 responsabilità**: chi legge il path pensa "qui si estraggono file" ma ci trova community detection, serializzazione HTML, caching
2. **`core/` = sacco della spazzatura**: config, grafo, query tutto insieme, con violazione di layering (`core → intelligence`)
3. **`incremental.ts` in `extract/`**: suggerisce che solo l'estrazione sia incrementale. Falso — ogni fase ha la sua incrementalità:
   - Embeddings: `node-texts.json` + `embeddings-config-hash.txt`
   - Communities: `graph-nodes-hash.txt`
   - Community summaries: `community-summary-fingerprints.json` + config hash
   - Node descriptions: `node-description-fingerprints.json` + config hash
   - Outlines: `outline-hashes.json`
   - HTML/search-index: skip basato su mtime
4. **`parser.ts` in `extract/`**: ma `outline/` lo importa. È infrastruttura condivisa
5. **`runPipeline()` in `extract/index.ts`**: dead code, 0 callers. Le pipeline phases l'hanno sostituito
6. **File detection in `extract/index.ts`**: è scanning filesystem, non estrazione di simboli

---

## Struttura proposta

```
src/
├── shared/                         # L0 — Utilità a zero dipendenze
│   ├── types.ts                    # Config, interfacce condivise
│   ├── utils.ts                    # Logging
│   ├── glob.ts                     # Glob matching, skip dirs
│   ├── atomic-write.ts             # Scrittura atomica
│   ├── hash.ts                     # ← NEW: hashFile, computeHashes (da incremental.ts)
│   ├── config.ts                   # ← core/config.ts
│   ├── path-resolver.ts            # ← core/path-resolver.ts
│   └── graph-resolver.ts           # ← core/graph-resolver.ts
│
├── extract/                        # L1 — Parse file → FileExtraction (E BASTA)
│   ├── types.ts                    # FileExtraction, SymbolNode, ImportDeclaration
│   ├── parser.ts                   # tree-sitter WASM (usato anche da outline/)
│   ├── import-resolver.ts          # Risoluzione import cross-file
│   ├── index.ts                    # extractAll() + file detection — SOLO estrazione, no pipeline
│   └── languages/
│       ├── python.ts
│       ├── markdown.ts
│       ├── diagrams.ts
│       └── registry.ts
│
├── graph/                          # L2 — Costruzione + analisi + serializzazione grafo
│   ├── builder.ts                  # ← extract/graph-builder.ts
│   ├── community.ts                # ← extract/community.ts
│   ├── graphology.ts               # ← core/graph-graphology.ts
│   ├── loader.ts                   # ← core/graph-loader.ts
│   ├── export-json.ts              # ← extract/export-json.ts
│   └── export-html.ts              # ← extract/export-html.ts
│
├── query/                          # L2 — Runtime queries (MCP tools → qui)
│   ├── db.ts                       # ← core/db.ts
│   ├── search.ts                   # ← core/search.ts
│   ├── impact.ts                   # ← core/impact.ts
│   ├── shortest-path.ts            # ← core/shortest-path.ts
│   ├── node-detail.ts              # ← core/node-detail.ts
│   ├── context-builder.ts          # ← core/context-builder.ts
│   └── vector-store.ts             # ← core/vector-store.ts
│
├── intelligence/                   # L1 — AI/ML engines (INVARIATO)
│   └── (7 file, 0 dipendenze verso core/extract/pipeline)
│
├── outline/                        # L1 — Code outlines (INVARIATO)
│   └── (cache.ts, formatter.ts, index.ts, languages/)
│
├── pipeline/                       # L3 — Orchestrazione build + caching
│   ├── build.ts
│   ├── cache.ts                    # ← extract/incremental.ts (SENZA hashFile/computeHashes)
│   ├── build-config-metadata.ts    # ← core/build-config-metadata.ts
│   ├── engine/
│   │   ├── dag.ts
│   │   ├── orchestrator.ts
│   │   ├── phase.ts
│   │   └── registry.ts
│   └── phases/                     # 10 fasi (import paths cambiano)
│
├── mcp/                            # L4 — MCP server (INVARIATO)
│   └── (server.ts, resources.ts, tools/)
│
├── cli/                            # L4 — CLI commands (INVARIATO)
│   └── (6 file)
│
└── index.ts                        # Public API
```

---

## Regole di layering

```
L0  shared/           ← nessuna dipendenza interna
L1  extract/           ← shared/
L1  intelligence/      ← shared/
L1  outline/           ← shared/, extract/parser (tree-sitter condiviso)
L2  graph/             ← shared/, extract/types (per FileExtraction)
L2  query/             ← shared/, intelligence/ (per context-builder embeddings)
L3  pipeline/          ← TUTTO (orchestra L0–L2)
L4  mcp/               ← query/, graph/loader, shared/
L4  cli/               ← pipeline/, shared/
```

**Nessun import verso l'alto. Mai.**

---

## Tabella migrazione

| Da | A | Note |
|---|---|---|
| `extract/incremental.ts` | **split**: `shared/hash.ts` + `pipeline/cache.ts` | hashFile/computeHashes → shared; BuildCache/diffFiles/save/load → pipeline |
| `extract/graph-builder.ts` | `graph/builder.ts` | |
| `extract/community.ts` | `graph/community.ts` | |
| `extract/export-json.ts` | `graph/export-json.ts` | |
| `extract/export-html.ts` | `graph/export-html.ts` | |
| `core/graph-graphology.ts` | `graph/graphology.ts` | |
| `core/graph-loader.ts` | `graph/loader.ts` | |
| `core/db.ts` | `query/db.ts` | |
| `core/search.ts` | `query/search.ts` | |
| `core/impact.ts` | `query/impact.ts` | |
| `core/shortest-path.ts` | `query/shortest-path.ts` | |
| `core/node-detail.ts` | `query/node-detail.ts` | |
| `core/context-builder.ts` | `query/context-builder.ts` | |
| `core/vector-store.ts` | `query/vector-store.ts` | |
| `core/config.ts` | `shared/config.ts` | |
| `core/path-resolver.ts` | `shared/path-resolver.ts` | |
| `core/graph-resolver.ts` | `shared/graph-resolver.ts` | |
| `core/build-config-metadata.ts` | `pipeline/build-config-metadata.ts` | |

---

## Dead code eliminato

| Artefatto | Motivo |
|---|---|
| `extract/index.ts::runPipeline()` | 0 callers — superseded dalle pipeline phases |
| `extract/index.ts::PipelineOptions` | Tipo di runPipeline |
| `extract/index.ts::PipelineResult` | Tipo di runPipeline |
| `src/core/` (intera cartella) | Disciolta → file spostati in `shared/`, `graph/`, `query/`, `pipeline/` |

---

## Moduli invariati

| Modulo | Motivo |
|---|---|
| `intelligence/` | Già atomico, 0 dipendenze verso core/extract/pipeline |
| `outline/` | Già pulito (import da `extract/parser` accettabile come L1→L1 non-circolare) |
| `pipeline/engine/` | Già ben strutturato |
| `mcp/tools/` | Solo import paths cambiano |
| `cli/` | Solo import paths cambiano |
