# Resoconto: Pipeline Redesign

## Obiettivo

Redesign completo della build pipeline di RepoNova: da un orchestratore monolitico con passaggio di oggetti in memoria a un sistema di fasi atomiche indipendenti, orchestrate da un DAG executor generico, con comunicazione esclusivamente via filesystem.

## Cosa è stato fatto

### 1. Pipeline Engine (`src/pipeline/engine/`)

Creato un motore di pipeline generico che non conosce le fasi specifiche:

- **`phase.ts`** — Interfacce `Phase`, `PhaseContext`, `PhaseResult`. Ogni fase è atomica, dichiara le proprie dipendenze, e decide internamente se eseguirsi o saltare.
- **`registry.ts`** — `PhaseRegistry` per la registrazione delle fasi. `createDefaultRegistry()` registra tutte le 10 fasi standard.
- **`dag.ts`** — Costruzione, validazione (dipendenze mancanti, cicli), ordinamento topologico a livelli, risoluzione transitiva delle dipendenze, pruning per `--target`.
- **`orchestrator.ts`** — Esecuzione level-by-level con parallelismo massimo. L'orchestratore è "stupido": non sa quali fasi esistono, le scopre dal registry.

### 2. Le 10 fasi (`src/pipeline/phases/`)

| Fase | ID | Dipende da | Output |
|------|----|------------|--------|
| File Detection | `file-detection` | — | `detected-files.json` |
| Graph Building | `graph` | `file-detection` | `graph-nodes.json` |
| Outlines | `outlines` | `file-detection` | `outlines/*.outline.json` |
| Communities | `communities` | `graph` | `graph.json` |
| Community Summaries | `community-summaries` | `communities` | `community_summaries.json` |
| Node Descriptions | `node-descriptions` | `communities` | `node_descriptions.json` |
| Search Index | `index` | `communities` | `graph_search.db` |
| Embeddings | `embeddings` | `communities`, `community-summaries`, `node-descriptions` | `vectors/` |
| HTML | `html` | `communities` | `graph.html`, `graph_communities.html` |
| Report | `report` | `communities` | `report.md` |

Ogni fase:
- Legge i propri input dal filesystem (nessun passaggio di oggetti in memoria)
- Ha la propria logica di skip incrementale (SHA-256 per-file, config-hash, mtime)
- Scrive il proprio output atomicamente
- Due fasi non scrivono mai lo stesso file

### 3. Config appiattita (`src/shared/types.ts`, `src/core/config.ts`)

- Rimosso il wrapper `build:` dalla config — tutte le proprietà sono al primo livello
- `config.embeddings`, `config.community_summaries`, `config.node_descriptions` (non più `config.build.embeddings`)
- Schema Zod riscritto con supporto per migrazione automatica dei config legacy (se YAML ha `build:`, i figli vengono promossi al root)
- `BuildConfigFingerprint` semplificata: contiene solo ciò che serve al runtime MCP (embeddings config, flag enabled per outlines/summaries/descriptions)
- Rimossa `OutlineConfig.patterns`, `OutlineConfig.exclude`, `OutlineConfig.exclude_common` — la fase outlines usa `detected-files.json` dal file-detection

### 4. Intelligence files spostati (`src/intelligence/`)

Tutti i 7 file da `src/build/intelligence/` spostati in `src/intelligence/` con import aggiornati:
- `embeddings.ts`, `tfidf-embeddings.ts`, `community-summary-generator.ts`, `node-description-generator.ts`, `llm-engine.ts`, `llm-engine-pool.ts`, `tokenizer-loader.ts`

### 5. Incremental logic preservata (`src/extract/incremental.ts`)

- Copiata da `src/build/incremental/incremental.ts` con import corretti
- Funzioni: `computeHashes`, `loadBuildCache`, `diffFiles`, `saveBuildCache`, `cleanStaleCacheEntries`, `hashFile`, `loadCachedExtraction`
- Usata dalla fase `graph` per estrazione incrementale

### 6. Utility nuove

- **`src/core/graph-graphology.ts`** — `loadGraphAsGraphology()` carica `graph-nodes.json` in un grafo graphology. Usata dalla fase `communities`.
- **`src/extract/export-json.ts`** — Aggiornata: non prende più `CommunityResult` come parametro, scrive `build_config` nel metadata di `graph.json`

### 7. CLI aggiornata (`src/cli/`)

- `build.ts` — Importa `runBuild` da `../pipeline/build.js`, aggiunto `--target`
- `index.ts` — Rimossi comandi `outline` e `index` (ora sono fasi della pipeline)
- `models.ts` — Import corretti, config flat
- Eliminati `outline.ts`, `cmd-index.ts` (dead code)

### 8. Entry point (`src/index.ts`)

Export aggiornati per puntare a `src/intelligence/` e `src/pipeline/build.js`.

### 9. MCP e runtime

- `src/mcp/tools/similar.ts` — Import corretti
- `src/core/context-builder.ts` — Import corretti
- `src/core/build-config-metadata.ts` — Legge `BuildConfigFingerprint` dal nuovo formato in `graph.json`
- `src/mcp/server.ts` — Funziona con la nuova fingerprint

## Cosa è stato eliminato

- **`src/build/`** — Intera directory eliminata (orchestratore vecchio, steps, manifest, incremental, types, config-diff)
- **`src/cli/outline.ts`** — Comando standalone `outline` (ora è una fase)
- **`src/cli/cmd-index.ts`** — Comando standalone `index` (ora è una fase)
- **11 test file** che testavano codice eliminato:
  - `orchestrator-early-return.test.ts`
  - `orchestrator-interrupted-build.test.ts`
  - `orchestrator-selective-subsystems.test.ts`
  - `build-pipeline-e2e.test.ts`
  - `manifest.test.ts`
  - `graph-hash.test.ts`
  - `config-diff.test.ts`
  - `incremental-community-summaries.test.ts`
  - `incremental-embeddings.test.ts`
  - `incremental-node-descriptions.test.ts`
  - `outline-incremental.test.ts`

## Test

### Risultato finale

- **23 file di test**
- **325 test**
- **Tutti passano**
- **Build `tsc` pulita (zero errori)**
- **Build `tsup` funzionante (lib + CLI)**

### Test nuovi aggiunti

- **`tests/pipeline-engine.test.ts`** (17 test) — Unit test per il motore della pipeline:
  - PhaseRegistry: register, get, getAll, has, duplicate ID
  - DAG: buildDAG, validate, topologicalLevels, resolveTransitiveDeps, pruneDAG
  - Orchestrator: full run, target pruning, skip behavior, error handling, concurrency

- **`tests/pipeline-build-e2e.test.ts`** (6 test) — E2E test con directory temporanee:
  - Build completa da file Python
  - `--target` limita l'esecuzione
  - `--force` ignora la cache
  - Build incrementale
  - Repo vuoto produce grafo vuoto
  - Config con wrapper legacy `build:` viene migrata

### Test esistenti aggiornati

- `config.test.ts` — `config.build.X` → `config.X`
- `build-config-fingerprint.test.ts` — Nuova shape fingerprint, rimosso parametro `communities` da `exportJson`
- `intelligence.test.ts` — Import path `src/build/intelligence/` → `src/intelligence/`
- `glob-integration.test.ts` — Import path, rimossi test per `loadPreviousBuildConfig` (eliminato)
- `incremental-docs.test.ts` — Import path `src/build/incremental/` → `src/extract/incremental.js`
- `force-cache-save.test.ts` — Import path

## Decisioni architetturali chiave

1. **Nessuna retrocompatibilità** — Config, API, e struttura interna riscritta da zero
2. **Filesystem-only communication** — Le fasi non si passano oggetti in memoria
3. **`detected-files.json` condiviso** — File detection centralizzata, usata da `graph` e `outlines`
4. **`graph-nodes.json` vs `graph.json`** — Due file, due fasi: il primo senza comunità, il secondo con
5. **Per-phase config hash** — Ogni fase gestisce la propria invalidazione config con `*-config-hash.txt`
6. **LlmEnginePool per fase** — Ogni fase LLM crea e dispone il proprio pool
7. **`exportJson` scrive `build_config` nel metadata** — Fingerprint minimale per il runtime MCP
