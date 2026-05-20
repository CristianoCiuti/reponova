# Vector Metadata Design — Option D

## Problem

When `reponova mcp` starts, it can only accept `--graph <path>`. It reads `graph.json → metadata.build_config.embeddings` to learn *that* embeddings exist and *which provider name* was used. But it cannot **re-create the embedding engine** at query time because:

1. **TF-IDF** is self-contained: `tfidf_idf.json` has the full vocabulary → `embedQuery()` works.
2. **ONNX** is NOT self-contained: it needs the full `ProviderConfig` (`type`, `model`) plus `ModelsConfig` (`cache_dir`, `download_on_first_use`) to create an `EmbeddingEngine`.
3. **OpenAI** is NOT self-contained: it needs the full `ProviderConfig` (`type`, `model`, `base_url`, `api_key`, `timeout`).

Currently `similar.ts` only handles case 1 — line 37:
```typescript
if (!embeddingsConfig.provider && existsSync(tfidfIdfPath)) {
  // TF-IDF works → embedQuery available
}
```

When `embeddingsConfig.provider` IS set (e.g., `"local-onnx"`), line 49 returns `true` without initializing any query engine. Then `handleSimilar()` fails because `tfidfEngine` is null.

**Root cause**: The vector artifacts don't carry enough information to bootstrap their own query engine.

---

## Design: Self-Describing Vector Artifacts

### Principle

> "L'informazione sui vettori sia assimilabile ai vettori anche a livello di strutture dati"

Vector metadata lives **inside the vector store**, co-located with the vectors themselves — not in `graph.json`, not in a separate config file.

### Key design decision: reuse `ProviderConfig` structure

The metadata **must** use the same structure as the config file. No invented types — the `provider` field in `_meta.json` is a `ProviderConfig` (or `null` for TF-IDF). This means:

- The MCP server can pass it directly to `ProviderRegistry` — same code path as build time.
- No translation layer, no mapping between "metadata format" and "config format".
- If the config schema evolves, the metadata schema evolves with it (single source of truth: `ProviderConfig`).

### File: `vectors/_meta.json`

Written by the embeddings phase alongside LanceDB data and `vectors.json` sidecar.

**TF-IDF (no provider):**
```jsonc
{
  "provider": null,
  "models": null,
  "dimensions": 384,
  "record_count": 1234,
  "created_at": "2026-05-20T15:33:01.000Z"
}
```

**ONNX (local embeddings):**
```jsonc
{
  "provider": {
    "type": "onnx",
    "model": "all-MiniLM-L6-v2"
  },
  "models": {
    "cache_dir": "~/.cache/reponova/models",
    "download_on_first_use": true
  },
  "dimensions": 384,
  "record_count": 1234,
  "created_at": "2026-05-20T15:33:01.000Z"
}
```

**OpenAI-compatible (remote):**
```jsonc
{
  "provider": {
    "type": "openai",
    "model": "text-embedding-3-small",
    "base_url": "https://api.openai.com/v1",
    "api_key": "${OPENAI_API_KEY}",
    "timeout": 30
  },
  "models": null,
  "dimensions": 1536,
  "record_count": 1234,
  "created_at": "2026-05-20T15:33:01.000Z"
}
```

Note: `api_key` stores the **env var reference** (e.g., `"${OPENAI_API_KEY}"`), never the resolved value. Same convention as `reponova.yml`.

### Why `vectors/_meta.json` (not embedded in vectors.json)

1. **LanceDB users**: They have `vectors/` directory with LanceDB internal files but NO `vectors.json` (the sidecar is a build artifact only). `_meta.json` works for both backends.
2. **Separation of concerns**: Metadata is tiny (~200 bytes) and read once at init. Vector data is huge (MB) and read for search. Separate files = efficient.
3. **Atomic writes**: Can update metadata without rewriting vectors.

---

## Implementation Plan

### Phase 1: Type definition

**File**: `src/shared/types.ts`

No new types invented — reuse existing `ProviderConfig` and `ModelsConfig`:

```typescript
/**
 * Vector store metadata — self-describing artifact.
 * `provider` uses the SAME ProviderConfig structure as reponova.yml.
 * `models` uses a subset of ModelsConfig relevant to query-time bootstrapping.
 */
export interface VectorMeta {
  provider: ProviderConfig | null;  // null = TF-IDF (no external provider)
  models: VectorMetaModels | null;  // null when provider is null or remote
  dimensions: number;
  record_count: number;
  created_at: string;
}

/** Subset of ModelsConfig needed at query time (no GPU/threads — irrelevant for embeddings) */
export interface VectorMetaModels {
  cache_dir: string;
  download_on_first_use: boolean;
}
```

### Phase 2: Write metadata during build

**File**: `src/pipeline/phases/embeddings.ts`

After `storeEmbeddings()` succeeds, write `_meta.json`. The embeddings phase already has access to `ctx.config` which contains the full provider definition and models config:

```typescript
import { writeVectorMeta } from "../../query/vector-meta.js";
import type { VectorMeta } from "../../shared/types.js";

// After storeEmbeddings() returns successfully:
function buildVectorMeta(ctx: PhaseContext, records: VectorRecord[], providerConfig: ProviderConfig | null): VectorMeta {
  return {
    provider: providerConfig,  // direct from config — same structure, same values
    models: providerConfig?.type === "onnx" ? {
      cache_dir: ctx.config.models.cache_dir,
      download_on_first_use: ctx.config.models.download_on_first_use,
    } : null,
    dimensions: records[0]?.vector.length ?? 384,
    record_count: records.length,
    created_at: new Date().toISOString(),
  };
}

// Called after storeEmbeddings:
writeVectorMeta(ctx.outputDir, buildVectorMeta(ctx, records, resolvedProviderConfig));
```

Where `resolvedProviderConfig` is:
- `null` — when no provider configured (TF-IDF fallback)
- The actual `ProviderConfig` object from `ctx.config.providers[embConfig.provider]` — when a provider is set

### Phase 3: Read metadata at MCP init

**File**: `src/mcp/tools/similar.ts`

Replace the current branching logic with metadata-driven initialization. Since `_meta.json` carries a `ProviderConfig`, we can use the same `ProviderRegistry` logic:

```typescript
import { loadVectorMeta } from "../../query/vector-meta.js";
import { OnnxEmbeddingAdapter } from "../../intelligence/embeddings.js";
import { OpenAiEmbeddingProvider } from "../../intelligence/openai-embedding-provider.js";
import { resolveEnvVars } from "../../shared/env.js";
import type { EmbeddingProvider } from "../../intelligence/llm-provider.js";

let embeddingProvider: EmbeddingProvider | null = null;  // ONNX or OpenAI

async function _doInitSimilaritySearch(graphDir: string, embeddingsConfig: EmbeddingsConfig, _cacheDir: string): Promise<boolean> {
  // 1. Load vector store (unchanged)
  vectorStore = new VectorStore(graphDir);
  await vectorStore.initialize();
  const hasData = await vectorStore.loadExisting();
  if (!hasData) { vectorStore = null; return false; }

  // 2. Read vector metadata
  const meta = loadVectorMeta(graphDir);
  if (!meta) {
    // Fallback: legacy behavior (pre-metadata builds)
    return legacyInit(graphDir, embeddingsConfig);
  }

  // 3. Bootstrap query engine from provider config
  if (meta.provider === null) {
    // TF-IDF — same as today
    const engine = new TfidfEmbeddingEngine();
    if (!engine.loadVocabulary(graphDir)) { vectorStore = null; return false; }
    tfidfEngine = engine;
    return true;
  }

  // Provider-based: create embedding provider from the stored ProviderConfig
  const provider = meta.provider;

  if (provider.type === "onnx") {
    const cacheDir = meta.models?.cache_dir ?? "~/.cache/reponova/models";
    const download = meta.models?.download_on_first_use ?? true;
    const adapter = new OnnxEmbeddingAdapter(provider.model!, cacheDir, download);
    const ready = await adapter.initialize();
    if (!ready) { vectorStore = null; return false; }
    embeddingProvider = adapter;
    return true;
  }

  if (provider.type === "openai") {
    const apiKey = resolveEnvVars(provider.api_key ?? "");
    if (!apiKey) {
      log.warn("OpenAI embedding provider requires API key — set the env var referenced in config");
      vectorStore = null;
      return false;
    }
    const instance = new OpenAiEmbeddingProvider({
      baseUrl: provider.base_url!,
      model: provider.model!,
      apiKey,
      timeout: provider.timeout ?? 30,
      batchSize: 1,
    });
    const ready = await instance.initialize();
    if (!ready) { vectorStore = null; return false; }
    embeddingProvider = instance;
    return true;
  }

  // Unknown provider type → can't bootstrap
  return false;
}
```

**`handleSimilar`** — generalize query embedding:

```typescript
// Embed the query using whatever engine is available
let queryVector: number[];
if (tfidfEngine) {
  queryVector = tfidfEngine.embedQuery(query);
} else if (embeddingProvider) {
  const results = await embeddingProvider.embedBatch([{ id: "_q", text: query }]);
  if (!results.length) return errorResult("Failed to embed query");
  queryVector = Array.from(results[0].vector);
} else {
  return errorResult("No query embedding engine available");
}
```

### Phase 4: Helper function for metadata I/O

**File**: `src/query/vector-meta.ts` (new)

```typescript
import { join } from "node:path";
import { readJsonSafe } from "../shared/fs.js";
import { atomicWriteJson } from "../shared/atomic-write.js";
import type { VectorMeta } from "../shared/types.js";

const META_FILENAME = "_meta.json";

export function loadVectorMeta(graphDir: string): VectorMeta | null {
  const path = join(graphDir, "vectors", META_FILENAME);
  return readJsonSafe<VectorMeta>(path);
}

export function writeVectorMeta(graphDir: string, meta: VectorMeta): void {
  const path = join(graphDir, "vectors", META_FILENAME);
  atomicWriteJson(path, meta);
}
```

### Phase 5: Backward compatibility

Builds produced before this change won't have `_meta.json`. The init code falls back to current behavior:

```typescript
function legacyInit(graphDir: string, embeddingsConfig: EmbeddingsConfig): boolean {
  // Exact current logic: check tfidf_idf.json, check provider flag
  const tfidfIdfPath = join(graphDir, "tfidf_idf.json");
  if (!embeddingsConfig.provider && existsSync(tfidfIdfPath)) {
    const engine = new TfidfEmbeddingEngine();
    if (!engine.loadVocabulary(graphDir)) { vectorStore = null; return false; }
    tfidfEngine = engine;
    return true;
  }
  // Non-TF-IDF without metadata → can't bootstrap → fail gracefully
  return false;
}
```

### Phase 6: Cleanup on disable

When `embeddings.enabled = false`, the phase already removes vectors + tfidf_idf.json:

```typescript
removeDirectory(vectorsPath);  // removes entire vectors/ dir (includes _meta.json)
removeFile(tfidfPath);
```

Since `_meta.json` lives inside `vectors/`, the existing `removeDirectory(vectorsPath)` already handles it.

---

## Data Flow (After Implementation)

```
BUILD TIME:
  embeddings phase
    → resolves provider: ctx.config.providers[embConfig.provider] → ProviderConfig | null
    → generates vectors (LanceDB or JSON)
    → writes vectors/_meta.json { provider: ProviderConfig|null, models, dimensions, ... }
    → writes tfidf_idf.json (if provider is null → TF-IDF)

QUERY TIME (MCP):
  similar.ts → loadVectorMeta(graphDir)
    → reads vectors/_meta.json
    → meta.provider === null?
      YES → TF-IDF: loadVocabulary() → embedQuery()
      NO  → meta.provider.type === "onnx"?
        → new OnnxEmbeddingAdapter(meta.provider.model, meta.models.cache_dir, ...)
        → adapter.initialize() → loads ONNX model from cache
        → embedBatch([{query}]) → search vectors → results
```

---

## Test Plan

### Existing tests (must remain green)

- Fase 8 (MCP tools with TF-IDF) — 26/26 should still pass
- Fase 10 (graceful degradation) — 2/2 should still pass
- Fase 13 (incremental embeddings) — should still pass

### New tests (Fase 9 fix verification)

- **9.1 graph_similar with ONNX**: Build with `embeddings.provider: local-onnx`, then MCP query works without config
- **9.2 graph_context with ONNX**: Same — context builder uses ONNX query engine

### Edge cases

- `_meta.json` missing (pre-upgrade build) → falls back to legacy behavior
- `_meta.json` present but model not cached → downloads on first query (if `download_on_first_use: true`)
- Provider type "openai" but env var not set → graceful error message
- Corrupted `_meta.json` → falls back to legacy behavior
- `vectors/` deleted → `_meta.json` gone too (it's inside) — handled naturally

---

## Files to Modify

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `VectorMeta` and `VectorMetaModels` interfaces (reuses existing `ProviderConfig`) |
| `src/query/vector-meta.ts` (new) | `loadVectorMeta()`, `writeVectorMeta()` helpers |
| `src/pipeline/phases/embeddings.ts` | Write `_meta.json` after storing embeddings, resolve provider config from context |
| `src/mcp/tools/similar.ts` | Read `_meta.json`, bootstrap provider via stored `ProviderConfig`, generalize query embedding |
| `src/mcp/tools/context.ts` | Same pattern — read meta, init provider for context queries |

---

## Security Notes

- `api_key` stores the **env var reference** (e.g., `"${OPENAI_API_KEY}"`), never the resolved secret — same convention as `reponova.yml`
- `cache_dir` is stored as-is (may contain `~`) — resolved by `resolveCacheDir()` at runtime
- `_meta.json` is a build artifact in the output directory — same trust model as `graph.json`

---

## Decision Record

| Option | Description | Rejected Because |
|--------|-------------|-----------------|
| A | Extend `graph.json` metadata with full provider config | User explicitly rejected: "non mi va di metterla in graph.json" |
| B | Separate `embeddings-config.json` sidecar in output root | Not co-located with vectors; user wants it "assimilabile ai vettori" |
| C | Store in LanceDB table as a special row | Breaks `VectorRecord` schema; LanceDB has no native table metadata |
| **D** | **`vectors/_meta.json` co-located, reuses `ProviderConfig` structure** | **Selected** — clean, versioned, co-located, same schema as config |
