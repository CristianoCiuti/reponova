# RepoNova Build Pipeline — Operation & Dependency Analysis

> Auto-generated analysis of the build pipeline data flow.
> Source of truth: `src/build/orchestrator.ts`, `src/extract/index.ts`, and all step files in `src/build/steps/`.

---

## 1. Complete Operation List

The build pipeline consists of **14 distinct operations** organized in two phases.

### Phase 1 — Extraction Pipeline (`src/extract/index.ts` → `runPipeline`)

These operations run **sequentially within `runPipeline`** and produce the in-memory graph.

| # | Operation | Code Location | Description |
|---|-----------|---------------|-------------|
| **O1** | File Detection | `extract/index.ts` — `detectFiles`, `detectDocFiles`, `detectDiagramFiles` | Walks workspace directories, matches glob patterns, detects code files, doc files, and diagram/image files separately |
| **O2** | File Hashing | `build/incremental/incremental.ts` — `computeHashes` | SHA-256 hash of every detected file's contents |
| **O3** | Incremental Diff | `build/incremental/incremental.ts` — `diffFiles` | Compares current hashes against previous build cache; splits files into changed/unchanged/removed; loads cached `FileExtraction` for unchanged files |
| **O4** | AST Extraction | `extract/index.ts` — `extractAll` + `extract/parser.ts` | Parses **changed files only** with tree-sitter WASM (or regex for markdown/diagrams); produces `FileExtraction[]` with symbols, imports, references |
| **O5** | Graph Building | `extract/graph-builder.ts` — `buildGraph` | Combines all `FileExtraction[]` (cached + fresh) into a graphology directed graph with nodes (symbols) and edges (calls, imports, extends, contains) |
| **O6** | Community Detection | `extract/community.ts` — `detectCommunities` | Runs Louvain algorithm on an undirected copy of the graph; assigns `community` attribute to each node |
| **O7** | JSON Export | `extract/export-json.ts` — `exportJson` | Serializes the in-memory graph + community assignments + build config fingerprint to `graph.json`; skips write if content unchanged |

### Phase 2 — Build Steps (`src/build/orchestrator.ts` → `executeStep`)

These operations run **sequentially in the orchestrator** after the extraction pipeline completes. Each step is autonomous (decides internally whether to execute or skip).

| # | Operation | Code Location | Description |
|---|-----------|---------------|-------------|
| **O8** | Embeddings | `build/steps/embeddings-step.ts` — `runEmbeddingsStep` | Generates vector embeddings for all graph nodes (TF-IDF or ONNX MiniLM). Incrementally re-embeds only nodes whose text content changed |
| **O9** | Community Summaries | `build/steps/community-summaries-step.ts` — `runCommunitySummariesStep` | Generates natural-language summaries for each community (algorithmic or LLM-enhanced). Incrementally re-generates only communities whose node composition changed |
| **O10** | Node Descriptions | `build/steps/node-descriptions-step.ts` — `runNodeDescriptionsStep` | Generates natural-language descriptions for high-degree nodes above a configurable threshold (algorithmic or LLM-enhanced). Incrementally re-generates only nodes whose fingerprint changed |
| **O11** | Outlines | `build/steps/outlines.ts` — `runOutlinesStep` | Generates tree-sitter code outlines (functions, classes, imports, signatures) for files matching `outlines.patterns`. **Independent of the graph** — reads source files directly from repo paths, with its own SHA-256 per-file hashing for incrementality |
| **O12** | Search Indexer | `build/steps/indexer.ts` — `runIndexerStep` | Builds a SQLite FTS index (`graph_search.db`) from `graph.json` for structural queries |
| **O13** | HTML Generation | `build/steps/html-step.ts` — `runHtmlStep` | Generates `graph.html` (node-level vis.js visualization) and `graph_communities.html` (community-level visualization). Uses community summaries as labels when available |
| **O14** | Report Generation | `build/steps/report.ts` — `runReportStep` | Generates `report.md` with stats, god nodes, community breakdown, edge type distribution. Uses community summaries for naming when available |

### Corrections to the Initial List

Your list was essentially complete. Refined observations:

1. **"Viene estratto un grafo"** — this bundles 7 sub-operations (O1–O7). The extraction pipeline is the most complex phase.
2. **"Si costruiscono community"** — Community Detection (O6) is distinct from **Community Summaries** (O9). Detection assigns nodes to clusters; summaries generate natural-language descriptions of those clusters. Your list didn't mention Community Summaries as a separate operation.
3. **All other items map 1:1** to operations O8, O10, O11, O12, O13, O14.

---

## 2. Artifacts Produced

| Artifact | Produced by | Format | Description |
|----------|-------------|--------|-------------|
| `graph.json` | O7: JSON Export | JSON | Full graph: nodes, edges, community assignments, metadata + build_config fingerprint |
| `vectors/` | O8: Embeddings | LanceDB (or JSON fallback) | Vector store for semantic similarity search |
| `tfidf_idf.json` | O8: Embeddings (TF-IDF only) | JSON | IDF vocabulary weights for query-time embedding |
| `community_summaries.json` | O9: Community Summaries | JSON | Array of `{id, summary, hub_nodes}` per community |
| `node_descriptions.json` | O10: Node Descriptions | JSON | Array of `{id, description}` for high-degree nodes |
| `outlines/<repo>/<path>.outline.json` | O11: Outlines | JSON per file | Tree-sitter code outline for each source file |
| `graph_search.db` | O12: Search Indexer | SQLite | FTS index for structural node/edge queries |
| `graph.html` | O13: HTML Generation | HTML | Interactive node-level vis.js visualization |
| `graph_communities.html` | O13: HTML Generation | HTML | Interactive community-level vis.js visualization |
| `report.md` | O14: Report Generation | Markdown | Build stats, hotspots, community breakdown |
| `.cache/hashes.json` | O2/O3: Incremental | JSON | File path → SHA-256 map (incremental build cache) |
| `.cache/extractions/<hash>.json` | O4: AST Extraction | JSON | Cached `FileExtraction` per file |
| `.cache/semantic-graph-hash.txt` | Orchestrator | Text | SHA-256 of the full graph structure |
| `.cache/node-texts.json` | O8: Embeddings | JSON | Node ID → text hash (incremental embeddings) |
| `.cache/outline-hashes.json` | O11: Outlines | JSON | File path → SHA-256 (incremental outlines) |
| `.cache/community-summary-fingerprints.json` | O9: Community Summaries | JSON | Fingerprint → summary cache |
| `.cache/node-description-fingerprints.json` | O10: Node Descriptions | JSON | Fingerprint → description cache |
| `.cache/build-manifest.json` | Orchestrator | JSON | Step execution history |

---

## 3. Operation Dependency Tree

### Data-Flow Dependencies (what each operation truly needs)

```
Config (reponova.yml)
│
├─── O1: File Detection
│     │   reads: workspace dirs, config patterns
│     │   produces: file path lists (code, docs, diagrams)
│     │
│     └─── O2: File Hashing
│           │   reads: detected files
│           │   produces: Map<filePath, sha256>
│           │
│           └─── O3: Incremental Diff
│                 │   reads: current hashes + .cache/hashes.json + .cache/extractions/
│                 │   produces: changedFiles[], cachedExtractions[]
│                 │
│                 └─── O4: AST Extraction
│                       │   reads: changed source files (tree-sitter WASM)
│                       │   produces: FileExtraction[] (fresh)
│                       │
│                       └─── O5: Graph Building
│                             │   reads: ALL FileExtraction[] (cached + fresh)
│                             │   produces: graphology Graph (in-memory)
│                             │
│                             └─── O6: Community Detection
│                                   │   reads: graphology Graph
│                                   │   produces: CommunityResult (in-memory), mutates graph nodes
│                                   │
│                                   └─── O7: JSON Export
│                                         │   reads: graphology Graph + CommunityResult + Config
│                                         │   produces: graph.json
│                                         │
│                                         ├─── O8:  Embeddings ─────────────── vectors/, tfidf_idf.json
│                                         ├─── O9:  Community Summaries ────── community_summaries.json
│                                         │          │
│                                         │          ├─── O13: HTML ─────────── graph.html, graph_communities.html
│                                         │          └─── O14: Report ──────── report.md
│                                         │
│                                         ├─── O10: Node Descriptions ─────── node_descriptions.json
│                                         └─── O12: Search Indexer ─────────── graph_search.db
│
└─── O11: Outlines ──────────────────────────────── outlines/**/*.outline.json
      reads: source files directly from repo paths (NOT graph.json)
      uses: own SHA-256 hashing, own pattern matching
      INDEPENDENT of the graph pipeline
```

### Dependency Matrix

| Operation | Depends On (data) | Depends On (artifact) |
|-----------|-------------------|-----------------------|
| O1: File Detection | Config | — |
| O2: File Hashing | O1 | — |
| O3: Incremental Diff | O2 | `.cache/hashes.json`, `.cache/extractions/` |
| O4: AST Extraction | O3 | source files |
| O5: Graph Building | O4 + O3 (cached extractions) | — |
| O6: Community Detection | O5 | — |
| O7: JSON Export | O5 + O6 | — |
| **O8: Embeddings** | **O7** | **`graph.json`** |
| **O9: Community Summaries** | **O7** | **`graph.json`** |
| **O10: Node Descriptions** | **O7** | **`graph.json`** |
| **O11: Outlines** | **Config only** | **source files (NOT graph.json)** |
| **O12: Search Indexer** | **O7** | **`graph.json`** |
| **O13: HTML Generation** | **O5 + O6 (in-memory) + O9 (optional)** | **`community_summaries.json` (optional)** |
| **O14: Report Generation** | **O7 + O9 (optional)** | **`graph.json` + `community_summaries.json` (optional)** |

---

## 4. Artifact Dependency Tree

Which artifacts depend on which other artifacts for their creation.

```
source files (workspace)
│
├─── .cache/hashes.json ←────────────────────── (file SHA-256 hashes)
├─── .cache/extractions/*.json ←─────────────── (cached FileExtraction per file)
│
└─── graph.json ←────────────────────────────── (nodes + edges + communities + metadata)
      │
      ├─── vectors/ ←────────────────────────── (embedding vectors for all nodes)
      │     └── .cache/node-texts.json           (incremental text cache)
      │
      ├─── tfidf_idf.json ←──────────────────── (TF-IDF vocabulary, only if method=tfidf)
      │
      ├─── community_summaries.json ←─────────── (NL summaries per community)
      │     │   └── .cache/community-summary-fingerprints.json
      │     │
      │     ├─── graph.html ←─────────────────── (node visualization)
      │     ├─── graph_communities.html ←──────── (community visualization, uses summaries as labels)
      │     └─── report.md ←──────────────────── (build report, uses summaries for community names)
      │
      ├─── node_descriptions.json ←────────────── (NL descriptions for high-degree nodes)
      │     └── .cache/node-description-fingerprints.json
      │
      └─── graph_search.db ←──────────────────── (SQLite FTS index)

source files (repo paths, independent)
│
└─── outlines/**/*.outline.json ←──────────────── (code outlines per file)
      └── .cache/outline-hashes.json               (incremental hash cache)
```

### Key Insight: Artifact Invalidation Cascade

When `graph.json` changes (because source files changed → graph structure changed):

```
graph.json changed
  ├─→ vectors/ must be updated (re-embed changed nodes)
  ├─→ community_summaries.json must be updated (re-summarize changed communities)
  │     ├─→ graph.html must be regenerated
  │     ├─→ graph_communities.html must be regenerated
  │     └─→ report.md must be regenerated
  ├─→ node_descriptions.json must be updated (re-describe changed nodes)
  └─→ graph_search.db must be rebuilt
```

When only `community_summaries.json` changes (e.g., switching LLM model):

```
community_summaries.json changed
  ├─→ graph_communities.html must be regenerated (uses summaries as labels)
  └─→ report.md must be regenerated (uses summaries for community names)
```

When nothing in the graph changed:

```
graph.json unchanged (detected via semantic graph hash)
  → all downstream steps check timestamps and skip
```

---

## 5. Parallelization Analysis

### Current State: Fully Sequential

The orchestrator runs all Phase 2 steps in strict sequence:

```
O8 → O9 → O10 → O11 → O12 → O13 → O14
```

### Actual Data Dependencies Allow Parallelism

Based on the dependency analysis above, the **minimum required ordering** is:

```
               ┌─── O8:  Embeddings ──────────────┐
               │                                    │
               ├─── O9:  Community Summaries ──┐    │
               │                                │    │
graph.json ────┼─── O10: Node Descriptions     │    ├──→ done
               │                                │    │
               ├─── O12: Search Indexer         │    │
               │                                │    │
               └─── O11: Outlines (*)          │    │
                                                │    │
                              O13: HTML ────────┘    │
                              O14: Report ───────────┘

(*) O11 has NO dependency on graph.json — can start as early as O1 completes
```

### Parallelizable Groups

| Group | Operations | Can run in parallel? | Blocked by |
|-------|-----------|---------------------|------------|
| **A** | O8, O9, O10, O11, O12 | Yes — all independent | O7 only (except O11 which is fully independent) |
| **B** | O13 (HTML) | After Group A | O9 (Community Summaries) + in-memory graph |
| **C** | O14 (Report) | After Group A | O7 (graph.json) + O9 (Community Summaries, optional) |

**O11 (Outlines)** is the most parallelizable: it has zero dependency on the graph pipeline and could run concurrently with the entire extraction phase (O1–O7).

---

## 6. Incremental Build Skip Conditions

Each step has its own skip logic. Here's when each step decides to skip:

| Operation | Skip condition |
|-----------|---------------|
| O3: Incremental Diff | File hash matches previous build → reuse cached extraction |
| O7: JSON Export | Serialized content identical to existing `graph.json` (excluding `built_at`) → skip write |
| O8: Embeddings | All node texts unchanged + no removed nodes → skip |
| O9: Community Summaries | All community fingerprints unchanged → skip |
| O10: Node Descriptions | All node fingerprints unchanged → skip |
| O11: Outlines | All source file SHA-256 hashes unchanged → skip |
| O12: Search Indexer | `graph.json` mtime older than `graph_search.db` mtime → skip |
| O13: HTML | `graph.json` mtime older than both `.html` files AND `community_summaries.json` unchanged → skip |
| O14: Report | `graph.json` mtime older than `report.md` AND `community_summaries.json` unchanged → skip |

### Config Change Detection

Each step also detects **config-only changes** via `previousConfig` (stored in `graph.json` metadata → `build_config`):

| Config field change | Forces re-run of |
|---------------------|------------------|
| `embeddings.method`, `.model`, `.dimensions` | O8: Embeddings (full re-embed) |
| `community_summaries.model`, `.context_size` | O9: Community Summaries (full re-generate) |
| `node_descriptions.model`, `.context_size`, `.threshold` | O10: Node Descriptions (full re-generate) |
| `outlines.patterns`, `.exclude`, `.exclude_common` | Detected at config level but not explicitly forced — the file hash system handles it since different files would be detected |
