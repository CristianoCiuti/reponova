# RepoNova Pipeline — Implementation Plan

> Unified analysis of all interventions needed to restructure the build pipeline into
> independent, atomic phases orchestrated by a generic DAG executor.
>
> Merges and supersedes: `PIPELINE-REDESIGN.md`, `INCREMENTAL-ANALYSIS.md`.

---

## 1. Config Changes

### 1.1 Unified File Filters

Currently file selection for source code (previously `build.patterns/exclude/exclude_common`) and for outlines
(`outlines.patterns/exclude/exclude_common`) are independent — two separate walks, two separate configs.

Since outlines consume the **same file list** as extraction, the outline-specific filters are redundant.
A single `file-detection` phase uses the top-level `patterns/exclude/exclude_common` to produce
`detected-files.json`. Both `graph` and `outlines` consume that same artifact.

**Removed from config:**

| Field | Reason |
|-------|--------|
| `build` (entire nesting level) | Children promoted to top level |
| `outlines.patterns` | Merged into top-level `patterns` |
| `outlines.exclude` | Merged into top-level `exclude` |
| `outlines.exclude_common` | Merged into top-level `exclude_common` |

**After:**

```yaml
outlines:
  enabled: true
  # That's it. File selection comes from top-level patterns / exclude / exclude_common.
```

### 1.2 Removed: Global BuildConfigFingerprint

Currently `graph.json` metadata contains a `build_config` fingerprint used by the orchestrator to detect
config changes and decide which subsystems to regenerate.

In the new design each phase manages its own config invalidation internally. The global fingerprint
is removed from `graph.json` metadata and from the type system.

Each phase that needs config-change detection stores a hash of its relevant config fields in its own
cache file (e.g. `.cache/embeddings-config-hash.txt`). On next run, if the hash differs → force full re-run
for that phase.

### 1.3 Removed: `build` Nesting Level

The `build` key served as a grouping container — it has no semantic meaning now that every concern
is a standalone phase. All children are promoted to the config root.

### 1.4 New Config YAML

```yaml
output: ../reponova-out

repos:
  - name: my-project
    path: ..

models:
  cache_dir: ~/.cache/reponova/models
  gpu: auto            # auto | cpu | cuda | metal | vulkan
  threads: 0           # 0 = auto-detect
  download_on_first_use: true

# ── Source Code File Filters (shared by graph + outlines) ──
patterns: []             # empty = auto-detect by extension
exclude: []
exclude_common: true     # skip node_modules, __pycache__, .git, venv, etc.
incremental: true

# ── Documentation ──
docs:
  enabled: true
  patterns: []
  exclude: []
  max_file_size_kb: 500

# ── Diagrams / Images ──
images:
  enabled: true
  patterns: []
  exclude: []
  parse_puml: true
  parse_svg_text: true

# ── Embeddings ──
embeddings:
  enabled: true
  method: tfidf          # tfidf | onnx
  model: all-MiniLM-L6-v2
  dimensions: 384
  batch_size: 128

# ── Community Summaries ──
community_summaries:
  enabled: true
  max_number: 0          # 0 = all
  # model: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M"
  context_size: 512

# ── Node Descriptions ──
node_descriptions:
  enabled: true
  threshold: 0.8         # top 20%
  # model: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M"
  context_size: 512

# ── HTML ──
html: true
# html_min_degree: 3

# ── Outlines ──
outlines:
  enabled: true

server: {}
```

### 1.5 New TypeScript Types

```typescript
// Config — flat, no more BuildConfig wrapper
export interface Config {
  output: string;
  repos: RepoConfig[];
  models: ModelsConfig;
  patterns: string[];
  exclude: string[];
  exclude_common: boolean;
  incremental: boolean;
  docs: DocsConfig;
  images: ImagesConfig;
  embeddings: EmbeddingsConfig;
  community_summaries: CommunitySummariesConfig;
  node_descriptions: NodeDescriptionsConfig;
  html: boolean;
  html_min_degree?: number;
  outlines: OutlineConfig;
  server: ServerConfig;
}

// OutlineConfig — simplified (no more patterns/exclude/exclude_common)
export interface OutlineConfig {
  enabled: boolean;
}

// BuildConfig — REMOVED entirely. Fields promoted to Config root.
// BuildConfigFingerprint — REMOVED entirely.
// Each phase stores its own config hash internally.

// GraphMetadata — remove build_config field
export interface GraphMetadata {
  reponova_version?: string;
  built_at?: string;
  config_dir?: string;
  repos?: Array<{ name: string; path: string }>;
  mode?: "single" | "multi";
  node_count?: number;
  edge_count?: number;
  // build_config: REMOVED
}
```

### 1.6 Zod Schema Changes

```typescript
// OutlineConfigSchema — simplified
const OutlineConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

// BuildConfigSchema — REMOVED. Its fields move into ConfigSchema directly:
const ConfigSchema = z.object({
  output: z.string().default("reponova-out"),
  repos: z.array(RepoConfigSchema).default([]),
  models: ModelsConfigSchema.default({}),
  patterns: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  exclude_common: z.boolean().default(true),
  incremental: z.boolean().default(true),
  docs: DocsConfigSchema.default({}),
  images: ImagesConfigSchema.default({}),
  embeddings: EmbeddingsConfigSchema.default({}),
  community_summaries: CommunitySummariesConfigSchema.default({}),
  node_descriptions: NodeDescriptionsConfigSchema.default({}),
  html: z.boolean().default(true),
  html_min_degree: z.number().int().min(1).optional(),
  outlines: OutlineConfigSchema.default({}),
  server: ServerConfigSchema.default({}),
});
```

---

## 2. Target DAG

```
                          ┌─────────────────────── outlines
                          │
file-detection ───────────┤
                          │
                          └─── graph ─── communities ───┬─── community-summaries ───┬─── embeddings
                                                        │                           │
                                                        ├─── node-descriptions ─────┼─── html
                                                        │                           │
                                                        └─── index                  └─── report
```

### Execution Levels (maximum parallelism)

| Level | Phases | Blocked by |
|-------|--------|------------|
| 0 | `file-detection` | — |
| 1 | `graph`, `outlines` | file-detection |
| 2 | `communities` | graph |
| 3 | `community-summaries`, `node-descriptions`, `index` | communities |
| 4 | `embeddings`, `html`, `report` | community-summaries + node-descriptions |

---

## 3. Project File Structure

### 3.1 New `src/` Layout

```
src/
├── pipeline/                              # Phase system
│   ├── engine/                            # Generic DAG execution (phase-agnostic)
│   │   ├── phase.ts                       #   Phase, PhaseContext, PhaseResult
│   │   ├── registry.ts                    #   PhaseRegistry
│   │   ├── dag.ts                         #   buildDAG, validate, topologicalLevels
│   │   └── orchestrator.ts                #   Level-by-level parallel executor
│   │
│   └── phases/                            # One file per phase (atomic, independent)
│       ├── file-detection.ts
│       ├── graph.ts
│       ├── outlines.ts
│       ├── communities.ts
│       ├── community-summaries.ts
│       ├── node-descriptions.ts
│       ├── search-index.ts
│       ├── embeddings.ts
│       ├── html.ts
│       └── report.ts
│
├── extract/                               # Shared: AST extraction + graph building
│   ├── parser.ts                          #   Tree-sitter WASM parser
│   ├── graph-builder.ts                   #   FileExtraction[] → graphology Graph
│   ├── community.ts                       #   Louvain community detection
│   ├── export-json.ts                     #   Serialize graphology → JSON
│   ├── export-html.ts                     #   Interactive HTML visualizations
│   ├── import-resolver.ts                 #   Resolve import module → file paths
│   ├── incremental.ts                     #   MOVED from build/incremental/incremental.ts
│   ├── types.ts                           #   FileExtraction, SymbolNode, etc.
│   └── languages/                         #   Per-language extractors
│       ├── registry.ts
│       ├── python.ts
│       ├── markdown.ts
│       └── diagram.ts
│
├── outline/                               # Shared: tree-sitter outline generation
│   ├── index.ts                           #   generateOutline entry point
│   ├── cache.ts                           #   SHA-256 per-file cache
│   ├── formatter.ts                       #   Outline formatting
│   └── languages/                         #   Per-language outline support
│       ├── registry.ts
│       └── python.ts
│
├── intelligence/                          # MOVED from build/intelligence/
│   ├── llm-engine.ts                      #   Single LLM engine
│   ├── llm-engine-pool.ts                 #   Shared engine pool
│   ├── community-summary-generator.ts
│   ├── node-description-generator.ts
│   ├── embeddings.ts                      #   composeNodeText + ONNX embedding
│   ├── tfidf-embeddings.ts                #   TF-IDF embedding
│   └── cache-dir.ts                       #   Model cache directory
│
├── core/                                  # Shared: config, DB, graph loading, search
│   ├── config.ts
│   ├── db.ts
│   ├── graph-loader.ts                    #   loadGraphData (flat GraphData interface)
│   ├── graph-graphology.ts                #   NEW: loadGraphAsGraphology (JSON → graphology)
│   ├── graph-resolver.ts
│   ├── path-resolver.ts
│   ├── build-config-metadata.ts           #   DELETED (replaced by per-phase config hashing)
│   ├── vector-store.ts
│   ├── context-builder.ts
│   ├── search.ts
│   ├── impact.ts
│   ├── node-detail.ts
│   └── shortest-path.ts
│
├── cli/                                   # CLI commands
│   ├── index.ts                           #   UPDATED: new subcommands
│   ├── build.ts                           #   UPDATED: --target <phase>, uses new orchestrator
│   ├── check.ts
│   ├── cmd-index.ts                       #   Legacy standalone index command
│   ├── install.ts
│   ├── mcp.ts
│   ├── models.ts
│   └── outline.ts                         #   DELETED: subsumed by `build --target outlines`
│
├── mcp/                                   # MCP server (unchanged)
├── shared/                                # Shared types + utilities
│   ├── types.ts                           #   UPDATED: remove BuildConfigFingerprint,
│   │                                      #            simplify OutlineConfig
│   ├── utils.ts
│   └── atomic-write.ts
│
└── index.ts                               # Public API (updated exports)
```

### 3.2 Deleted Files

| File | Reason |
|------|--------|
| `src/build/orchestrator.ts` | Replaced by `src/pipeline/engine/orchestrator.ts` |
| `src/build/types.ts` | Replaced by `src/pipeline/engine/phase.ts` |
| `src/build/manifest.ts` | Orchestrator tracks results directly |
| `src/build/steps/embeddings-step.ts` | Logic moves to `src/pipeline/phases/embeddings.ts` |
| `src/build/steps/community-summaries-step.ts` | Logic moves to `src/pipeline/phases/community-summaries.ts` |
| `src/build/steps/node-descriptions-step.ts` | Logic moves to `src/pipeline/phases/node-descriptions.ts` |
| `src/build/steps/outlines.ts` | Logic moves to `src/pipeline/phases/outlines.ts` |
| `src/build/steps/indexer.ts` | Logic moves to `src/pipeline/phases/search-index.ts` |
| `src/build/steps/html-step.ts` | Logic moves to `src/pipeline/phases/html.ts` |
| `src/build/steps/report.ts` | Logic moves to `src/pipeline/phases/report.ts` |
| `src/build/incremental/incremental.ts` | Moves to `src/extract/incremental.ts` |
| `src/build/incremental/config-diff.ts` | Replaced by per-phase config hashing |
| `src/build/incremental/graph-hash.ts` | Replaced by `communities` phase internal cache |
| `src/core/build-config-metadata.ts` | No longer needed |
| `src/cli/outline.ts` | Subsumed by `build --target outlines` |
| `src/extract/index.ts` → `runPipeline()` | Monolith split across `file-detection` + `graph` phases. File detection functions (`detectFiles`, `detectDocFiles`, `detectDiagramFiles`) and `extractAll` stay as shared utilities — only `runPipeline` is deleted. |

### 3.3 Moved Files

| From | To | Notes |
|------|----|-------|
| `src/build/intelligence/*.ts` (7 files) | `src/intelligence/*.ts` | Shared by multiple phases |
| `src/build/incremental/incremental.ts` | `src/extract/incremental.ts` | Internal to `graph` phase but lives with extract utilities |

### 3.4 New Files

| File | Purpose |
|------|---------|
| `src/pipeline/engine/phase.ts` | `Phase`, `PhaseContext`, `PhaseResult` interfaces |
| `src/pipeline/engine/registry.ts` | `PhaseRegistry` implementation |
| `src/pipeline/engine/dag.ts` | DAG building, cycle validation, topological sort |
| `src/pipeline/engine/orchestrator.ts` | Generic level-by-level parallel executor |
| `src/pipeline/phases/file-detection.ts` | Phase: detect source, doc, diagram files |
| `src/pipeline/phases/graph.ts` | Phase: extract + build graph → `graph-nodes.json` |
| `src/pipeline/phases/outlines.ts` | Phase: tree-sitter outlines |
| `src/pipeline/phases/communities.ts` | Phase: Louvain → `graph.json` |
| `src/pipeline/phases/community-summaries.ts` | Phase: community summaries |
| `src/pipeline/phases/node-descriptions.ts` | Phase: node descriptions |
| `src/pipeline/phases/search-index.ts` | Phase: SQLite FTS index |
| `src/pipeline/phases/embeddings.ts` | Phase: TF-IDF / ONNX embeddings |
| `src/pipeline/phases/html.ts` | Phase: HTML visualizations |
| `src/pipeline/phases/report.ts` | Phase: Markdown report |
| `src/core/graph-graphology.ts` | `loadGraphAsGraphology` (JSON → graphology Graph) |

### 3.5 Kept (logic reused inside new phase implementations)

| File | Used by phase |
|------|---------------|
| `src/extract/parser.ts` | `graph` |
| `src/extract/graph-builder.ts` → `buildGraph` | `graph` |
| `src/extract/community.ts` → `detectCommunities` | `communities` |
| `src/extract/export-json.ts` → `exportJson` | `graph`, `communities` |
| `src/extract/export-html.ts` → `exportHtml`, `exportCommunityHtml` | `html` |
| `src/extract/import-resolver.ts` | `graph` |
| `src/extract/languages/*` | `graph` |
| `src/extract/index.ts` → `detectFiles`, `detectDocFiles`, `detectDiagramFiles`, `extractAll` | `file-detection`, `graph` |
| `src/intelligence/embeddings.ts` → `composeNodeText` | `embeddings` |
| `src/intelligence/tfidf-embeddings.ts` | `embeddings` |
| `src/intelligence/community-summary-generator.ts` | `community-summaries` |
| `src/intelligence/node-description-generator.ts` | `node-descriptions` |
| `src/intelligence/llm-engine*.ts` | `community-summaries`, `node-descriptions` |
| `src/outline/index.ts` → `generateOutline` | `outlines` |
| `src/outline/cache.ts` | `outlines` |
| `src/outline/languages/*` | `outlines` |
| `src/core/db.ts` | `search-index` |
| `src/core/vector-store.ts` | `embeddings` |

---

## 4. Generic Engine

### 4.1 Phase Interface

```typescript
export interface Phase {
  readonly id: string;
  readonly label: string;
  readonly dependencies: string[];
  execute(ctx: PhaseContext): Promise<PhaseResult>;
}

export interface PhaseContext {
  config: Config;
  configDir: string;
  outputDir: string;
  workspace: string;
  force: boolean;
}

export interface PhaseResult {
  processed: number;
  skipped: boolean;
  skipReason?: string;
}
```

### 4.2 Phase Registry

```typescript
export interface PhaseRegistry {
  register(phase: Phase): void;
  getAll(): Phase[];
  get(id: string): Phase;
}
```

Phases register themselves at import time. The orchestrator discovers them via the registry — it never
knows phase IDs at compile time.

### 4.3 DAG

```typescript
export function buildDAG(phases: Phase[]): Map<string, Phase>;
export function validate(dag: Map<string, Phase>): void;  // throws on cycles or missing deps
export function topologicalLevels(dag: Map<string, Phase>): Phase[][];
```

### 4.4 Orchestrator

```typescript
export interface OrchestratorOptions {
  target?: string;     // run only this phase + its deps (null = full DAG)
  force: boolean;
  concurrency?: number;
}

export interface BuildResult {
  outputDir: string;
  phases: Map<string, PhaseResult>;
  totalProcessed: number;
}

export async function orchestrate(
  registry: PhaseRegistry,
  ctx: PhaseContext,
  options: OrchestratorOptions,
): Promise<BuildResult>;
```

The orchestrator:
1. Resolves which phases to run (all, or target + transitive deps)
2. Builds DAG, validates (no cycles, no missing deps)
3. Topological sort into execution levels
4. Executes level-by-level — phases within a level run in parallel via `Promise.allSettled`
5. Logs results, collects `PhaseResult` per phase

It knows nothing about specific phases. It only resolves a DAG and executes levels.

---

## 5. Phase Specifications

### Conventions

- **Inputs/Outputs** refer to filesystem artifacts in `<outputDir>/`
- **Cache** files live in `<outputDir>/.cache/` and are owned exclusively by the phase that writes them
- **Config hash** — phases that need config-change detection store a hash of their relevant config fields
  in `.cache/<phase>-config-hash.txt`. If hash differs on next run → force full re-run for that phase.
- **Skip logic** is internal to each phase — transparent to the orchestrator

---

### 5.1 file-detection

| | |
|-|-|
| **ID** | `file-detection` |
| **Label** | File Detection |
| **Dependencies** | — |
| **Inputs** | workspace filesystem, config (`repos`, `patterns`, `exclude`, `exclude_common`, `docs`, `images`) |
| **Outputs** | `detected-files.json` |
| **Reuses** | `detectFiles`, `detectDocFiles`, `detectDiagramFiles` from `src/extract/index.ts` |

**Artifact format:**

```typescript
interface DetectedFiles {
  workspace: string;
  code: string[];      // relative paths to source code files
  docs: string[];      // relative paths to doc files
  diagrams: string[];  // relative paths to diagram/image files
}
```

**Skip criteria:** none — **always runs**. The cost of a directory walk is comparable to checking
whether to skip. Output is deterministic: same filesystem + same config = same output.

**Cache:** none.

**Config invalidation:** N/A (always runs).

---

### 5.2 graph

| | |
|-|-|
| **ID** | `graph` |
| **Label** | Graph Building |
| **Dependencies** | `file-detection` |
| **Inputs** | `detected-files.json`, source file contents on disk |
| **Outputs** | `graph-nodes.json` (nodes + edges, no community assignments) |
| **Reuses** | `extractAll` from `src/extract/index.ts`, `buildGraph` from `src/extract/graph-builder.ts`, `exportJson` from `src/extract/export-json.ts`, incremental logic from `src/extract/incremental.ts` |

**Skip criteria (per-file):**

| Condition | Action |
|-----------|--------|
| File hash unchanged + cached extraction exists | Reuse cached extraction |
| File hash changed | Re-extract with tree-sitter |
| File in cache but not in `detected-files.json` | Removed — drop from cache |
| File in `detected-files.json` but not in cache | New — extract |

After extraction, the full set of `FileExtraction[]` (cached + fresh) is assembled into a graph.
Graph assembly is always full — edge resolution depends on the global symbol table.

**Cache:**
- `.cache/file-hashes.json` — `{ relPath: sha256 }`
- `.cache/extractions/<pathHash>.json` — serialized `FileExtraction` per file

**Config invalidation:** none. Config changes that affect file selection are handled by `file-detection`
(different `detected-files.json` → different file set → different hashes).

---

### 5.3 outlines

| | |
|-|-|
| **ID** | `outlines` |
| **Label** | Outlines |
| **Dependencies** | `file-detection` |
| **Inputs** | `detected-files.json`, source file contents on disk |
| **Outputs** | `outlines/**/*.outline.json` |
| **Reuses** | `generateOutline` from `src/outline/index.ts`, `hashFile` from `src/extract/incremental.ts` |

Reads `detected-files.json` for the same code file list used by the graph phase. Internally filters
to files whose extension is supported by the outline language registry.

**Skip criteria (per-file):**

| Condition | Action |
|-----------|--------|
| File hash unchanged + outline file exists | Skip |
| File hash changed or outline missing | Regenerate outline |
| File in cache but absent from `detected-files.json` | Delete stale outline |

**Cache:**
- `.cache/outline-hashes.json` — `{ relPath: sha256 }`

**Config invalidation:** none. File selection comes from `detected-files.json`.

---

### 5.4 communities

| | |
|-|-|
| **ID** | `communities` |
| **Label** | Community Detection |
| **Dependencies** | `graph` |
| **Inputs** | `graph-nodes.json` |
| **Outputs** | `graph.json` (complete graph with community assignments) |
| **Reuses** | `detectCommunities` from `src/extract/community.ts`, `exportJson` from `src/extract/export-json.ts` |
| **New utility** | `loadGraphAsGraphology` from `src/core/graph-graphology.ts` |

Loads `graph-nodes.json` into graphology, runs Louvain, writes `graph.json` — the canonical graph
file that all downstream phases read.

**Skip criteria:**

| Condition | Action |
|-----------|--------|
| `graph-nodes.json` content unchanged (mtime or hash) | Skip |
| `graph-nodes.json` content changed | Full re-run |

Detection: compare mtime of `graph-nodes.json` vs mtime of `graph.json`. Works because
`exportJson` uses content-comparison (skips write when content is unchanged, preserving mtime).

**Cache:**
- `.cache/graph-nodes-hash.txt` — SHA-256 of `graph-nodes.json` (alternative to mtime)

**Config invalidation:** none (Louvain has no user-facing config).

---

### 5.5 community-summaries

| | |
|-|-|
| **ID** | `community-summaries` |
| **Label** | Community Summaries |
| **Dependencies** | `communities` |
| **Inputs** | `graph.json` |
| **Outputs** | `community_summaries.json` |
| **Reuses** | `CommunitySummaryGenerator` from `src/intelligence/community-summary-generator.ts` |

**Skip criteria (per-community, fingerprint-based):**

```
fingerprint(community) = SHA-256(sorted(members.map(node =>
  SHA-256(node.id | node.label | node.type | node.signature | node.docstring | node.source_file)
)))
```

| Condition | Action |
|-----------|--------|
| Fingerprint matches cache AND cached summary exists | Reuse |
| Fingerprint changed | Regenerate |
| Community no longer exists | Drop |
| New community | Generate |

Fingerprint is content-based, not ID-based. Louvain can reassign community IDs between runs —
same members with same attributes → same fingerprint → cached summary reused.

**Cache:**
- `.cache/community-summary-fingerprints.json` — `{ fingerprint: CommunitySummary }`
- `.cache/community-summaries-config-hash.txt` — hash of `{ model, context_size }`

**Config invalidation:**

| Config field | Effect |
|-------------|--------|
| `community_summaries.model` changed | Full regeneration |
| `community_summaries.context_size` changed (AND model set) | Full regeneration |
| `community_summaries.max_number` changed | Fingerprint logic handles which communities qualify |

---

### 5.6 node-descriptions

| | |
|-|-|
| **ID** | `node-descriptions` |
| **Label** | Node Descriptions |
| **Dependencies** | `communities` |
| **Inputs** | `graph.json` |
| **Outputs** | `node_descriptions.json` |
| **Reuses** | `NodeDescriptionGenerator` from `src/intelligence/node-description-generator.ts` |

**Skip criteria (per-node, fingerprint-based):**

```
fingerprint(node) = SHA-256(node.id | node.source_file | node.type | node.label | node.signature | node.docstring | degree)
```

| Condition | Action |
|-----------|--------|
| Fingerprint matches cache AND cached description exists | Reuse |
| Fingerprint changed (metadata or degree changed) | Regenerate |
| Node no longer qualifies (degree below threshold) | Drop |
| Node newly qualifies | Generate |

`degree` is in the fingerprint because the description reflects the node's structural role.

**Cache:**
- `.cache/node-description-fingerprints.json` — `{ nodeId: fingerprint }`
- `.cache/node-descriptions-config-hash.txt` — hash of `{ model, context_size, threshold }`

**Config invalidation:**

| Config field | Effect |
|-------------|--------|
| `node_descriptions.model` changed | Full regeneration |
| `node_descriptions.context_size` changed (AND model set) | Full regeneration |
| `node_descriptions.threshold` changed | Different nodes qualify — re-evaluate all |

---

### 5.7 search-index

| | |
|-|-|
| **ID** | `index` |
| **Label** | Search Index |
| **Dependencies** | `communities` |
| **Inputs** | `graph.json` |
| **Outputs** | `graph_search.db` |
| **Reuses** | `openDatabase`, `initializeSchema`, `populateDatabase`, `saveDatabase` from `src/core/db.ts` |

**Skip criteria:**

| Condition | Action |
|-----------|--------|
| `graph.json` mtime ≤ `graph_search.db` mtime | Skip |
| `graph.json` mtime > `graph_search.db` mtime | Full re-run |
| `graph_search.db` doesn't exist | Full re-run |

**Cache:** none (the output IS the cache).

**Config invalidation:** none (schema is fixed).

---

### 5.8 embeddings

| | |
|-|-|
| **ID** | `embeddings` |
| **Label** | Embeddings |
| **Dependencies** | `community-summaries`, `node-descriptions` |
| **Inputs** | `graph.json`, `community_summaries.json`, `node_descriptions.json` |
| **Outputs** | `vectors/`, `tfidf_idf.json` (TF-IDF only) |
| **Reuses** | `EmbeddingEngine`, `TfidfEmbeddingEngine` from `src/intelligence/embeddings.ts` and `src/intelligence/tfidf-embeddings.ts`, `VectorStore` from `src/core/vector-store.ts` |

**Enriched `composeNodeText`** — now includes community summary + node description:

```typescript
export function composeNodeText(
  node: NodeEmbeddingInput,
  communitySummary?: string,
  nodeDescription?: string,
): string {
  // ... existing type-based text composition ...

  if (nodeDescription) text += ` ${nodeDescription}`;
  if (communitySummary) text += ` context: ${communitySummary}`;

  return text.replace(/\s+/g, " ").trim().slice(0, 512);
}
```

**Skip criteria (per-node, composed text comparison):**

```
composedText(node) = composeNodeText(node, nodeDescription, communitySummary)
```

Cache stores: `{ nodeId: composedText }`. If composed text identical → skip.

| Condition | Action |
|-----------|--------|
| Composed text identical AND vector exists | Skip |
| Composed text changed | Re-embed |
| Node removed from graph | Remove vector |
| New node | Embed |

**TF-IDF special case:** adding or removing nodes changes the IDF vocabulary globally —
every existing vector becomes stale. Full re-embed required.

| Scenario | ONNX | TF-IDF |
|----------|------|--------|
| 3 nodes changed out of 500 | Re-embed 3 | Re-embed 3 |
| 1 node added | Embed 1 | Re-embed ALL |
| 1 node removed | Remove 1 | Re-embed ALL |

**Cache:**
- `.cache/node-texts.json` — `{ nodeId: composedText }`
- `.cache/embeddings-config-hash.txt` — hash of `{ method, model, dimensions }`

**Config invalidation:**

| Config field | Effect |
|-------------|--------|
| `embeddings.method` changed (tfidf ↔ onnx) | Full re-embed |
| `embeddings.model` changed | Full re-embed |
| `embeddings.dimensions` changed | Full re-embed |

---

### 5.9 html

| | |
|-|-|
| **ID** | `html` |
| **Label** | HTML Visualizations |
| **Dependencies** | `community-summaries`, `node-descriptions` |
| **Inputs** | `graph.json`, `community_summaries.json`, `node_descriptions.json` |
| **Outputs** | `graph.html`, `graph_communities.html` |
| **Reuses** | `exportHtml`, `exportCommunityHtml` from `src/extract/export-html.ts` |
| **New** | Loads graph from `graph.json` via `loadGraphAsGraphology` (no more in-memory passing) |

**Skip criteria:**

| Condition | Action |
|-----------|--------|
| All inputs older than both outputs | Skip |
| Any input newer than either output | Full re-run |
| Either output missing | Full re-run |

```
max(mtime(graph.json), mtime(community_summaries.json), mtime(node_descriptions.json))
  > min(mtime(graph.html), mtime(graph_communities.html))
```

**Cache:** none (mtime comparison).

**Config invalidation:**

| Config field | Effect |
|-------------|--------|
| `html` toggled off | Delete outputs, skip |
| `html_min_degree` changed | Full re-run |

---

### 5.10 report

| | |
|-|-|
| **ID** | `report` |
| **Label** | Report |
| **Dependencies** | `community-summaries`, `node-descriptions` |
| **Inputs** | `graph.json`, `community_summaries.json`, `node_descriptions.json` |
| **Outputs** | `report.md` |
| **Reuses** | `generateGraphReport` from current `src/build/steps/report.ts` |

**Skip criteria:**

| Condition | Action |
|-----------|--------|
| All inputs older than `report.md` | Skip |
| Any input newer than `report.md` | Full re-run |
| `report.md` missing | Full re-run |

**Cache:** none (mtime comparison).

**Config invalidation:** none.

---

## 6. Artifact Ownership

### 6.1 Write Ownership (1 artifact → 1 phase)

| Artifact | Sole Owner |
|----------|-----------|
| `detected-files.json` | `file-detection` |
| `graph-nodes.json` | `graph` |
| `graph.json` | `communities` |
| `community_summaries.json` | `community-summaries` |
| `node_descriptions.json` | `node-descriptions` |
| `graph_search.db` | `index` |
| `vectors/`, `tfidf_idf.json` | `embeddings` |
| `outlines/**/*.outline.json` | `outlines` |
| `graph.html`, `graph_communities.html` | `html` |
| `report.md` | `report` |

### 6.2 Read Dependencies

| Artifact | Written by | Read by |
|----------|-----------|---------|
| `detected-files.json` | `file-detection` | `graph`, `outlines` |
| `graph-nodes.json` | `graph` | `communities` |
| `graph.json` | `communities` | `community-summaries`, `node-descriptions`, `index`, `embeddings`, `html`, `report` |
| `community_summaries.json` | `community-summaries` | `embeddings`, `html`, `report` |
| `node_descriptions.json` | `node-descriptions` | `embeddings`, `html`, `report` |
| `outlines/**` | `outlines` | — (terminal: MCP server) |
| `vectors/`, `tfidf_idf.json` | `embeddings` | — (terminal: MCP server) |
| `graph_search.db` | `index` | — (terminal: MCP server) |
| `graph.html`, `graph_communities.html` | `html` | — (terminal: user) |
| `report.md` | `report` | — (terminal: user) |

### 6.3 Cache Ownership (each phase owns its cache exclusively)

| Cache file | Phase |
|-----------|-------|
| `.cache/file-hashes.json` | `graph` |
| `.cache/extractions/<hash>.json` | `graph` |
| `.cache/graph-nodes-hash.txt` | `communities` |
| `.cache/outline-hashes.json` | `outlines` |
| `.cache/community-summary-fingerprints.json` | `community-summaries` |
| `.cache/community-summaries-config-hash.txt` | `community-summaries` |
| `.cache/node-description-fingerprints.json` | `node-descriptions` |
| `.cache/node-descriptions-config-hash.txt` | `node-descriptions` |
| `.cache/node-texts.json` | `embeddings` |
| `.cache/embeddings-config-hash.txt` | `embeddings` |

---

## 7. New Utilities

### 7.1 `loadGraphAsGraphology`

**File:** `src/core/graph-graphology.ts`

Inverse of `exportJson`. Loads a graph JSON file (either `graph-nodes.json` or `graph.json`) into
a live graphology directed graph. Required by `communities` (loads `graph-nodes.json` for Louvain)
and `html` (loads `graph.json` for degree calculations).

```typescript
import Graph from "graphology";
import { loadGraphData } from "./graph-loader.js";

export function loadGraphAsGraphology(jsonPath: string): Graph {
  const data = loadGraphData(jsonPath);
  const graph = new Graph({ type: "directed", multi: false, allowSelfLoops: false });

  for (const node of data.nodes) {
    graph.addNode(node.id, {
      label: node.label,
      type: node.type,
      file_type: node.file_type,
      source_file: node.source_file,
      repo: node.repo,
      community: node.community,
      start_line: node.start_line,
      end_line: node.end_line,
      norm_label: node.norm_label,
      docstring: node.docstring,
      signature: node.signature,
      bases: node.bases,
    });
  }

  for (const edge of data.edges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      try {
        graph.addEdge(edge.source, edge.target, {
          relation: edge.type,
          confidence: "EXTRACTED",
          confidence_score: 1.0,
          weight: 1,
        });
      } catch { /* ignore duplicates */ }
    }
  }

  return graph;
}
```

### 7.2 `readDetectedFiles`

**File:** inline utility in phases that need it, or in `src/core/`

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface DetectedFiles {
  workspace: string;
  code: string[];
  docs: string[];
  diagrams: string[];
}

export function readDetectedFiles(outputDir: string): DetectedFiles {
  const raw = readFileSync(join(outputDir, "detected-files.json"), "utf-8");
  return JSON.parse(raw) as DetectedFiles;
}
```

---

## 8. CLI

```
reponova build [--force] [--config <path>]                → runs full DAG
reponova build --target <phase-id> [--force]              → runs phase + transitive deps
reponova build --target html                              → file-detection → graph → communities → community-summaries → node-descriptions → html
reponova build --target embeddings                        → file-detection → graph → communities → community-summaries → node-descriptions → embeddings
reponova build --target index                             → file-detection → graph → communities → index
reponova build --target outlines                          → file-detection → outlines
```

**Removed CLI commands:**
- `reponova outline` — subsumed by `reponova build --target outlines`
- `reponova index` — subsumed by `reponova build --target index`

---

## 9. Summary Matrix

| Phase | Detection Method | Granularity | Config Fields That Force Full Re-run |
|-------|-----------------|-------------|--------------------------------------|
| `file-detection` | Always run | — | — |
| `graph` | Per-file SHA-256 | Per-file extraction, full graph assembly | — |
| `outlines` | Per-file SHA-256 | Per-file | — |
| `communities` | Input mtime or content hash | All-or-nothing | (Louvain resolution, if configurable) |
| `community-summaries` | Per-community fingerprint | Per-community | `model`, `context_size` |
| `node-descriptions` | Per-node fingerprint | Per-node | `model`, `context_size`, `threshold` |
| `index` | Input mtime | All-or-nothing | — |
| `embeddings` | Per-node composed text | Per-node (ONNX) / global (TF-IDF on add/remove) | `method`, `model`, `dimensions` |
| `html` | Input mtime | All-or-nothing | `html`, `html_min_degree` |
| `report` | Input mtime | All-or-nothing | — |

---

## 10. Build Output (new layout)

```
reponova-out/
├── detected-files.json                     # NEW: shared file list
├── graph-nodes.json                        # NEW: nodes + edges (no communities)
├── graph.json                              # Complete graph with community assignments
├── graph.html
├── graph_communities.html
├── graph_search.db
├── report.md
├── community_summaries.json
├── node_descriptions.json
├── tfidf_idf.json                          # TF-IDF only
├── vectors/                                # LanceDB vector store
├── outlines/
│   └── <repo>/<path>.outline.json
└── .cache/                                 # Per-phase internal cache
    ├── file-hashes.json                    # graph phase
    ├── extractions/                        # graph phase
    │   └── <pathHash>.json
    ├── graph-nodes-hash.txt                # communities phase
    ├── outline-hashes.json                 # outlines phase
    ├── community-summary-fingerprints.json # community-summaries phase
    ├── community-summaries-config-hash.txt # community-summaries phase
    ├── node-description-fingerprints.json  # node-descriptions phase
    ├── node-descriptions-config-hash.txt   # node-descriptions phase
    ├── node-texts.json                     # embeddings phase
    └── embeddings-config-hash.txt          # embeddings phase
```

**Removed from output:**
- `.cache/hashes.json` → renamed to `.cache/file-hashes.json`
- `.cache/semantic-graph-hash.txt` → replaced by `.cache/graph-nodes-hash.txt` (owned by `communities`)

---

## 11. Design Principles

1. **Phases communicate via filesystem only** — no in-memory object passing between phases
2. **Each artifact has exactly one owner** — no two phases write the same file
3. **Each phase owns its cache exclusively** — no phase reads another phase's cache
4. **Two-stage graph** — `graph` writes `graph-nodes.json` (nodes + edges); `communities` reads it, runs Louvain, writes `graph.json` (complete)
5. **Unified file detection** — `file-detection` produces one file list consumed by both `graph` and `outlines`
6. **Enriched embeddings** — `composeNodeText` incorporates community summary + node description
7. **Orchestrator is generic** — knows nothing about phases, only resolves a DAG and executes levels in parallel
8. **Per-phase config invalidation** — each phase stores its own config hash, no global fingerprint
9. **Transitive dependency resolution** — phases declare only direct dependencies; orchestrator resolves the full chain
