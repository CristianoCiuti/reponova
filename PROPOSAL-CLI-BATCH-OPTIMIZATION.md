# Proposal: CLI Batch Optimization for LLM Calls

## Context

RepoNova's pipeline uses LLM providers (openai, ollama, llama-cpp) for two post-build phases:

- **Node descriptions**: 1 LLM call per high-degree node (sequential loop in `node-description-generator.ts`)
- **Community summaries**: 1 LLM call per community (sequential loop in `community-summary-generator.ts`)

For a project with 100 qualifying nodes and 30 communities, this means 130 sequential HTTP requests. Each request has latency overhead (connection, TTFB, etc.) independent of the actual generation time.

## Goal

Reduce the number of LLM calls by batching multiple items per request, and parallelize the remaining calls for throughput.

## How It Works

### Current

```
100 nodes → 100 sequential calls → ~100 × (latency + generation) = slow
```

### Proposed

```
100 nodes → 7 batch calls (15 items each) → 2 parallel waves (concurrency 4) = fast
```

## Key Design Decisions

1. **Batch prompting.** Instead of asking for one description at a time, pack N items into a single prompt and request a JSON array response.

2. **Configurable batch size.** Exposed in `reponova.yml`:
   ```yaml
   node_descriptions:
     batch_size: 15      # items per LLM call
     concurrency: 4      # parallel calls
   community_summaries:
     batch_size: 5       # communities are more verbose → smaller batches
     concurrency: 3
   ```

3. **Parallel execution.** Independent batches run concurrently using `p-limit` (or similar). Concurrency is capped to respect provider rate limits.

4. **Graceful fallback.** If a batch call fails or returns unparseable JSON, fall back to per-item calls for that batch only. Never lose data.

5. **No interface change to `LlmProvider`.** The batch logic lives in the generators, not the provider. The provider's `generate()` method stays the same — it just receives a larger prompt.

## Implementation

### 1. Node Description Generator (`src/intelligence/node-description-generator.ts`)

Add a `generateWithLlmBatched()` method:
- Chunk nodes into batches of `config.batch_size`
- Compose a batch prompt: list all nodes, ask for JSON array `[{"id": "...", "description": "..."}]`
- Run batches with concurrency limit
- Parse JSON response, match descriptions to node IDs
- On parse failure: retry batch as individual calls

### 2. Community Summary Generator (`src/intelligence/community-summary-generator.ts`)

Same pattern:
- Chunk communities into batches of `config.batch_size`
- Compose batch prompt: list all communities, ask for JSON array `[{"id": "...", "label": "...", "summary": "..."}]`
- Run with concurrency limit
- Parse and match

### 3. Config extension (`src/shared/types.ts`)

```typescript
export interface NodeDescriptionsConfig {
  enabled: boolean;
  threshold: number;
  provider?: string;
  batch_size?: number;   // default: 15
  concurrency?: number;  // default: 4
}

export interface CommunitySummariesConfig {
  enabled: boolean;
  max_number: number;
  provider?: string;
  batch_size?: number;   // default: 5
  concurrency?: number;  // default: 3
}
```

### 4. Dependency

Add `p-limit` (or implement a simple semaphore) for concurrency control.

## Expected Impact

| Metric | Before | After (batch=15, concurrency=4) |
|--------|--------|----------------------------------|
| LLM calls for 100 nodes | 100 | 7 |
| LLM calls for 30 communities | 30 | 6 |
| Wall-clock time (estimated) | ~130 × avg_latency | ~3 waves × avg_latency |
| Token usage | Same (slightly higher from prompt overhead) | Same |

## Risks

- **Truncated responses.** Large batches may exceed `max_tokens`. Mitigation: keep batch size conservative, retry with smaller batch on failure.
- **Parse errors.** LLM may not return valid JSON for batch requests. Mitigation: fallback to per-item on failure.
- **Rate limits.** Parallel calls may hit provider rate limits. Mitigation: configurable concurrency, exponential backoff.
