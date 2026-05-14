# Proposal: Intelligent Graph Enrichment

## Context

RepoNova builds a structural knowledge graph via tree-sitter AST parsing. Community detection (Louvain) groups nodes by topological density — purely structural, no semantic awareness. Current LLM-based summaries and descriptions receive only node names and types, producing shallow results.

Graphify demonstrates an alternative: the AI agent itself acts as the LLM, reading files and producing semantically-rich outputs within the IDE session. The same logic can run headlessly via API calls.

This proposal replaces the current weak system (Louvain blind + name-based summaries) with a two-pass intelligent enrichment that works identically in CLI and IDE, differing only in who executes the reasoning.

## The Process

```
tree-sitter AST → structural graph → Louvain (hint, not final)
                                          │
                                          ▼
                              ┌─── Pass 1: Node Descriptions ───┐
                              │                                  │
                              │  For each node:                  │
                              │    Read actual source code        │
                              │    Produce 1-2 sentence summary  │
                              │                                  │
                              │  Output: node_descriptions.json  │
                              └──────────────────────────────────┘
                                          │
                                          ▼
                              ┌─── Pass 2: Community Revision ──┐
                              │                                  │
                              │  Input (single prompt):          │
                              │    ALL node descriptions         │
                              │    Graph edges (calls/imports)   │
                              │    Louvain assignments (hint)    │
                              │                                  │
                              │  LLM evaluates globally:         │
                              │    Validates/splits/merges       │
                              │    Reassigns misplaced nodes     │
                              │    Produces community labels     │
                              │    Produces community summaries  │
                              │                                  │
                              │  Output: revised graph.json      │
                              └──────────────────────────────────┘
                                          │
                                          ▼
                              ┌─── Pass 3: Embeddings (CLI only) ┐
                              │                                   │
                              │  Input: final node descriptions   │
                              │         + community summaries     │
                              │                                   │
                              │  Method: TF-IDF / ONNX / API     │
                              │                                   │
                              │  Output: vectors/                 │
                              └───────────────────────────────────┘
```

## Why Two Passes

Pass 1 compresses source code into dense semantic representations (node descriptions). This makes Pass 2 feasible: 500 nodes × ~100 characters = ~15k tokens — fits in a single prompt.

Without Pass 1, Pass 2 would need the full source code of the entire project in one prompt (impossible). With Pass 1, the LLM can see the whole graph at once and make global decisions about community coherence.

## Pass 1: Node Descriptions

**Input per node**: the actual source code of the symbol (extracted via tree-sitter startLine/endLine).

**Output per node**: a 1-2 sentence semantic description.

```
validate_jwt  →  "Stateless JWT decoder. Verifies signature and expiration, returns decoded claims or raises AuthError."
AuthService   →  "Orchestrates authentication flow. Delegates token creation to TokenManager, credential validation to external identity provider."
```

These descriptions serve two purposes:
1. Final node descriptions in the graph (replaces current name-based descriptions)
2. Compact input for Pass 2 (enables global reasoning without full code)

**Parallelism**: nodes are independent — process in batches.

## Pass 2: Community Revision

**Input (single prompt or few chunks for large graphs)**:
- All node descriptions from Pass 1
- Graph edge list (source → target, edge type)
- Louvain community assignments (as starting suggestion)

**Instructions to the LLM**:
- Evaluate each community for semantic coherence
- Identify misplaced nodes (structurally connected but semantically unrelated)
- Split communities that contain distinct concerns
- Merge communities that represent the same architectural concept
- Produce a label (3-5 words) and summary (1-2 sentences) for each final community

**Output**:
```json
{
  "communities": [
    {
      "id": "0",
      "label": "JWT Authentication Flow",
      "summary": "Handles token creation, validation, and refresh. Stateless verification with Redis-backed revocation list.",
      "nodes": ["AuthService", "validate_jwt", "TokenManager", "refresh_token"]
    },
    {
      "id": "1",
      "label": "HTTP Middleware Stack",
      "summary": "Request/response pipeline: rate limiting, caching, CORS, compression. No business logic.",
      "nodes": ["rate_limiter", "cache_middleware", "cors_handler", "compress_response"]
    }
  ]
}
```

## Pass 3: Embeddings

Runs after Pass 1+2, using final descriptions and summaries as text input.

- Only possible in CLI (embedding models are not available in IDE agents)
- Quality is dramatically better than before: embedding rich semantic text instead of bare symbol names
- TF-IDF (default, free) becomes usable; ONNX (local, 86MB) becomes good

## CLI vs Skill: Same Logic, Different Executor

| | CLI (`reponova enrich`) | Skill (`/reponova enrich`) |
|---|---|---|
| **Pass 1 executor** | LLM provider API (batched calls) | AI agent reads files directly |
| **Pass 2 executor** | LLM provider API (1 call with all summaries) | AI agent reasons over all summaries |
| **Pass 3 executor** | Embedding provider (TF-IDF/ONNX/API) | Not possible in IDE |
| **Works in CI** | ✓ | ✗ |
| **Cost** | API tokens | IDE session tokens |
| **Can ask for more context** | ✗ (fixed prompt) | ✓ (agent decides to read more) |
| **Core logic** | Identical | Identical |

The skill is a natural-language translation of the same process the CLI executes programmatically. Same chunking, same output format, same merge. The agent simply IS the LLM instead of calling one.

## What Changes from Current Architecture

| Current | After |
|---|---|
| Louvain = final community assignments | Louvain = starting hint, LLM revises |
| Node descriptions from names only | Node descriptions from actual source code |
| Community summaries from names only | Community summaries from LLM that revised the communities |
| 3 independent phases (communities, descriptions, summaries) | 2 sequential passes (descriptions → revision) |
| Embeddings on bare names | Embeddings on semantic descriptions |

## Implementation Scope

1. **Pass 1 engine** — reads source code per node, batches prompts, produces descriptions
2. **Pass 2 engine** — composes global prompt, parses revised community output, validates
3. **Merge logic** — integrates revised communities into graph.json
4. **Skill file** — natural-language instructions mirroring the CLI process
5. **Config extension** — `enrich` section in reponova.yml (provider, batch_size, concurrency)
6. **Embeddings remain unchanged** — just receive better input text
