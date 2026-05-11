# Remote LLM & Embedding Providers — Detailed Analysis

## 1. Problem Statement

Community summaries and node descriptions currently rely on a local GGUF model (Qwen 0.5B) via `node-llama-cpp`. With `context_size: 512` and large codebases (280+ node communities), the model degenerates — producing garbage text, repetitive loops, and Chinese characters bleeding in.

The solution: unify all AI provider configuration under a single `providers` registry. Each provider is a self-contained definition (type, model, credentials, parameters). Features reference providers by name only. Supports remote OpenAI-compatible APIs (GitHub Models, OpenAI, self-hosted, Ollama), local GGUF via node-llama-cpp, and local ONNX embeddings.

**No backward compatibility.** The old config schema (`community_summaries.model`, `embeddings.method`, `embeddings.dimensions`, etc.) is replaced entirely.

---

## 2. Current Architecture

### 2.1 LLM Flow

```
reponova.yml
  community_summaries.model: "hf:Qwen/..." | null
  node_descriptions.model:   "hf:Qwen/..." | null
       │
       v
  LlmEnginePool (src/intelligence/llm-engine-pool.ts)
    - Created in build.ts, injected into PhaseContext
    - Deduplicates: if same model URI → shares engine instance
    - Context size promotion: re-creates engine if larger context requested
       │
       v
  LlmEngine (src/intelligence/llm-engine.ts)
    - Wraps node-llama-cpp (optional peer dependency)
    - initialize() → loads GGUF model from HuggingFace
    - generate({ systemPrompt, userPrompt, maxTokens, temperature }) → string | null
    - dispose() → releases native resources
       │
       v
  Generators consume the engine:
    - NodeDescriptionGenerator (src/intelligence/node-description-generator.ts)
    - CommunitySummaryGenerator (src/intelligence/community-summary-generator.ts)
```

### 2.2 Embedding Flow

```
reponova.yml
  embeddings.method: "tfidf" | "onnx"
  embeddings.model: "all-MiniLM-L6-v2"
  embeddings.dimensions: 384
       │
       ├──► TfidfEmbeddingEngine (src/intelligence/tfidf-embeddings.ts)
       │      Feature-hashed TF-IDF, 384-dim hardcoded, no dependencies
       │
       └──► EmbeddingEngine (src/intelligence/embeddings.ts)
              ONNX Runtime + sentence-transformers model
              Optional dep: onnxruntime-node
```

### 2.3 Files Inventory

| File | Role | Will Change |
|------|------|:-----------:|
| `src/shared/types.ts` | `Config`, `ModelsConfig`, `CommunitySummariesConfig`, `NodeDescriptionsConfig`, `EmbeddingsConfig` | **Yes** |
| `src/shared/config.ts` | Zod schema (`ConfigSchema`), `loadConfig()`, `migrateLegacyConfig()` | **Yes** |
| `src/intelligence/llm-engine.ts` | `LlmEngine` class (node-llama-cpp wrapper) | **Rename → `local-llm-engine.ts`** |
| `src/intelligence/llm-engine-pool.ts` | `LlmEnginePool` — deduplicates model instances | **Yes** |
| `src/intelligence/node-description-generator.ts` | `NodeDescriptionGenerator` — consumes `LlmEngine` | **Yes** (interface change) |
| `src/intelligence/community-summary-generator.ts` | `CommunitySummaryGenerator` — consumes `LlmEngine` | **Yes** (interface change) |
| `src/intelligence/embeddings.ts` | `EmbeddingEngine` (ONNX) | **Yes** (dimensions no longer from config) |
| `src/intelligence/tfidf-embeddings.ts` | `TfidfEmbeddingEngine` | **Yes** (dimensions hardcoded, not from config) |
| `src/pipeline/phases/community-summaries.ts` | Phase — acquires LLM from pool | **Yes** (provider resolution) |
| `src/pipeline/phases/node-descriptions.ts` | Phase — acquires LLM from pool | **Yes** (provider resolution) |
| `src/pipeline/phases/embeddings.ts` | Phase — TF-IDF or ONNX | **Yes** (provider-driven routing) |
| `src/pipeline/build.ts` | Creates `LlmEnginePool`, injects into `PhaseContext` | **Yes** (provider registry) |
| `src/pipeline/engine/phase.ts` | `PhaseContext` interface | **Yes** (add provider registry) |
| `src/cli/models.ts` | `reponova models status/download/remove/clear` | **Yes** (provider-aware) |
| `src/index.ts` | Public API exports | **Yes** (export new types) |
| `README.md` | Config reference, Models section | **Yes** |
| `templates/reponova.yml` | Default config template | **Yes** |

### 2.4 New Files

| File | Role |
|------|------|
| `src/intelligence/llm-provider.ts` | `LlmProvider` interface + `EmbeddingProvider` interface |
| `src/intelligence/openai-provider.ts` | OpenAI-compatible provider (chat completions + embeddings) |
| `src/intelligence/provider-registry.ts` | Named provider registry (resolves config → provider instance) |

---

## 3. Proposed Config Schema

### 3.1 Design Principle

`providers` is the **single registry** for all AI backends. Every provider is a self-contained unit with `type`, `model`, and type-specific parameters. Features reference providers by name only.

### 3.2 Provider Types

| `type` | Purpose | Required Fields | Optional Fields |
|--------|---------|-----------------|-----------------|
| `openai` | Remote OpenAI-compatible API | `base_url`, `model` | `api_key`, `timeout` |
| `llama-cpp` | Local GGUF via node-llama-cpp | `model` (hf: URI or path) | `context_size` |
| `onnx` | Local ONNX embedding model | `model` (HuggingFace name) | — |

### 3.3 Full Config Examples

#### All Remote (GitHub Models)

```yaml
providers:
  github-gpt4o:
    type: openai
    base_url: "https://models.github.ai"
    api_key: "env:GITHUB_TOKEN"
    model: "openai/gpt-4o-mini"
    timeout: 30                         # seconds (default: 30)

  github-embed:
    type: openai
    base_url: "https://models.github.ai"
    api_key: "env:GITHUB_TOKEN"
    model: "text-embedding-3-small"

output: ../reponova-out
repos:
  - name: my-project
    path: ..

community_summaries:
  enabled: true
  provider: github-gpt4o

node_descriptions:
  enabled: true
  provider: github-gpt4o
  threshold: 0.5

embeddings:
  enabled: true
  provider: github-embed
  batch_size: 64
```

#### Mixed (Remote LLM + Local Embeddings)

```yaml
providers:
  openai-chat:
    type: openai
    base_url: "https://api.openai.com/v1"
    api_key: "env:OPENAI_API_KEY"
    model: "gpt-4o-mini"

  local-minilm:
    type: onnx
    model: "all-MiniLM-L6-v2"

output: ../reponova-out
repos:
  - name: my-project
    path: ..

community_summaries:
  enabled: true
  provider: openai-chat

node_descriptions:
  enabled: true
  provider: openai-chat
  threshold: 0.8

embeddings:
  enabled: true
  provider: local-minilm
  batch_size: 128
```

#### All Local

```yaml
providers:
  local-qwen:
    type: llama-cpp
    model: "hf:Qwen/Qwen2.5-1.5B-Instruct-GGUF:Q4_K_M"
    context_size: 4096

  local-minilm:
    type: onnx
    model: "all-MiniLM-L6-v2"

output: ../reponova-out
repos:
  - name: my-project
    path: ..

community_summaries:
  enabled: true
  provider: local-qwen

node_descriptions:
  enabled: true
  provider: local-qwen
  threshold: 0.8

embeddings:
  enabled: true
  provider: local-minilm
```

#### Minimal (Zero Config — Algorithmic, No LLM)

```yaml
output: ../reponova-out
repos:
  - name: my-project
    path: ..

# No providers defined — defaults:
#   community_summaries → algorithmic (no LLM)
#   node_descriptions   → algorithmic (no LLM)
#   embeddings          → TF-IDF (no model needed)
```

### 3.4 Routing Logic

#### LLM Features (community_summaries, node_descriptions)

| `provider` field | Provider type | Engine |
|------------------|---------------|--------|
| omitted | — | Algorithmic (no LLM) |
| set → `openai` | Remote | HTTP fetch → `/chat/completions` |
| set → `llama-cpp` | Local | node-llama-cpp |

#### Embeddings

| `provider` field | Provider type | Engine |
|------------------|---------------|--------|
| omitted | — | TF-IDF (hardcoded 384-dim, no deps) |
| set → `openai` | Remote | HTTP fetch → `/embeddings` |
| set → `onnx` | Local | onnxruntime-node |

### 3.5 Global Defaults for Local Providers

```yaml
models:
  cache_dir: ~/.cache/reponova/models    # where GGUF + ONNX models are stored
  gpu: auto                               # auto | cpu | cuda | metal | vulkan
  threads: 0                              # 0 = auto
  download_on_first_use: true             # download model on first build
```

These apply to all `llama-cpp` and `onnx` providers. Individual providers do NOT override these — they're global operational defaults.

---

## 4. TypeScript Types

### 4.1 New Types

```typescript
// src/shared/types.ts

/** Provider type discriminator */
export type ProviderType = "openai" | "llama-cpp" | "onnx";

/** Provider configuration — discriminated by type */
export interface ProviderConfig {
  type: ProviderType;
  /** Model identifier (meaning depends on type) */
  model?: string;
  /** OpenAI-compatible API base URL (type: openai only) */
  base_url?: string;
  /** API key or "env:VAR_NAME" (type: openai only) */
  api_key?: string;
  /** Request timeout in seconds (type: openai only, default: 30) */
  timeout?: number;
  /** Context window size (type: llama-cpp only) */
  context_size?: number;
}
```

### 4.2 Modified Types

```typescript
// src/shared/types.ts

export interface Config {
  output: string;
  repos: RepoConfig[];
  models: ModelsConfig;                          // KEPT — global defaults for local providers
  providers: Record<string, ProviderConfig>;     // NEW — replaces per-feature model/method fields
  patterns: string[];
  exclude: string[];
  exclude_common: boolean;
  incremental: boolean;
  docs: DocsConfig;
  images: ImagesConfig;
  embeddings: EmbeddingsConfig;                  // SIMPLIFIED
  community_summaries: CommunitySummariesConfig;  // SIMPLIFIED
  node_descriptions: NodeDescriptionsConfig;      // SIMPLIFIED
  html: boolean;
  html_min_degree?: number;
  outlines: OutlineConfig;
  server: ServerConfig;
}

export interface CommunitySummariesConfig {
  enabled: boolean;
  max_number: number;
  provider?: string;       // references providers[name]
  // REMOVED: model, context_size
}

export interface NodeDescriptionsConfig {
  enabled: boolean;
  threshold: number;
  provider?: string;       // references providers[name]
  // REMOVED: model, context_size
}

export interface EmbeddingsConfig {
  enabled: boolean;
  provider?: string;       // references providers[name]; omitted = TF-IDF
  batch_size: number;
  // REMOVED: method, model, dimensions
}

export interface ModelsConfig {
  cache_dir: string;
  gpu: "auto" | "cpu" | "cuda" | "metal" | "vulkan";
  threads: number;
  download_on_first_use: boolean;
  // UNCHANGED
}
```

### 4.3 LLM Provider Interface

```typescript
// src/intelligence/llm-provider.ts

export interface LlmCompletionOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Abstract LLM provider contract.
 * Both local (node-llama-cpp) and remote (OpenAI-compatible) implement this.
 */
export interface LlmProvider {
  readonly isAvailable: boolean;
  initialize(): Promise<boolean>;
  generate(options: LlmCompletionOptions): Promise<string | null>;
  dispose(): Promise<void>;
}

/**
 * Abstract embedding provider contract.
 * Both local (ONNX) and remote (OpenAI-compatible) implement this.
 */
export interface EmbeddingProvider {
  readonly isAvailable: boolean;
  initialize(): Promise<boolean>;
  embedBatch(items: Array<{ id: string; text: string }>): Promise<EmbeddingResult[]>;
  dispose(): Promise<void>;
}
```

### 4.4 DEFAULT_CONFIG Changes

```typescript
export const DEFAULT_CONFIG: Config = {
  output: "reponova-out",
  repos: [],
  models: {
    cache_dir: "~/.cache/reponova/models",
    gpu: "auto",
    threads: 0,
    download_on_first_use: true,
  },
  providers: {},                         // NEW — empty = no AI providers
  // ...unchanged fields...
  community_summaries: {
    enabled: true,
    max_number: 0,
    // no provider = algorithmic
  },
  node_descriptions: {
    enabled: true,
    threshold: 0.8,
    // no provider = algorithmic
  },
  embeddings: {
    enabled: true,
    batch_size: 128,
    // no provider = TF-IDF
  },
  // ...rest unchanged...
};
```

---

## 5. Implementation Details

### 5.1 OpenAI Chat Completions Provider

```
POST {base_url}/chat/completions
Authorization: Bearer {api_key}
Content-Type: application/json

{
  "model": "openai/gpt-4o-mini",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user",   "content": "..." }
  ],
  "max_tokens": 150,
  "temperature": 0.5
}
```

Response:
```json
{
  "choices": [
    { "message": { "content": "The generated text..." } }
  ]
}
```

Implementation notes:
- Uses native `fetch()` (Node 18+, no dependencies).
- `initialize()` validates API key is set (resolves `env:VAR_NAME` if needed). Does NOT make a network call.
- `generate()` makes a single POST request per call. Returns `null` on HTTP error (non-throwing).
- `dispose()` is a no-op (no persistent connection).
- Timeout: 30 seconds per request (hardcoded).
- Retry: none — a single failed request returns `null`, generator falls back to algorithmic.

### 5.2 OpenAI Embeddings Provider

```
POST {base_url}/embeddings
Authorization: Bearer {api_key}
Content-Type: application/json

{
  "model": "text-embedding-3-small",
  "input": ["text1", "text2", ...]
}
```

Response:
```json
{
  "data": [
    { "embedding": [0.123, -0.456, ...], "index": 0 },
    { "embedding": [0.789, -0.012, ...], "index": 1 }
  ]
}
```

Implementation notes:
- Batches items according to `embeddings.batch_size`.
- Returns `EmbeddingResult[]` (with `Float32Array` vectors) like the existing engines.
- Dimensions are determined by whatever the API returns — no config, no validation.

### 5.3 API Key Resolution

The `api_key` field supports two formats:

| Format | Behavior |
|--------|----------|
| `"env:GITHUB_TOKEN"` | Reads `process.env.GITHUB_TOKEN` at runtime |
| `"sk-abc123..."` | Uses the literal string as-is |
| omitted | No `Authorization` header sent (for providers like Ollama) |

Resolution happens at provider initialization time, not at config load time. This means:
- Config validation does NOT fail if the env var is missing — only provider initialization does.
- The raw config can be serialized/logged without leaking secrets.

### 5.4 Provider Registry

```typescript
// src/intelligence/provider-registry.ts

export class ProviderRegistry {
  constructor(
    private providers: Record<string, ProviderConfig>,
    private modelsConfig: ModelsConfig,
  ) {}

  /**
   * Acquire an LLM provider for the given provider name.
   * Returns null if provider is not configured or not an LLM-capable type.
   *
   * Routing:
   *   type "openai"    → OpenAiLlmProvider (remote)
   *   type "llama-cpp" → LocalLlmEngine (node-llama-cpp)
   *   name undefined   → null (algorithmic fallback)
   */
  async acquireLlm(providerName?: string): Promise<LlmProvider | null> { ... }

  /**
   * Acquire an embedding provider for the given provider name.
   * Returns null if provider is not configured.
   *
   * Routing:
   *   type "openai" → OpenAiEmbeddingProvider (remote)
   *   type "onnx"   → OnnxEmbeddingProvider (local)
   *   name undefined → null (TF-IDF fallback)
   */
  async acquireEmbedding(providerName?: string): Promise<EmbeddingProvider | null> { ... }

  async disposeAll(): Promise<void> { ... }
}
```

The registry deduplicates internally:
- Same `llama-cpp` model URI → shares engine instance (via existing LlmEnginePool logic)
- Same remote provider name → shares provider instance (stateless HTTP, but avoids duplicate init)
- Same `onnx` model → shares engine instance

### 5.5 LlmEnginePool Changes

The pool becomes an **internal detail** of `ProviderRegistry`. It is only used for `llama-cpp` providers that need memory deduplication (GGUF models loaded in RAM). Remote providers don't need pooling.

The pool's interface changes from `LlmEngine` to `LlmProvider`:
```typescript
// Before
async acquire(modelUri: string, contextSize: number): Promise<LlmEngine | null>

// After
async acquire(modelUri: string, contextSize: number): Promise<LlmProvider | null>
```

### 5.6 Generator Changes

Both `NodeDescriptionGenerator` and `CommunitySummaryGenerator` change their constructor signature:

```typescript
// Before
constructor(config: NodeDescriptionsConfig, llm: LlmEngine | null)

// After
constructor(config: NodeDescriptionsConfig, llm: LlmProvider | null)
```

No logic changes — they call `llm.generate()` and `llm.isAvailable`, which both `LlmEngine` and `LlmProvider` expose identically.

### 5.7 Embeddings Phase Changes

Current routing:
```typescript
if (embConfig.method === "tfidf") {
  result = await generateTfidf(...);
} else {
  result = await generateOnnx(...);
}
```

New routing (provider-driven):
```typescript
const embeddingProvider = await ctx.providerRegistry.acquireEmbedding(embConfig.provider);

if (!embeddingProvider) {
  // No provider configured → TF-IDF fallback
  result = await generateTfidf(...);
} else {
  // Provider handles everything (ONNX local or OpenAI remote)
  result = await generateWithProvider(embeddingProvider, ...);
}
```

`generateWithProvider()` replaces both `generateOnnx()` and the new OpenAI path — the `EmbeddingProvider` interface abstracts the difference. The existing `EmbeddingEngine` (ONNX) is wrapped to implement `EmbeddingProvider`.

### 5.8 TF-IDF Changes

`TfidfEmbeddingEngine` currently reads `dimensions` from `EmbeddingsConfig`. Since `dimensions` is removed from config, it becomes a hardcoded constant:

```typescript
// Before
constructor(config: EmbeddingsConfig) {
  this.dimensions = config.dimensions;
}

// After
private static readonly DIMENSIONS = 384;
constructor() {
  this.dimensions = TfidfEmbeddingEngine.DIMENSIONS;
}
```

### 5.9 ONNX EmbeddingEngine Changes

`EmbeddingEngine` currently reads `dimensions` from config indirectly (hardcoded `EMBEDDING_DIM = 384`). No change needed — it already infers from the model. The class is wrapped in an adapter to implement `EmbeddingProvider`.

### 5.10 PhaseContext Changes

```typescript
// src/pipeline/engine/phase.ts

export interface PhaseContext {
  config: Config;
  configDir: string;
  outputDir: string;
  workspace: string;
  force: boolean;
  manifest: BuildManifest;
  providerRegistry: ProviderRegistry;   // REPLACES llmPool
}
```

`llmPool` is removed from `PhaseContext` — it becomes internal to `ProviderRegistry`.

### 5.11 Build Entry Point Changes

```typescript
// src/pipeline/build.ts (runBuild function)

const providerRegistry = new ProviderRegistry(config.providers, config.models);

const ctx: PhaseContext = {
  config,
  configDir,
  outputDir,
  workspace,
  force: options.force ?? false,
  manifest: new BuildManifest(outputDir),
  providerRegistry,
};

try {
  const result = await orchestrate(registry, ctx, orchestratorOptions);
  // ...
} finally {
  await providerRegistry.disposeAll();
}
```

### 5.12 Community Summaries Phase Changes

```typescript
// Before
const modelUri = csConfig.model ?? null;
let llm = null;
if (modelUri) {
  llm = await ctx.llmPool.acquire(modelUri, csConfig.context_size);
}
const generator = new CommunitySummaryGenerator(csConfig, llm);

// After
const llm = await ctx.providerRegistry.acquireLlm(csConfig.provider);
const generator = new CommunitySummaryGenerator(csConfig, llm);
```

### 5.13 Node Descriptions Phase Changes

Same pattern as community summaries:
```typescript
// Before
const modelUri = ndConfig.model ?? null;
let llm = null;
if (modelUri) {
  llm = await ctx.llmPool.acquire(modelUri, ndConfig.context_size);
}

// After
const llm = await ctx.providerRegistry.acquireLlm(ndConfig.provider);
```

---

## 6. Zod Schema Changes

```typescript
// src/shared/config.ts

const ProviderConfigSchema = z.object({
  type: z.enum(["openai", "llama-cpp", "onnx"]),
  model: z.string().optional(),
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  timeout: z.number().min(1).default(30).optional(),
  context_size: z.number().optional(),
});

const CommunitySummariesConfigSchema = z.object({
  enabled: z.boolean().default(true),
  max_number: z.number().min(0).default(0),
  provider: z.string().optional(),
});

const NodeDescriptionsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  threshold: z.number().min(0).max(1).default(0.8),
  provider: z.string().optional(),
});

const EmbeddingsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().optional(),
  batch_size: z.number().default(128),
});

const ConfigSchema = z.object({
  output: z.string().default("reponova-out"),
  repos: z.array(RepoConfigSchema).default([]),
  models: ModelsConfigSchema.default({}),
  providers: z.record(ProviderConfigSchema).default({}),
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

### 6.1 Post-Parse Validation Rules

After Zod parsing, apply cross-field validations in `loadConfig()`:

1. **Provider reference exists**: If any feature sets `provider: "X"`, `providers.X` must exist. Fail with clear error: `"community_summaries.provider references 'X', but no provider 'X' is defined in providers"`.

2. **Provider type vs feature compatibility**:
   - `community_summaries.provider` / `node_descriptions.provider` → must be `openai` or `llama-cpp` (not `onnx`)
   - `embeddings.provider` → must be `openai` or `onnx` (not `llama-cpp`)
   - Fail with: `"embeddings.provider references 'local-qwen' (type: llama-cpp), but embeddings requires type: openai or onnx"`

3. **Required fields per type**:
   - `openai` → `base_url` required, `model` required
   - `llama-cpp` → `model` required
   - `onnx` → `model` required

---

## 7. CLI Impact

### 7.1 `reponova models status`

New output:
```
── Providers ────────────────────────────────────────────────
  github-gpt4o [openai]
    Model:    openai/gpt-4o-mini
    Endpoint: https://models.github.ai
    API key:  env:GITHUB_TOKEN ✅ Set
    Used by:  community_summaries, node_descriptions

  local-minilm [onnx]
    Model: all-MiniLM-L6-v2  ✅ Downloaded (86.2 MB)
    Used by: embeddings

── Not Used ─────────────────────────────────────────────────
  (none)

── Features ─────────────────────────────────────────────────
  community_summaries: github-gpt4o (openai)
  node_descriptions:   github-gpt4o (openai)
  embeddings:          local-minilm (onnx)

── Cache: ~/.cache/reponova/models (86.2 MB) ────────────────
```

### 7.2 `reponova models download`

- Skips `openai` providers (nothing to download).
- Downloads `llama-cpp` GGUF models and `onnx` models as before.
- Logs: `"github-gpt4o: remote provider (openai) — no download needed"`.

---

## 8. Public API Impact

### 8.1 Exports to Add

```typescript
// src/index.ts

export type { LlmProvider, LlmCompletionOptions, EmbeddingProvider } from "./intelligence/llm-provider.js";
export type { ProviderConfig, ProviderType } from "./shared/types.js";
export { ProviderRegistry } from "./intelligence/provider-registry.js";
```

### 8.2 Breaking Changes

This is a **clean break**. No backward compatibility.

| Change | Impact |
|--------|--------|
| `LlmEngine` → `LocalLlmEngine` | Rename |
| `LlmEngine` export removed from `src/index.ts` | Replaced by `LlmProvider` interface |
| `EmbeddingsConfig.method` removed | Determined by provider type |
| `EmbeddingsConfig.model` removed | Moved to provider |
| `EmbeddingsConfig.dimensions` removed | Inferred at runtime |
| `CommunitySummariesConfig.model` removed | Moved to provider |
| `CommunitySummariesConfig.context_size` removed | Moved to provider (llama-cpp only) |
| `NodeDescriptionsConfig.model` removed | Moved to provider |
| `NodeDescriptionsConfig.context_size` removed | Moved to provider (llama-cpp only) |
| `Config.providers` added | New required field (defaults to `{}`) |
| `PhaseContext.llmPool` removed | Replaced by `providerRegistry` |

---

## 9. Error Handling

### 9.1 Startup Errors (fail fast)

| Scenario | Behavior |
|----------|----------|
| Provider name referenced but not defined | Throw error at `loadConfig()` time |
| Provider type incompatible with feature | Throw error at `loadConfig()` time |
| Provider type `openai` missing `base_url` | Throw error at `loadConfig()` time |
| Provider type `llama-cpp` / `onnx` missing `model` | Throw error at `loadConfig()` time |

### 9.2 Runtime Errors — Chat Completions (graceful degradation, no retry)

| Scenario | Behavior |
|----------|----------|
| API key missing (env var not set) | `initialize()` returns `false`, log warning. Falls back to algorithmic. |
| HTTP 401 (bad key) | `generate()` returns `null`, log warning. No retry. |
| HTTP 429 (rate limit) | `generate()` returns `null`, log warning. No retry. |
| HTTP 5xx (server error) | `generate()` returns `null`, log warning. No retry. |
| Network timeout | `generate()` returns `null`, log warning. No retry. |
| Response malformed | `generate()` returns `null`, log warning. No retry. |
| node-llama-cpp not installed | `initialize()` returns `false`. Falls back to algorithmic. |

Chat completions are one-per-item. A single failure = one node/community falls back to algorithmic description. Low impact, no retry needed.

### 9.3 Runtime Errors — Embeddings (retry on 429 only)

| Scenario | Behavior |
|----------|----------|
| HTTP 429 (rate limit) | **Retry**: 3 attempts, exponential backoff (1s → 2s → 4s). Then fail the batch. |
| HTTP 401, 5xx, timeout, malformed | **No retry**. Fail immediately, log warning, return empty batch. |
| onnxruntime-node not installed | `initialize()` returns `false`. Embeddings phase skipped. |

A single failed embedding batch = 128 nodes without vectors. Semantic search degrades significantly. Retry on 429 is worth it because rate limits are transient — waiting a few seconds resolves them. Other errors (auth, server down, timeout) are not transient, so retrying is pointless.

---

## 10. Incremental Build Impact

### 10.1 Config Hash Changes

The config hash for each phase determines when cache invalidation triggers a full regeneration.

**Community summaries / Node descriptions:**
```typescript
// Before
hashConfigFields(model: string | null, contextSize: number)

// After
hashConfigFields(providerName: string | undefined, providerConfig: ProviderConfig | undefined)
```

Changing the provider (name, type, model, base_url) triggers regeneration. This is correct — different models produce different output.

**Embeddings:**
```typescript
// Before
hashConfigFields(method: string, model: string, dimensions: number)

// After
hashConfigFields(providerName: string | undefined, providerConfig: ProviderConfig | undefined, batchSize: number)
```

Changing the embedding provider triggers full re-embedding. This is correct — different models produce incompatible vector spaces.

---

## 11. Testing Considerations

### 11.1 Unit Tests

- `ProviderRegistry`: routing logic for all type × feature combinations
- `OpenAiLlmProvider`: mock HTTP responses (success, 401, 429, timeout, malformed JSON)
- `OpenAiEmbeddingProvider`: mock HTTP responses, batch splitting, empty results
- API key resolution: `"env:VAR"` → reads env, inline → uses as-is, omitted → no header
- Config validation: all cross-field rules (provider exists, type compatibility, required fields)
- `TfidfEmbeddingEngine`: hardcoded 384-dim (no config dependency)

### 11.2 Integration Tests

- End-to-end build with `openai` provider pointing to a mock HTTP server
- End-to-end build with no providers (algorithmic + TF-IDF defaults)
- End-to-end build with `llama-cpp` provider (if node-llama-cpp available)
- Verify incremental: changing provider triggers regeneration
- Verify fallback to algorithmic when remote provider fails

---

## 12. Implementation Order

| Step | Files | Description |
|------|-------|-------------|
| 1 | `src/intelligence/llm-provider.ts` | Create `LlmProvider` + `EmbeddingProvider` interfaces |
| 2 | `src/intelligence/llm-engine.ts` → `local-llm-engine.ts` | Rename, implement `LlmProvider` |
| 3 | `src/intelligence/openai-provider.ts` | OpenAI-compatible provider (chat + embeddings) |
| 4 | `src/shared/types.ts` | Add `ProviderConfig`, `ProviderType`; simplify `CommunitySummariesConfig`, `NodeDescriptionsConfig`, `EmbeddingsConfig`; update `Config` + `DEFAULT_CONFIG` |
| 5 | `src/shared/config.ts` | Rewrite Zod schemas; add post-parse cross-field validation |
| 6 | `src/intelligence/provider-registry.ts` | Provider resolution + deduplication (wraps LlmEnginePool internally) |
| 7 | `src/intelligence/llm-engine-pool.ts` | Refactor to work with `LlmProvider` interface |
| 8 | `src/intelligence/embeddings.ts` | Wrap `EmbeddingEngine` to implement `EmbeddingProvider`; remove `dimensions` from constructor |
| 9 | `src/intelligence/tfidf-embeddings.ts` | Hardcode 384-dim; remove config dependency from constructor |
| 10 | `src/intelligence/node-description-generator.ts` | `LlmEngine` → `LlmProvider` |
| 11 | `src/intelligence/community-summary-generator.ts` | `LlmEngine` → `LlmProvider` |
| 12 | `src/pipeline/engine/phase.ts` | Replace `llmPool` with `providerRegistry` in `PhaseContext` |
| 13 | `src/pipeline/phases/community-summaries.ts` | Use `providerRegistry.acquireLlm()` |
| 14 | `src/pipeline/phases/node-descriptions.ts` | Use `providerRegistry.acquireLlm()` |
| 15 | `src/pipeline/phases/embeddings.ts` | Provider-driven routing; remove `method` switch |
| 16 | `src/pipeline/build.ts` | Create `ProviderRegistry`; remove direct `LlmEnginePool` |
| 17 | `src/cli/models.ts` | Provider-aware status/download output |
| 18 | `src/index.ts` | Update exports |
| 19 | Tests | Unit + integration |
| 20 | `README.md` | Document providers config, rewrite Models section |
| 21 | `templates/reponova.yml` | New config template with provider examples |

---

## 13. Default Model Strategy

### 13.1 Design Principle

reponova is open-source. The default experience must be:
- **Free** — no subscription, no API key, no account, no model download
- **Offline** — works without internet, always
- **Zero-config** — `reponova build` works out of the box
- **Zero dependencies** — no node-llama-cpp, no onnxruntime-node required

Remote and local AI providers are an **optional upgrade** for users who want richer output. They are never required.

### 13.2 Defaults (No Provider Configured)

| Feature | Default | Output |
|---------|---------|--------|
| community_summaries | Algorithmic | `"280 nodes cluster. Centered around X in path/to/module."` |
| node_descriptions | Algorithmic | `"Function with 12 connections in src/jobs/calcolo.py."` |
| embeddings | TF-IDF | Feature-hashed 384-dim vectors, no model needed |

These defaults produce usable results — not as rich as LLM-generated, but correct and consistent.

### 13.3 Upgrade Path

Users who want better quality configure a provider:

```
Want better descriptions, free, local?
  → Add a llama-cpp provider (Qwen 1.5B–3B, ~1-2GB download)

Want better descriptions, free, local, larger models?
  → Install Ollama, configure openai provider pointing to localhost

Want best quality, willing to pay?
  → Configure openai provider with OpenAI API key
```

---

## 14. Rate Limits & Cost Analysis (Remote Providers)

This section documents rate limits for users who **opt into** remote providers.

### 14.1 Typical Build Workload (motore_documentation — 6 repos, 7K nodes)

| Operation | API Requests | Tokens |
|-----------|---|---|
| Node descriptions | 1,385 | ~277K |
| Community summaries | 220 | ~88K |
| Embeddings (batch 128) | 55 | ~528K |
| **Total** | **1,660** | **~893K** |

### 14.2 GitHub Models

| Tier | RPM | RPD | Builds/day | Verdict |
|---|---|---|---|---|
| Free (Copilot Pro) | 15 | 150 | 0.09 | ❌ Unusable |
| Free (Copilot Enterprise) | 20 | 450 | 0.27 | ❌ Unusable |
| Paid (Microsoft Foundry) | 1,000 | — | 50+ | ✅ But requires Azure billing |

**GitHub Models free tier is not viable** for any non-trivial codebase. 150 requests/day with 1,600+ needed = 11 days per build.

### 14.3 OpenAI

| Tier | Requirement | gpt-4o-mini RPM | TPM | Builds/day | Cost/build |
|---|---|---|---|---|---|
| Tier 1 | $5 spent | 500 | 200K | ~6 | ~$0.08 |
| Tier 2 | $50 + 7d | 5,000 | 2M | unlimited | ~$0.08 |

Embeddings (`text-embedding-3-small`): Tier 1 handles batched embedding easily (55 requests, 528K tokens < 1M TPM).

### 14.4 Ollama (Local, Free)

| Metric | Value |
|---|---|
| Rate limits | **None** |
| Cost | **Free** |
| Requirement | Ollama installed + model pulled |
| Quality (7B model) | Excellent |
| Speed | Depends on hardware (GPU accelerated) |

Ollama is the recommended remote-style provider for users who want better quality without paying. It's OpenAI-compatible, so the same `type: openai` provider works:

```yaml
providers:
  ollama:
    type: openai
    base_url: "http://localhost:11434/v1"
    model: "qwen2.5:7b"
```

### 14.5 Recommendations for README

Document a decision tree for users:

```
Want zero config?
  → Don't set providers. Algorithmic summaries + TF-IDF. Works instantly.

Want better descriptions, free, local?
  → Add a llama-cpp provider (Qwen 1.5B–3B, ~1-2GB download)

Want better descriptions, free, local, larger models?
  → Install Ollama, configure openai provider pointing to localhost

Want best quality, willing to pay?
  → OpenAI Tier 1 ($5 one-time), ~$0.08/build
```

---

## 15. Open Questions

1. **Streaming**: Not implemented. Short outputs (<150 tokens) don't benefit. Revisit later if needed.

2. **Rate limit headers**: React to 429 only (don't proactively read `X-RateLimit-Remaining`). Simpler, sufficient.
