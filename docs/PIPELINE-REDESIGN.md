# RepoNova Pipeline Redesign — Atomic Phases & DAG Orchestration

> Analysis and design document for restructuring the build pipeline into independent, atomic phases
> orchestrated by a generic dependency-tree executor.

---

## 1. Target DAG

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

## 2. Phase Registry

### Phase Definitions

| Phase ID | Dependencies | Produces | Consumes |
|----------|-------------|----------|----------|
| `file-detection` | — | `detected-files.json` | config, workspace |
| `graph` | `file-detection` | `graph-nodes.json` | `detected-files.json`, source files |
| `outlines` | `file-detection` | `outlines/**/*.outline.json` | `detected-files.json`, source files |
| `communities` | `graph` | `graph.json` | `graph-nodes.json` |
| `community-summaries` | `communities` | `community_summaries.json` | `graph.json` |
| `node-descriptions` | `communities` | `node_descriptions.json` | `graph.json` |
| `index` | `communities` | `graph_search.db` | `graph.json` |
| `embeddings` | `community-summaries`, `node-descriptions` | `vectors/`, `tfidf_idf.json` | `graph.json`, `community_summaries.json`, `node_descriptions.json` |
| `html` | `community-summaries`, `node-descriptions` | `graph.html`, `graph_communities.html` | `graph.json`, `community_summaries.json`, `node_descriptions.json` |
| `report` | `community-summaries`, `node-descriptions` | `report.md` | `graph.json`, `community_summaries.json`, `node_descriptions.json` |

### Artifact Ownership (1 phase → 1 artifact, no overlaps)

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

---

## 3. Generic Interface Design

### Core Types

```typescript
/**
 * A single atomic phase in the build pipeline.
 * Each phase is independently executable from CLI.
 */
export interface Phase {
  /** Unique identifier (used in CLI: `reponova run <id>`) */
  readonly id: string;

  /** Human-readable label for logging */
  readonly label: string;

  /** IDs of phases whose output this phase requires */
  readonly dependencies: string[];

  /**
   * Execute the phase.
   * The phase receives a context with access to config, paths,
   * and artifacts produced by dependency phases.
   */
  execute(ctx: PhaseContext): Promise<PhaseResult>;
}

/**
 * Execution context provided to each phase by the orchestrator.
 */
export interface PhaseContext {
  /** Full resolved config */
  config: Config;
  /** Absolute path to config directory */
  configDir: string;
  /** Absolute path to output directory */
  outputDir: string;
  /** Absolute path to workspace root */
  workspace: string;
  /** Force regeneration (ignore all caches) */
  force: boolean;
}

/**
 * Result returned by a phase after execution.
 */
export interface PhaseResult {
  /** Number of items processed */
  processed: number;
  /** True if the phase decided to skip (up-to-date) */
  skipped: boolean;
  /** Reason for skipping */
  skipReason?: string;
}
```

### Phase Registry

```typescript
/**
 * Central registry where phases declare themselves.
 * The orchestrator reads from this — it never knows phase IDs at compile time.
 */
export interface PhaseRegistry {
  /** Register a phase definition */
  register(phase: Phase): void;

  /** Get all registered phases */
  getAll(): Phase[];

  /** Get a phase by ID (throws if not found) */
  get(id: string): Phase;
}

/**
 * Simple implementation — phases register themselves at import time.
 */
export function createRegistry(): PhaseRegistry {
  const phases = new Map<string, Phase>();

  return {
    register(phase: Phase): void {
      if (phases.has(phase.id)) {
        throw new Error(`Phase "${phase.id}" already registered`);
      }
      phases.set(phase.id, phase);
    },
    getAll(): Phase[] {
      return [...phases.values()];
    },
    get(id: string): Phase {
      const phase = phases.get(id);
      if (!phase) throw new Error(`Unknown phase: "${id}"`);
      return phase;
    },
  };
}
```

### DAG Orchestrator

```typescript
export interface OrchestratorOptions {
  /** Only run this phase and its dependencies (null = run all) */
  target?: string;
  /** Force all phases to regenerate */
  force: boolean;
  /** Maximum parallelism (default: CPU cores) */
  concurrency?: number;
}

export interface BuildResult {
  outputDir: string;
  phases: Map<string, PhaseResult>;
  totalProcessed: number;
}

/**
 * The orchestrator is DUMB — it knows nothing about specific phases.
 * It only understands: dependency resolution, topological sorting, parallel execution.
 */
export async function orchestrate(
  registry: PhaseRegistry,
  ctx: PhaseContext,
  options: OrchestratorOptions,
): Promise<BuildResult> {
  // 1. Resolve which phases to run
  const phases = options.target
    ? collectDependencyChain(registry, options.target)
    : registry.getAll();

  // 2. Build DAG, validate (no cycles, no missing deps)
  const dag = buildDAG(phases);
  validate(dag);

  // 3. Topological sort into execution levels
  const levels = topologicalLevels(dag);

  // 4. Execute level by level (phases within a level run in parallel)
  const results = new Map<string, PhaseResult>();

  for (const level of levels) {
    const executions = level.map((phase) => phase.execute(ctx));
    const levelResults = await Promise.allSettled(executions);

    for (let i = 0; i < level.length; i++) {
      const phase = level[i];
      const result = levelResults[i];

      if (result.status === "fulfilled") {
        results.set(phase.id, result.value);
      } else {
        results.set(phase.id, {
          processed: 0,
          skipped: false,
          skipReason: `FAILED: ${result.reason}`,
        });
        // Non-blocking: log failure, continue with other phases
        // Phases that depend on this one will find missing artifacts and skip/fail gracefully
      }
    }
  }

  return {
    outputDir: ctx.outputDir,
    phases: results,
    totalProcessed: [...results.values()].reduce((sum, r) => sum + r.processed, 0),
  };
}

/**
 * Collect a phase and all its transitive dependencies.
 */
function collectDependencyChain(registry: PhaseRegistry, targetId: string): Phase[] {
  const visited = new Set<string>();
  const result: Phase[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    const phase = registry.get(id);
    for (const dep of phase.dependencies) {
      visit(dep);
    }
    result.push(phase);
  }

  visit(targetId);
  return result;
}

/**
 * Group phases into execution levels.
 * Level N contains phases whose dependencies are ALL in levels < N.
 */
function topologicalLevels(dag: DAG): Phase[][] {
  const levels: Phase[][] = [];
  const placed = new Set<string>();

  while (placed.size < dag.size) {
    const level: Phase[] = [];
    for (const [id, phase] of dag) {
      if (placed.has(id)) continue;
      if (phase.dependencies.every((dep) => placed.has(dep))) {
        level.push(phase);
      }
    }
    if (level.length === 0) throw new Error("Cycle detected in phase DAG");
    for (const phase of level) placed.add(phase.id);
    levels.push(level);
  }

  return levels;
}
```

### CLI Integration

```typescript
/**
 * CLI usage:
 *
 *   reponova build              → runs ALL phases (full DAG)
 *   reponova build --target html → runs html + all its dependencies
 *   reponova run communities    → runs communities + its dependencies only
 *   reponova build --force      → runs all, ignoring caches
 */
```

Each phase is independently invocable. When called standalone, the orchestrator resolves
its dependency chain and executes all required predecessors (unless their artifacts already exist on disk).

---

## 4. Phase Implementations — What Changes

### Communication Between Phases: Filesystem Only

Phases communicate **exclusively through the filesystem**. No in-memory passing.
This is what enables CLI independence — any phase can be run in a separate process.

**Rule: each artifact has exactly one owner. No two phases write the same file.**

| Artifact | Written by | Read by |
|----------|-----------|---------|
| `detected-files.json` | `file-detection` | `graph`, `outlines` |
| `graph-nodes.json` | `graph` | `communities` |
| `graph.json` | `communities` | `community-summaries`, `node-descriptions`, `index`, `embeddings`, `html`, `report` |
| `community_summaries.json` | `community-summaries` | `embeddings`, `html`, `report` |
| `node_descriptions.json` | `node-descriptions` | `embeddings`, `html`, `report` |
| `outlines/**/*.outline.json` | `outlines` | (terminal — MCP server) |
| `vectors/`, `tfidf_idf.json` | `embeddings` | (terminal — MCP server) |
| `graph_search.db` | `index` | (terminal — MCP server) |
| `graph.html`, `graph_communities.html` | `html` | (terminal — user) |
| `report.md` | `report` | (terminal — user) |

### New Intermediate Artifact: `detected-files.json`

Currently file detection is inline in `runPipeline`. It must become a persisted artifact:

```typescript
// New artifact: <output>/detected-files.json
interface DetectedFiles {
  workspace: string;
  code: string[];      // relative paths to code files
  docs: string[];      // relative paths to doc files
  diagrams: string[];  // relative paths to diagram/image files
}
```

### Phase: `file-detection`

**Existing code**: `src/extract/index.ts` — `detectFiles`, `detectDocFiles`, `detectDiagramFiles`

**Changes**:
- Extract into standalone phase
- Write result to `detected-files.json`
- Currently these functions just return arrays — wrap them to persist output

```typescript
const fileDetectionPhase: Phase = {
  id: "file-detection",
  label: "File Detection",
  dependencies: [],

  async execute(ctx) {
    // Reuses: detectFiles, detectDocFiles, detectDiagramFiles from src/extract/index.ts
    const codeFiles = detectFiles(ctx.workspace, ctx.config.build.patterns, ...);
    const docFiles = detectDocFiles(ctx.workspace, ctx.config.build.docs, ...);
    const diagramFiles = detectDiagramFiles(ctx.workspace, ctx.config.build.images, ...);

    const manifest: DetectedFiles = {
      workspace: ctx.workspace,
      code: codeFiles,
      docs: docFiles,
      diagrams: diagramFiles,
    };

    writeFileSync(join(ctx.outputDir, "detected-files.json"), JSON.stringify(manifest));
    return { processed: codeFiles.length + docFiles.length + diagramFiles.length, skipped: false };
  },
};
```

### Phase: `graph`

**Existing code**: `src/extract/index.ts` — `extractAll`, `src/extract/graph-builder.ts` — `buildGraph`, `src/extract/export-json.ts` — `exportJson`

**Changes**:
- Reads `detected-files.json` for file list
- Runs AST extraction (`extractAll`) on all detected files
- Builds graphology graph (`buildGraph`)
- Exports **`graph-nodes.json`** — nodes + edges, no community assignments
- The incremental file-hashing cache (`.cache/hashes.json`, `.cache/extractions/`) remains here — it's internal to this phase

```typescript
const graphPhase: Phase = {
  id: "graph",
  label: "Graph Building",
  dependencies: ["file-detection"],

  async execute(ctx) {
    const detected = readDetectedFiles(ctx.outputDir);
    const allFiles = [...detected.code, ...detected.docs, ...detected.diagrams];

    // (incremental logic lives INSIDE this phase — transparent to orchestrator)
    const extractions = await extractAll(detected.workspace, allFiles);
    const builtGraph = buildGraph({ extractions, ... });

    exportJson({ graph: builtGraph.graph, outputPath: join(ctx.outputDir, "graph-nodes.json"), ... });
    return { processed: builtGraph.stats.nodeCount, skipped: false };
  },
};
```

### Phase: `outlines`

**Existing code**: `src/build/steps/outlines.ts` — `runOutlinesStep`

**Changes**:
- Reads `detected-files.json` for the same file list used by the graph phase
- Current implementation finds files independently — refactor to consume the shared file list
- Internal SHA-256 per-file hashing unchanged (it's internal caching, not inter-phase communication)

```typescript
const outlinesPhase: Phase = {
  id: "outlines",
  label: "Outlines",
  dependencies: ["file-detection"],

  async execute(ctx) {
    const detected = readDetectedFiles(ctx.outputDir);
    // Uses detected.code (same files as graph)
    // Generates tree-sitter outlines per file
    // Existing logic from runOutlinesStep, adapted to read from detected-files.json
    ...
  },
};
```

### Phase: `communities`

**Existing code**: `src/extract/community.ts` — `detectCommunities`

**Changes**:
- Reads `graph-nodes.json` (produced by `graph` phase)
- Loads into graphology, runs Louvain
- Writes **`graph.json`** — the complete graph with community assignments on each node
- This is the canonical graph file that all downstream phases read

```typescript
const communitiesPhase: Phase = {
  id: "communities",
  label: "Community Detection",
  dependencies: ["graph"],

  async execute(ctx) {
    const graphNodesPath = join(ctx.outputDir, "graph-nodes.json");

    // Load graph-nodes.json into graphology
    const graph = loadGraphAsGraphology(graphNodesPath);

    // Run Louvain — reuses detectCommunities from src/extract/community.ts
    const communities = detectCommunities(graph);

    // Write the complete graph.json (nodes + edges + community assignments)
    exportJson({ graph, communities, outputPath: join(ctx.outputDir, "graph.json"), ... });

    return { processed: communities.count, skipped: false };
  },
};
```

### Phase: `community-summaries`

**Existing code**: `src/build/steps/community-summaries-step.ts`, `src/build/intelligence/community-summary-generator.ts`

**Changes**:
- Reads `graph.json` (complete graph with community assignments)
- Produces `community_summaries.json`
- Internal fingerprint caching for incrementality stays within the phase

```typescript
const communitySummariesPhase: Phase = {
  id: "community-summaries",
  label: "Community Summaries",
  dependencies: ["communities"],

  async execute(ctx) {
    // Reuses: CommunitySummaryGenerator from src/build/intelligence/community-summary-generator.ts
    // Reads graph.json → builds community data → generates summaries
    // Writes: community_summaries.json
    ...
  },
};
```

### Phase: `node-descriptions`

**Existing code**: `src/build/steps/node-descriptions-step.ts`, `src/build/intelligence/node-description-generator.ts`

**Changes**:
- Reads `graph.json` (complete graph — uses edges for degree calculation)
- Produces `node_descriptions.json`
- Internal fingerprint cache stays

```typescript
const nodeDescriptionsPhase: Phase = {
  id: "node-descriptions",
  label: "Node Descriptions",
  dependencies: ["communities"],

  async execute(ctx) {
    // Reuses: NodeDescriptionGenerator from src/build/intelligence/node-description-generator.ts
    // Reads graph.json → selects high-degree nodes → generates descriptions
    // Writes: node_descriptions.json
    ...
  },
};
```

### Phase: `index`

**Existing code**: `src/build/steps/indexer.ts` — `runIndexerStep`

**Changes**: Reads `graph.json` (already has community info). Writes `graph_search.db`.

```typescript
const indexPhase: Phase = {
  id: "index",
  label: "Search Index",
  dependencies: ["communities"],

  async execute(ctx) {
    // Reuses: openDatabase, initializeSchema, populateDatabase, saveDatabase from src/core/db.ts
    // Reads graph.json → builds SQLite FTS → writes graph_search.db
    ...
  },
};
```

### Phase: `embeddings`

**Existing code**: `src/build/steps/embeddings-step.ts`, `src/build/intelligence/embeddings.ts`, `src/build/intelligence/tfidf-embeddings.ts`

**Changes**:
- Depends on `community-summaries` and `node-descriptions` (which transitively depend on `communities` and `graph`)
- `composeNodeText` is **enriched** with community summary and node description
- Reads `graph.json` + `community_summaries.json` + `node_descriptions.json`
- Produces `vectors/` and optionally `tfidf_idf.json`

```typescript
const embeddingsPhase: Phase = {
  id: "embeddings",
  label: "Embeddings",
  dependencies: ["community-summaries", "node-descriptions"],

  async execute(ctx) {
    // Reuses: EmbeddingEngine, TfidfEmbeddingEngine, VectorStore
    // CHANGED: composeNodeText now includes community summary + node description in the text
    // Reads: graph.json + community_summaries.json + node_descriptions.json
    // Writes: vectors/, tfidf_idf.json
    ...
  },
};
```

**Key code change** — enriched `composeNodeText`:

```typescript
export function composeNodeText(
  node: NodeEmbeddingInput,
  communitySummary?: string,
  nodeDescription?: string,
): string {
  let text: string;

  switch (node.type) {
    case "function":
    case "method":
      text = `${node.label} ${node.signature ?? ""} ${node.docstring ?? ""}`;
      break;
    case "class":
      text = `${node.label} bases:${(node.bases ?? []).join(",")} ${node.docstring ?? ""}`;
      break;
    case "module":
      text = `${node.source_file ?? node.label} ${node.docstring ?? ""}`;
      break;
    default:
      text = `${node.label} ${node.signature ?? ""} ${node.docstring ?? ""}`;
  }

  // Enrich with semantic context from intelligence layer
  if (nodeDescription) text += ` ${nodeDescription}`;
  if (communitySummary) text += ` context: ${communitySummary}`;

  return text.replace(/\s+/g, " ").trim().slice(0, 512);
}
```

### Phase: `html`

**Existing code**: `src/build/steps/html-step.ts`, `src/extract/export-html.ts`

**Changes**:
- Depends on `community-summaries` and `node-descriptions` (transitively gets `communities` and `graph`)
- Reads `graph.json` + `community_summaries.json` + `node_descriptions.json`
- Loads graph from disk into graphology (no more in-memory passing)

```typescript
const htmlPhase: Phase = {
  id: "html",
  label: "HTML Visualizations",
  dependencies: ["community-summaries", "node-descriptions"],

  async execute(ctx) {
    // Reuses: exportHtml, exportCommunityHtml from src/extract/export-html.ts
    // CHANGED: loads graph from graph.json (not in-memory)
    // CHANGED: annotates nodes with descriptions in tooltips
    // Writes: graph.html, graph_communities.html
    ...
  },
};
```

### Phase: `report`

**Existing code**: `src/build/steps/report.ts` — `generateGraphReport`

**Changes**:
- Depends on `community-summaries` and `node-descriptions`
- Reads `graph.json` + `community_summaries.json` + `node_descriptions.json`

```typescript
const reportPhase: Phase = {
  id: "report",
  label: "Report",
  dependencies: ["community-summaries", "node-descriptions"],

  async execute(ctx) {
    // Reuses: generateGraphReport from src/build/steps/report.ts
    // CHANGED: incorporates node descriptions in god-node section
    // Reads: graph.json + community_summaries.json + node_descriptions.json
    // Writes: report.md
    ...
  },
};
```

---

## 5. New Utility Required: `loadGraphAsGraphology`

Currently the pipeline has:
- `buildGraph()` → produces graphology `Graph`
- `exportJson()` → serializes graphology → JSON file
- `loadGraphData()` → reads a graph JSON into a flat `GraphData` interface (arrays of nodes/edges)

Missing: **JSON → graphology `Graph`** (reverse of `exportJson`).

Required by: `communities` phase (loads `graph-nodes.json` into graphology for Louvain), `html` phase (uses graphology API for degree calculations).

```typescript
/**
 * Load a graph JSON file into a live graphology directed graph.
 * Inverse of exportJson. Works with both graph-nodes.json and graph.json.
 */
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

---

## 6. Codebase Structure

### Deleted (entire files removed)

| File | Why |
|------|-----|
| `src/build/orchestrator.ts` | Replaced by `src/pipeline/orchestrator.ts` |
| `src/build/types.ts` | Replaced by `src/pipeline/phase.ts` |
| `src/build/manifest.ts` | No longer needed — orchestrator tracks results directly |
| `src/build/steps/*.ts` | Logic moves into `src/pipeline/phases/*.ts` |
| `src/extract/index.ts` → `runPipeline` | Monolith function split across `file-detection` + `graph` phases |

### Kept (logic reused inside new phase implementations)

| File | Used by |
|------|---------|
| `src/extract/community.ts` → `detectCommunities` | `communities` phase |
| `src/extract/export-json.ts` → `exportJson` | `graph` phase, `communities` phase |
| `src/extract/export-html.ts` → `exportHtml`, `exportCommunityHtml` | `html` phase |
| `src/extract/graph-builder.ts` → `buildGraph` | `graph` phase |
| `src/extract/parser.ts` | `graph` phase |
| `src/extract/languages/*` | `graph` phase |
| `src/build/intelligence/embeddings.ts` | `embeddings` phase |
| `src/build/intelligence/tfidf-embeddings.ts` | `embeddings` phase |
| `src/build/intelligence/community-summary-generator.ts` | `community-summaries` phase |
| `src/build/intelligence/node-description-generator.ts` | `node-descriptions` phase |
| `src/build/intelligence/llm-engine*.ts` | `community-summaries`, `node-descriptions` phases |
| `src/build/incremental/incremental.ts` | Internal to `graph` phase |
| `src/core/db.ts` | `index` phase |
| `src/core/vector-store.ts` | `embeddings` phase |
| `src/outline/*` | `outlines` phase |

### New Files

| File | Purpose |
|------|---------|
| `src/pipeline/phase.ts` | Core types: `Phase`, `PhaseContext`, `PhaseResult` |
| `src/pipeline/registry.ts` | `PhaseRegistry` implementation |
| `src/pipeline/orchestrator.ts` | Generic DAG orchestrator |
| `src/pipeline/dag.ts` | DAG building, validation, topological sort |
| `src/pipeline/phases/file-detection.ts` | Phase implementation |
| `src/pipeline/phases/graph.ts` | Phase implementation |
| `src/pipeline/phases/outlines.ts` | Phase implementation |
| `src/pipeline/phases/communities.ts` | Phase implementation |
| `src/pipeline/phases/community-summaries.ts` | Phase implementation |
| `src/pipeline/phases/node-descriptions.ts` | Phase implementation |
| `src/pipeline/phases/index-phase.ts` | Phase implementation |
| `src/pipeline/phases/embeddings.ts` | Phase implementation |
| `src/pipeline/phases/html.ts` | Phase implementation |
| `src/pipeline/phases/report.ts` | Phase implementation |
| `src/core/graph-graphology.ts` | `loadGraphAsGraphology` utility |

---

## 7. CLI

```
reponova build [--force] [--config <path>]              → runs full DAG
reponova build --target <phase-id> [--force]            → runs phase + dependencies
reponova build --target html                            → runs: file-detection → graph → communities → community-summaries → node-descriptions → html
reponova build --target embeddings                      → runs: file-detection → graph → communities → community-summaries → node-descriptions → embeddings
reponova build --target index                           → runs: file-detection → graph → communities → index
reponova build --target outlines                        → runs: file-detection → outlines
```

---

## 8. Design Principles

1. **Phases communicate via filesystem only** — no in-memory object passing between phases
2. **Each artifact has exactly one owner** — no two phases write the same file; every file is traceable to the phase that produced it
3. **Two-stage graph** — `graph` phase writes `graph-nodes.json` (nodes + edges); `communities` phase reads it, runs Louvain, writes `graph.json` (complete). All downstream phases read `graph.json`
4. **`detected-files.json`** — shared file list consumed by `graph` and `outlines`
5. **`loadGraphAsGraphology`** — utility for deserializing any graph JSON into a live graphology instance
6. **Enriched embeddings** — `composeNodeText` incorporates community summary + node description into the vector text
7. **Outlines use the same file list** — detected once, consumed by both `graph` and `outlines`
8. **Orchestrator is generic** — knows nothing about phases, only resolves a DAG and executes levels in parallel
9. **Transitive dependency resolution** — phases declare only their direct dependencies; the orchestrator resolves the full chain
