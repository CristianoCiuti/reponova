# Intelligent Graph Enrichment

## Overview

RepoNova builds a structural knowledge graph via tree-sitter AST parsing. Community detection (Louvain) groups nodes by topological density — purely structural, no semantic awareness. The current system's LLM-based summaries and descriptions receive only node names and types, producing shallow results that fail on projects with non-descriptive naming.

This document describes a complete replacement of the intelligence layer: a multi-step enrichment process that reads actual source code, produces semantic node descriptions, revises community assignments, and generates meaningful summaries. The process runs identically in CLI (via LLM provider API) and IDE (via AI agent skill), differing only in who executes the reasoning.

### Inspiration

Graphify's CLI backend (`graphify extract --backend gemini`) passes actual file content (up to 20k chars/file) to the LLM, chunked by token budget (~60k tokens/chunk), packed by directory, with adaptive bisection retry on truncation and parallel execution via ThreadPoolExecutor. This pattern is directly applicable to RepoNova's enrichment.

### Design Principles

1. **Louvain as hint, not gospel.** Structural clustering is a starting point. Semantic review refines it.
2. **Don't waste LLM on obvious nodes.** 80-90% of Louvain assignments are correct. Pre-filter algorithmically, send only ambiguous nodes to the LLM.
3. **Compress before reasoning globally.** Source code → compact descriptions (Step 1), then descriptions enable global reasoning (Steps 2-4) without sending full code again.
4. **Same process, two executors.** CLI and skill share logic, output format, intermediate files, and cache. Only the LLM executor differs.
5. **`graph.json` is immutable.** The Louvain output is never overwritten. Enrichment writes `graph-enriched.json`. This enables clean cache invalidation.
6. **Strict separation: LLM = reasoning, CLI = data manipulation.** The LLM never manipulates large files. It writes only small decision files. All large file operations (applying decisions to graph, assembling final outputs) are deterministic CLI commands.
7. **Every step writes physical files.** No in-memory passing between steps. All intermediate state lives on disk in `.enrich/`. This enables resumption after interruption and keeps agent context usage minimal.
8. **Parallel workers never share files.** Each parallel batch writes its own file. A CLI merge command assembles them into the step's final output.

---

## Pipeline Architecture

### Unified DAG (single topology, two modes)

```
Level 0:  file-detection
              │
Level 1:  graph ─────────── outlines              [parallel]
              │
Level 2:  communities
              │
Level 3:  enrich                                  [always present in DAG]
              │
Level 4:  search-index ── embeddings ── html ── report    [parallel]
```

The `enrich` phase always exists in the DAG. No conditional branching. Internally it switches behavior:

- **With provider configured**: Steps 0-7 (intelligent enrichment via LLM)
- **Without provider**: algorithmic node-descriptions + community-summaries (identical to current behavior)

Both modes produce the same output files in the same format. Downstream phases are unaware of which mode ran.

### What was removed

The `community-summaries` and `node-descriptions` phases no longer exist as separate DAG phases. Their logic is absorbed into the `enrich` phase (algorithmic mode reuses the same code internally).

### Output File Contract

| File | Written by | Read by | Mutability |
|------|-----------|---------|------------|
| `graph-nodes.json` | graph phase | communities phase | Immutable after graph phase |
| `graph.json` | communities phase | enrich phase (as input) | **Immutable after communities phase** |
| `graph-enriched.json` | enrich phase (via `enrich:finalize`) | search-index, embeddings, html, report | Overwritten each enrich run |
| `node_descriptions.json` | enrich phase (via `enrich:finalize`) | embeddings, html, report | Overwritten each enrich run |
| `community_summaries.json` | enrich phase (via `enrich:finalize`) | embeddings, html, report | Overwritten each enrich run |

`graph-enriched.json` is ALWAYS produced by the enrich phase, even in algorithmic mode (where it's a byte-for-byte copy of `graph.json`). Downstream phases always read `graph-enriched.json` — never `graph.json` directly. This eliminates all conditional logic in downstream phases.

---

## Separation of Concerns: LLM vs CLI

The LLM (whether provider API or IDE agent) does ONLY reasoning. It reads data and writes small decision files. It NEVER:
- Manipulates large graph JSON files
- Applies routing decisions to node lists
- Assembles final output files
- Computes graph metrics
- Merges batch outputs

All of these are deterministic operations executed by CLI commands.

| Responsibility | Executor | Why |
|----------------|----------|-----|
| Compute graph metrics | CLI (`enrich:metrics`) | Algorithmic, no reasoning needed |
| Produce node descriptions | LLM | Requires understanding source code |
| Produce community profiles | LLM | Requires semantic evaluation |
| Route candidates between communities | LLM | Requires judgment |
| Propose merge/split | LLM | Requires global reasoning |
| Apply decisions to graph | CLI (`enrich:apply`) | Deterministic loop on arrays |
| Regenerate modified profiles | LLM | Requires semantic evaluation |
| Assemble final output files | CLI (`enrich:finalize`) | Deterministic file assembly |
| Merge parallel batch outputs | CLI (`enrich:merge`) | Deterministic file concatenation |

---

## Intermediate Files: `.enrich/` Directory

All enrichment state lives in `.enrich/` inside the output directory. Every step writes to this directory. The final step (`enrich:finalize`) reads from it and writes the canonical output files.

### Structure

```
.enrich/
├── candidates.json                         ← Step 0 output
├── edge-density.json                       ← Step 0 output
│
├── descriptions/                           ← Step 1 batch outputs (parallel)
│   ├── batch-001.json
│   ├── batch-002.json
│   └── batch-NNN.json
├── descriptions.json                       ← Step 1 FINAL (merged from batch files)
│
├── profiles/                               ← Step 2 batch outputs (parallel)
│   ├── community-000.json
│   ├── community-001.json
│   └── community-NNN.json
├── profiles.json                           ← Step 2 FINAL (merged from batch files)
│
├── routing/                                ← Step 3 batch outputs (parallel)
│   ├── batch-001.json
│   ├── batch-002.json
│   └── batch-NNN.json
├── routing.json                            ← Step 3 FINAL (merged from batch files)
│
├── restructure.json                        ← Step 4 output (single file, no batching)
│
├── graph-applied.json                      ← Step 5 output
├── modified-communities.json               ← Step 5 output
│
├── updated-profiles/                       ← Step 6 batch outputs (parallel)
│   ├── community-003.json
│   ├── community-007.json
│   └── community-NNN.json
└── updated-profiles.json                   ← Step 6 FINAL (merged from batch files)
```

### Rules

1. **Final file exists = step completed.** If `.enrich/descriptions.json` exists, Step 1 is done.
2. **Final file missing = redo entire step.** No partial resumption within a step. If the step was interrupted mid-batch, all batches are re-executed on retry.
3. **Batch files are ephemeral.** Once the final merged file is produced, batch files are no longer needed (kept for debugging, can be cleaned).
4. **`graph.json` hash changed = invalidate all.** If `sha256(graph.json)` differs from `.cache/enrich-input-hash.txt` (or hash file is missing), the entire `.enrich/` directory is deleted and enrichment restarts from Step 0.

---

## Enrichment Steps (Intelligent Mode)

### Step 0: Graph Metrics — `reponova enrich:metrics`

**Type**: CLI command (algorithmic, no LLM)
**Input**: `graph.json`
**Output**: `.enrich/candidates.json`, `.enrich/edge-density.json`

Computes per-node metrics to identify which nodes need LLM review:

```
boundary_ratio = edges_outside_community / total_edges

  < threshold (default 0.3) → STABLE
  >= threshold              → CANDIDATE
```

Additional signals:
- **Modularity contribution**: nodes that worsen their community's internal modularity score
- **Internal vs external degree**: absolute count of connections inside vs outside
- **Community size outliers**: communities that are abnormally large (potential split candidates)

Also computes inter-community edge density matrix (stored in `edge-density.json`) for use by Step 4.

Typically ~15-20% of nodes are classified as CANDIDATE.

**Cost**: zero LLM calls, sub-second computation.

---

### Step 1: Node Descriptions — LLM (batched, parallel)

**Type**: LLM reasoning
**Input**: source code of ALL nodes (read from disk via tree-sitter startLine/endLine)
**Output**: `.enrich/descriptions/batch-NNN.json` (one per batch)
**Then**: `reponova enrich:merge descriptions` → `.enrich/descriptions.json`

For every node (both STABLE and CANDIDATE): extract actual source code, send to LLM, receive a 1-2 sentence semantic description.

```
validate_jwt  →  "Stateless JWT decoder. Verifies signature and expiration, returns decoded claims or raises AuthError."
AuthService   →  "Orchestrates authentication flow. Delegates token creation to TokenManager, credential validation to external identity provider."
rate_limiter  →  "Redis-based sliding window rate limiter. Tracks requests per IP, returns 429 when threshold exceeded."
```

**Why ALL nodes, not just candidates?**
1. Step 2 needs descriptions of all community members to profile the community
2. Descriptions are the final artifact for node descriptions in the graph
3. Descriptions are the input text for embeddings

**Batching strategy** (modeled on graphify's `_pack_chunks_by_tokens`):
- Group nodes by source file / directory (related code in same prompt → better cross-reference)
- Pack batches by token budget (default 40k tokens/batch)
- Each file's content is capped at 20k characters (same as graphify)
- Multiple nodes per call: "Here are N symbols with their code. Describe each in 1-2 sentences."

**Parallel execution**: each batch writes its own file (`batch-001.json`, `batch-002.json`, ...). Workers never share files. After all batches complete, CLI merges them.

**Adaptive retry**: if a batch response is truncated (`finish_reason="length"`) or the API rejects it as too large, bisect the batch and retry each half. Recursion capped at `max_retry_depth` (default 3 → max 8x expansion).

**Example prompt (1 batch)**:
```
System: "For each symbol below, write a 1-2 sentence description of what it does
architecturally. Focus on role, responsibilities, and key behaviors. Output as
JSON array: [{"id": "qualified_name", "description": "..."}]"

User:
=== src/auth/service.py (AuthService, lines 15-48) ===
class AuthService:
    def __init__(self, token_mgr: TokenManager):
        self.token_mgr = token_mgr
    def authenticate(self, credentials: dict) -> Session:
        token = self.token_mgr.create(credentials["user_id"])
        return Session(token=token, user=credentials["user_id"])

=== src/auth/jwt.py (validate_jwt, lines 5-22) ===
def validate_jwt(token: str) -> Claims:
    """Validate JWT and return decoded claims."""
    try:
        return jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise AuthError("Token expired")

[... more symbols ...]
```

**Stats (8000 nodes)**: ~130 batches × 4 workers.

---

### Step 2: Community Profiling — LLM (parallel, 1 call per community)

**Type**: LLM reasoning
**Input**: `.enrich/descriptions.json` + edges from `graph.json`
**Output**: `.enrich/profiles/community-NNN.json` (one per community)
**Then**: `reponova enrich:merge profiles` → `.enrich/profiles.json`

For each community: collect all its member descriptions + internal edge list → ask LLM to produce a compact profile and flag nodes that seem out of place.

**Output per community**:
- Label (3-5 words): `"JWT Authentication Flow"`
- Profile (30-50 words): `"Handles token creation, validation, and refresh. Stateless JWT verification with Redis-backed token revocation. Delegates credential checking to external identity provider. No direct HTTP awareness."`
- Misfits: nodes the LLM considers semantically out of place (added to candidate list for Step 3)

**Why profiles exist**: they are compact representations (~50 words each) that enable Steps 3 and 4 to reason globally without needing full code or even full descriptions. 100 profiles × 50 words = ~7k tokens — fits trivially in any prompt.

**Example prompt**:
```
This community contains 35 nodes:

Nodes:
- AuthService: "Orchestrates authentication flow. Delegates token creation to TokenManager..."
- validate_jwt: "Stateless JWT decoder. Verifies signature and expiration..."
- rate_limiter: "Redis-based sliding window rate limiter. Tracks requests per IP..."
- TokenManager: "Creates and refreshes JWT tokens. Handles key rotation..."
[...]

Internal edges:
- AuthService → validate_jwt (calls)
- AuthService → TokenManager (imports_from)
- login_handler → AuthService (calls)

Provide:
1. Label (3-5 words naming the community's purpose)
2. Profile (30-50 words describing architectural role)
3. Misfits (nodes that don't belong here, with reason)
```

**Parallel execution**: each community writes its own file. CLI merges after all complete.

**Stats (100 communities)**: 100 files × 4 workers, ~5k tokens each.

---

### Step 3: Candidate Routing — LLM (batched, parallel)

**Type**: LLM reasoning
**Input**: `.enrich/candidates.json` + `.enrich/profiles.json` + `.enrich/descriptions.json`
**Output**: `.enrich/routing/batch-NNN.json` (one per batch)
**Then**: `reponova enrich:merge routing` → `.enrich/routing.json`

For each candidate node: provide its description, its current community's profile, and the profiles of adjacent communities (those it has edges into, max 5). Ask: "where does this belong?"

**Process**:
1. Merge candidate lists: algorithmic (Step 0) + LLM-flagged misfits (Step 2)
2. Deduplicate
3. For each candidate, identify adjacent communities by edge count
4. Batch ~30 candidates per prompt
5. Ask for routing decision per node

**Example prompt (1 batch)**:
```
Community profiles (reference):
- Community 3 "JWT Authentication Flow": "Handles token creation, validation..."
- Community 7 "HTTP Middleware Stack": "Request/response pipeline: rate limiting..."
- Community 12 "Redis Infrastructure": "Connection pooling, pub/sub, cache management..."

For each node below, decide: STAY in current community or MOVE to a better fit.
Output JSON array: [{"node": "...", "action": "stay|move", "to": "...", "reason": "..."}]

1. rate_limiter (current: Community 3 "JWT Authentication Flow")
   Description: "Redis-based sliding window rate limiter. Tracks requests per IP..."
   Adjacent communities: 7 (3 edges), 12 (2 edges)

2. cors_handler (current: Community 3 "JWT Authentication Flow")
   Description: "Sets CORS headers based on origin whitelist. No auth awareness..."
   Adjacent communities: 7 (4 edges), 15 (1 edge)

[... 28 more candidates ...]
```

**Output per batch**:
```json
[
  {"node": "rate_limiter", "action": "move", "to": "7", "reason": "HTTP infrastructure, not auth"},
  {"node": "cors_handler", "action": "move", "to": "7", "reason": "HTTP middleware, not auth"},
  {"node": "validate_jwt", "action": "stay", "reason": "Core auth functionality"}
]
```

**Parallel execution**: each batch writes its own file. CLI merges after all complete.

**Stats (1500 candidates)**: ~50 batches × 4 workers, ~15k tokens each.

---

### Step 4: Merge/Split Detection — LLM (sequential)

**Type**: LLM reasoning
**Input**: `.enrich/profiles.json` + `.enrich/edge-density.json` + `.enrich/routing.json`
**Output**: `.enrich/restructure.json` (single file, no batching needed)

Global-level reasoning using only compact profiles (not code, not full descriptions).

**Input (single prompt, ~10k tokens)**:
- ALL community profiles (100 × 50 words = ~7k tokens)
- Inter-community edge density pairs (communities with many cross-edges)
- Routing summary: communities that gained or lost many nodes in Step 3
- Size outliers: communities flagged as too large from Step 0

**Example prompt**:
```
Communities (100 total):
 0: "API Route Handlers" (45 nodes) — "HTTP endpoint definitions. Dispatches to service layer..."
 1: "Request Validation" (12 nodes) — "Schema validation. JSON/XML input parsing..."
 2: "Response Serialization" (8 nodes) — "JSON/XML output formatting..."
 [... 97 more ...]

High cross-edge density pairs:
 1 ↔ 2: 15 edges (validation ↔ serialization)
 5 ↔ 7: 22 edges (both infrastructure)

Communities that gained >5 nodes from routing:
 7 "HTTP Middleware Stack": gained 8 nodes from communities 3, 5

Propose merges (communities that should be combined) and splits (communities too large or incoherent).
```

**Output**:
```json
{
  "merges": [
    {"communities": ["1", "2"], "new_label": "Request/Response Schema", "reason": "Tightly coupled, same concern"}
  ],
  "splits": [
    {"community": "0", "reason": "Mixes public API and internal admin endpoints", "into": [
      {"label": "Public API Endpoints", "nodes": ["..."]},
      {"label": "Internal Admin Endpoints", "nodes": ["..."]}
    ]}
  ]
}
```

**Stats**: 1-3 calls, ~10k tokens each. Sequential (needs global view).

**For very large graphs (200+ communities)**: if profiles exceed context, group adjacent communities into macro-clusters and run per macro-cluster + final cross-cluster reconciliation.

---

### Step 5: Apply Decisions — `reponova enrich:apply`

**Type**: CLI command (algorithmic, no LLM)
**Input**: `graph.json` + `.enrich/routing.json` + `.enrich/restructure.json`
**Output**: `.enrich/graph-applied.json`, `.enrich/modified-communities.json`

Deterministic application of all decisions:

1. Load `graph.json` (Louvain assignments)
2. For each routing decision with `action: "move"`: update node's `community` attribute
3. For each merge instruction: all nodes in merged communities get the new community ID
4. For each split instruction: specified nodes get their new community ID
5. Recompute community membership lists
6. Write `graph-applied.json` (full graph with revised community assignments)
7. Write `modified-communities.json` (list of community IDs that were created, merged, or had nodes added/removed — needed by Step 6)

This is a loop over arrays. No LLM, no reasoning. Instant.

---

### Step 6: Regenerate Modified Profiles — LLM (parallel)

**Type**: LLM reasoning
**Input**: `.enrich/modified-communities.json` + `.enrich/descriptions.json` + `.enrich/graph-applied.json`
**Output**: `.enrich/updated-profiles/community-NNN.json` (one per modified community)
**Then**: `reponova enrich:merge updated-profiles` → `.enrich/updated-profiles.json`

Only communities that changed (received/lost nodes, created from split, created from merge) need new profiles. Unchanged communities keep their Step 2 profiles.

Same prompt format as Step 2, but only for modified communities.

**Stats**: ~10-20 calls (only modified communities) × 4 workers.

---

### Step 7: Finalize — `reponova enrich:finalize`

**Type**: CLI command (algorithmic, no LLM)
**Input**: `.enrich/graph-applied.json` + `.enrich/descriptions.json` + `.enrich/profiles.json` + `.enrich/updated-profiles.json`
**Output**: `graph-enriched.json`, `node_descriptions.json`, `community_summaries.json`

Assembles final output files:

1. Copy `.enrich/graph-applied.json` → `graph-enriched.json`
2. Copy `.enrich/descriptions.json` → `node_descriptions.json` (reformatted to match expected schema)
3. Merge `.enrich/profiles.json` + `.enrich/updated-profiles.json` (updated profiles override originals for modified communities) → `community_summaries.json`

Deterministic file assembly. No LLM. Instant.

---

## Algorithmic Mode (No Provider)

When no `enrich.provider` is configured, the enrich phase runs in algorithmic mode:

1. Read `graph.json`
2. Generate algorithmic node descriptions (same logic as current `node-descriptions` phase — name + type + edges)
3. Generate algorithmic community summaries (same logic as current `community-summaries` phase — hub names + path)
4. Copy `graph.json` → `graph-enriched.json` (byte-for-byte, no modifications)
5. Write `node_descriptions.json`
6. Write `community_summaries.json`

No `.enrich/` directory is created. No intermediate files. Behavior is identical to the current pipeline. Zero regression.

---

## Embeddings (Downstream, Separate Phase)

Embeddings are NOT part of the enrich phase. They run as a separate phase at Level 4, reading the final enriched outputs.

**Input**: `graph-enriched.json` + `node_descriptions.json` + `community_summaries.json`
**Method**: TF-IDF (default, free) / ONNX (local, 86MB) / API provider
**Output**: `vectors/`

**Why separate**: embeddings require specialized encoder models that are not available in IDE agent sessions. They run only in CLI.

**Quality improvement**: embedding `"Stateless JWT decoder. Verifies signature and expiration."` vs embedding `"validate_jwt"` produces dramatically better semantic similarity results.

---

## CLI Commands

### Existing (modified)

#### `reponova build`

Unchanged invocation. The DAG now includes `enrich` at Level 3. Downstream phases read `graph-enriched.json`.

```bash
reponova build                        # full pipeline (includes enrich)
reponova build --target communities   # up to and including communities
reponova build --target enrich        # up to and including enrich
reponova build --force                # ignore all caches
```

#### `reponova build --start-after <phase>` (NEW flag)

Run only phases downstream of the specified phase. Does NOT run the phase itself or anything upstream. Assumes outputs exist on disk.

```bash
reponova build --start-after enrich
# Executes: search-index, embeddings, html, report
# Assumes: graph-enriched.json, node_descriptions.json, community_summaries.json exist
```

### New commands: `enrich:*` subcommands

#### `reponova enrich:metrics`

Compute graph metrics and candidate classification.

```bash
reponova enrich:metrics
# Input:  graph.json
# Output: .enrich/candidates.json, .enrich/edge-density.json
```

If `.enrich/` already exists, compares `sha256(graph.json)` against `.cache/enrich-input-hash.txt`. If different (or hash file missing), deletes the entire `.enrich/` directory first (full invalidation — graph structure changed, all intermediate results are stale).

#### `reponova enrich:merge <step_name>`

Merge batch output files into the step's final file.

```bash
reponova enrich:merge descriptions
# Reads:  .enrich/descriptions/batch-*.json
# Writes: .enrich/descriptions.json

reponova enrich:merge profiles
# Reads:  .enrich/profiles/community-*.json
# Writes: .enrich/profiles.json

reponova enrich:merge routing
# Reads:  .enrich/routing/batch-*.json
# Writes: .enrich/routing.json

reponova enrich:merge updated-profiles
# Reads:  .enrich/updated-profiles/community-*.json
# Writes: .enrich/updated-profiles.json
```

Deterministic concatenation/merge of batch files into a single consolidated file.

#### `reponova enrich:apply`

Apply routing and restructuring decisions to produce the revised graph.

```bash
reponova enrich:apply
# Input:  graph.json + .enrich/routing.json + .enrich/restructure.json
# Output: .enrich/graph-applied.json, .enrich/modified-communities.json
```

#### `reponova enrich:finalize`

Assemble final output files from intermediate state.

```bash
reponova enrich:finalize
# Input:  .enrich/graph-applied.json + .enrich/descriptions.json
#         + .enrich/profiles.json + .enrich/updated-profiles.json
# Output: graph-enriched.json, node_descriptions.json, community_summaries.json
```

#### `reponova enrich` (all-in-one, CLI with provider)

Runs the full enrichment pipeline using the configured LLM provider. Orchestrates all steps internally:

```bash
reponova enrich
# Equivalent to running all steps in sequence:
#   enrich:metrics → Step 1 (LLM) → enrich:merge descriptions
#   → Step 2 (LLM) → enrich:merge profiles
#   → Step 3 (LLM) → enrich:merge routing
#   → Step 4 (LLM) → enrich:apply
#   → Step 6 (LLM) → enrich:merge updated-profiles
#   → enrich:finalize
#   → cache --target enrich                    ← FINAL ACTION: seals the cache
```

Handles resumption: checks which final files already exist in `.enrich/` and skips completed steps.

**Cache seal is AUTOMATIC**: after `enrich:finalize` succeeds, the command calls the equivalent of `cache --target enrich` internally. This is the last action the command performs.

### Cache commands

#### `reponova cache --check <phase>`

Check whether a phase's cache is valid. Returns exit code 0 if the phase can be skipped, exit code 1 if it needs to re-run.

#### `reponova cache --target <phase>`

Seal the cache for a phase. Records the current state of its inputs so that future `--check` calls can determine staleness.

**In `reponova build`**: every phase calls `cache --target` internally after completing successfully.
**In skill mode**: the agent MUST call `cache --target` explicitly for the enrich phase after `enrich:finalize`.

---

#### `cache --check file-detection` / `cache --target file-detection`

```
cache --check file-detection:
  Always exit 1.
  Rationale: input is the filesystem itself. No hash can substitute a directory walk.
  The cost of checking == cost of running. Phase always runs.

cache --target file-detection:
  No-op (nothing to seal).
  The phase has no cacheable input signal.
```

---

#### `cache --check graph` / `cache --target graph`

```
cache --check graph:
  Exit 0 if ALL true:
    - graph-nodes.json exists
    - .cache/graph-input-hash.txt exists
    - sha256(detected-files.json) == content of .cache/graph-input-hash.txt
  Exit 1 otherwise.

  Note: this checks if the FILE LIST changed. Per-file content changes
  are handled by the phase's internal incremental logic (hashes.json).
  If the file list is the same, graph-nodes.json structure is unchanged
  (same files → same symbols → same graph). Content-level changes only
  affect extractions, which the phase handles incrementally.

cache --target graph:
  Writes .cache/graph-input-hash.txt ← sha256(detected-files.json)
  (hashes.json and extractions/ are written by the phase internally as part of incremental logic)
```

---

#### `cache --check outlines` / `cache --target outlines`

```
cache --check outlines:
  Exit 0 if ALL true:
    - outlines/ directory exists and is non-empty
    - .cache/outlines-input-hash.txt exists
    - sha256(detected-files.json) == content of .cache/outlines-input-hash.txt
    - .cache/outlines-config-hash.txt exists
    - sha256(outlines config: { enabled }) == content of .cache/outlines-config-hash.txt
  Exit 1 otherwise.

  Note: like graph, this checks file list stability. Per-file content changes
  are handled by the phase's internal incremental logic (outline-hashes.json).

cache --target outlines:
  Writes .cache/outlines-input-hash.txt  ← sha256(detected-files.json)
  Writes .cache/outlines-config-hash.txt ← sha256(outlines config)
```

---

#### `cache --check communities` / `cache --target communities`

```
cache --check communities:
  Exit 0 if ALL true:
    - graph.json exists
    - .cache/graph-nodes-hash.txt exists
    - sha256(graph-nodes.json) == content of .cache/graph-nodes-hash.txt
  Exit 1 otherwise.

cache --target communities:
  Writes .cache/graph-nodes-hash.txt ← sha256(graph-nodes.json)
```

---

#### `build --check enrich` / `cache --target enrich`

```
build --check enrich:
  Exit 0 if ALL true:
    - All inputs available (graph.json from communities phase)
    - Incremental enabled
    - All outputs exist (graph-enriched.json, node_descriptions.json, community_summaries.json)
    - Cache seal fresh (input hashes + config hash match sealed values)
  Exit 1 otherwise (prints reason: "inputs unavailable", "outputs missing", "never sealed", "input changed", "config changed", "incremental disabled").

  Config hash includes: { provider, candidate_threshold, description_batch_tokens,
  routing_batch_size, concurrency, max_retry_depth, enabled }

cache --target enrich:
  Precondition (FAILS if not met):
    - graph-enriched.json must exist
    - node_descriptions.json must exist
    - community_summaries.json must exist
  Writes .cache/enrich-input-hash.txt  ← sha256(graph.json)
  Writes .cache/enrich-config-hash.txt ← sha256(enrich config)
```

**WHO calls `cache --target enrich`:**

| Mode | When | How |
|------|------|-----|
| CLI `reponova build` | After enrich phase completes | Automatic (internal) |
| CLI `reponova enrich` | After `enrich:finalize` | Automatic (final action) |
| Skill (IDE agent) | After `enrich:finalize` succeeds | **EXPLICIT** — agent MUST call `$ reponova cache --target enrich` |

**Forgetting `cache --target enrich` in skill mode → next `build --check enrich` returns exit 1 → unnecessary re-enrichment.**

---

#### `cache --check index` / `cache --target index`

```
cache --check index:
  Exit 0 if ALL true:
    - graph_search.db exists
    - .cache/index-input-hash.txt exists
    - sha256(graph-enriched.json) == content of .cache/index-input-hash.txt
  Exit 1 otherwise.

cache --target index:
  Writes .cache/index-input-hash.txt ← sha256(graph-enriched.json)
```

---

#### `cache --check embeddings` / `cache --target embeddings`

```
cache --check embeddings:
  Exit 0 if ALL true:
    - vectors/ directory exists (or vectors.json fallback)
    - .cache/embeddings-input-hash.txt exists
    - .cache/embeddings-config-hash.txt exists
    - sha256(graph-enriched.json || node_descriptions.json || community_summaries.json)
      == content of .cache/embeddings-input-hash.txt
    - sha256(embeddings config: { provider, batch_size, enabled })
      == content of .cache/embeddings-config-hash.txt
  Exit 1 otherwise.

  Note: this is a coarse check (any input changed → exit 1). The phase
  internally does per-node incremental re-embedding via node-texts.json,
  so a stale check here doesn't mean ALL embeddings are regenerated —
  only changed nodes are re-embedded.

cache --target embeddings:
  Writes .cache/embeddings-input-hash.txt  ← sha256(graph-enriched.json || node_descriptions.json || community_summaries.json)
  Writes .cache/embeddings-config-hash.txt ← sha256(embeddings config)
  (node-texts.json is written by the phase internally as part of incremental logic)
```

---

#### `cache --check html` / `cache --target html`

```
cache --check html:
  Exit 0 if ALL true:
    - graph.html exists
    - graph_communities.html exists
    - .cache/html-input-hash.txt exists
    - .cache/html-config-hash.txt exists
    - sha256(graph-enriched.json || community_summaries.json || node_descriptions.json)
      == content of .cache/html-input-hash.txt
    - sha256(html config: { html, html_min_degree })
      == content of .cache/html-config-hash.txt
  Exit 1 otherwise.

cache --target html:
  Writes .cache/html-input-hash.txt  ← sha256(graph-enriched.json || community_summaries.json || node_descriptions.json)
  Writes .cache/html-config-hash.txt ← sha256(html config)
```

---

#### `cache --check report` / `cache --target report`

```
cache --check report:
  Exit 0 if ALL true:
    - report.md exists
    - .cache/report-input-hash.txt exists
    - sha256(graph-enriched.json || community_summaries.json || node_descriptions.json)
      == content of .cache/report-input-hash.txt
  Exit 1 otherwise.

cache --target report:
  Writes .cache/report-input-hash.txt ← sha256(graph-enriched.json || community_summaries.json || node_descriptions.json)
```

---

## Cache Strategy: Per-Phase Contracts

Every phase in the pipeline manages its own caching internally. The orchestrator does NOT check caches — it simply calls `phase.execute()` and the phase decides whether to skip.

This section documents the **complete cache contract** for every phase: what files it produces for staleness detection, what it reads to determine if work is needed, and who consumes its outputs.

### Cache File Layout (New Pipeline)

```
<output>/
├── .cache/
│   ├── hashes.json                           # graph phase (internal): file path → SHA-256
│   ├── extractions/                          # graph phase (internal): cached FileExtraction per file
│   │   └── <pathkey>.json
│   ├── outline-hashes.json                   # outlines phase (internal): file path → SHA-256
│   ├── node-texts.json                       # embeddings phase (internal): nodeId → composed text
│   │
│   │   ── cache --target / cache --check files ──
│   │
│   ├── graph-input-hash.txt                  # graph: sha256(detected-files.json)
│   ├── outlines-input-hash.txt               # outlines: sha256(detected-files.json)
│   ├── outlines-config-hash.txt              # outlines: sha256(outlines config)
│   ├── graph-nodes-hash.txt                  # communities: sha256(graph-nodes.json)
│   ├── enrich-input-hash.txt                 # enrich: sha256(graph.json)
│   ├── enrich-config-hash.txt                # enrich: sha256(enrich config)
│   ├── index-input-hash.txt                  # search-index: sha256(graph-enriched.json)
│   ├── embeddings-input-hash.txt             # embeddings: sha256(graph-enriched.json || descriptions || summaries)
│   ├── embeddings-config-hash.txt            # embeddings: sha256(embeddings config)
│   ├── html-input-hash.txt                   # html: sha256(graph-enriched.json || summaries || descriptions)
│   ├── html-config-hash.txt                  # html: sha256(html config)
│   └── report-input-hash.txt                 # report: sha256(graph-enriched.json || summaries || descriptions)
│
├── .enrich/                                  # enrich phase: intermediate state (intelligent mode only)
│   └── (see .enrich/ Structure section above)
```

---

### Phase: file-detection

| | |
|---|---|
| **Dependencies** | (none) |
| **Input files** | Filesystem directory walk |
| **Output files** | `detected-files.json` |
| **Cache files written** | (none) |
| **Skip logic** | **Never skips** — directory walk cost ≈ cost of checking |
| **Consumed by** | `graph`, `outlines` |

`cache --check file-detection` → always exit 1 (filesystem is authoritative)
`cache --target file-detection` → no-op

---

### Phase: graph

| | |
|---|---|
| **Dependencies** | `file-detection` |
| **Input files** | `detected-files.json`, source files on disk |
| **Output files** | `graph-nodes.json` |
| **Cache files written** | `.cache/hashes.json`, `.cache/extractions/<pathkey>.json` |
| **Skip logic** | **Never fully skips** — uses incremental extraction (per-file SHA-256), but always writes `graph-nodes.json` |
| **Consumed by** | `communities` |

**How staleness is checked internally:**
1. Compute SHA-256 for every detected file
2. Compare against `.cache/hashes.json` from previous build
3. Files with matching hash → load cached extraction from `.cache/extractions/`
4. Files with changed/missing hash → re-extract via tree-sitter
5. Always writes `graph-nodes.json` (even if all files cached — the assembly step still runs)

`cache --check graph` → exit 0 if graph-nodes.json exists AND sha256(detected-files.json) matches `.cache/graph-input-hash.txt`
`cache --target graph` → writes `.cache/graph-input-hash.txt`

---

### Phase: outlines

| | |
|---|---|
| **Dependencies** | `file-detection` |
| **Input files** | `detected-files.json`, source files on disk |
| **Output files** | `outlines/<repo>/<path>.outline.json` |
| **Cache files written** | `.cache/outline-hashes.json` |
| **Skip logic** | Per-file SHA-256 hash comparison |
| **Consumed by** | MCP tools (`graph_outline`) |

**How staleness is checked internally:**
1. For each outline-supported file: compute SHA-256
2. Compare against `.cache/outline-hashes.json`
3. Matching hash AND output file exists → skip that file
4. All files match → report "skipped: up to date"
5. Removes stale outline files for deleted source files

`cache --check outlines` → exit 0 if outlines/ exists AND sha256(detected-files.json) matches `.cache/outlines-input-hash.txt` AND config hash matches `.cache/outlines-config-hash.txt`
`cache --target outlines` → writes `.cache/outlines-input-hash.txt` + `.cache/outlines-config-hash.txt`

---

### Phase: communities

| | |
|---|---|
| **Dependencies** | `graph` |
| **Input files** | `graph-nodes.json` |
| **Output files** | `graph.json` |
| **Cache files written** | `.cache/graph-nodes-hash.txt` |
| **Skip logic** | SHA-256 of `graph-nodes.json` content vs saved hash |
| **Consumed by** | `enrich` |

**How staleness is checked internally:**
1. Compute `sha256(graph-nodes.json)` → `current_hash`
2. Read `.cache/graph-nodes-hash.txt` → `saved_hash`
3. If `graph.json` exists AND `current_hash == saved_hash` → **skip** (graph unchanged)
4. Otherwise → run Louvain, write `graph.json`, save new hash

**Critical behavior**: when skipped, `graph.json` is NOT rewritten. Its mtime is preserved.

`cache --check communities` → exit 0 if graph.json exists AND sha256(graph-nodes.json) matches `.cache/graph-nodes-hash.txt`
`cache --target communities` → writes `.cache/graph-nodes-hash.txt`

---

### Phase: enrich (NEW — replaces community-summaries + node-descriptions)

| | |
|---|---|
| **Dependencies** | `communities` |
| **Input files** | `graph.json` |
| **Output files** | `graph-enriched.json`, `node_descriptions.json`, `community_summaries.json` |
| **Cache files written** | `.cache/enrich-input-hash.txt`, `.cache/enrich-config-hash.txt` |
| **Skip logic** | SHA-256 of `graph.json` + SHA-256 of enrich config section |
| **Consumed by** | `search-index`, `embeddings`, `html`, `report` |

**How staleness is checked internally:**

```
1. Read .cache/enrich-input-hash.txt  → saved_input_hash
2. Compute sha256(graph.json)         → current_input_hash
3. Read .cache/enrich-config-hash.txt → saved_config_hash
4. Compute sha256(enrich config)      → current_config_hash
5. IF saved_input_hash == current_input_hash
   AND saved_config_hash == current_config_hash
   AND graph-enriched.json exists
   AND node_descriptions.json exists
   AND community_summaries.json exists
   → SKIP (up to date)
6. ELSE → run enrichment (intelligent or algorithmic)
```

**Config hash includes**: `{ provider, candidate_threshold, description_batch_tokens, routing_batch_size, concurrency, max_retry_depth, enabled }`

`build --check enrich` → exit 0 if all input hashes match AND all 3 output files exist (see CLI Commands section for full spec)
`cache --target enrich` → writes `.cache/enrich-input-hash.txt` + `.cache/enrich-config-hash.txt` (precondition: output files must exist)

**WHO calls `cache --target enrich`:**

| Mode | When | How |
|------|------|-----|
| **CLI `reponova build`** | After enrich phase completes (inside `phase.execute()`) | Automatic |
| **CLI `reponova enrich`** | After `enrich:finalize` completes successfully | Automatic (final action) |
| **Skill (IDE agent)** | After `enrich:finalize` succeeds | **EXPLICIT** — agent MUST call `$ reponova cache --target enrich` |

**Forgetting `cache --target enrich` in skill mode → next `build --check enrich` returns exit 1 → unnecessary re-enrichment.**

---

### Phase: search-index

| | |
|---|---|
| **Dependencies** | `enrich` |
| **Input files** | `graph-enriched.json` |
| **Output files** | `graph_search.db` |
| **Cache files written** | (none — uses mtime) |
| **Skip logic** | mtime(`graph-enriched.json`) vs mtime(`graph_search.db`) |
| **Consumed by** | MCP tools (`graph_search`, `graph_impact`, `graph_path`, `graph_explain`) |

**How staleness is checked internally:**
1. If `graph_search.db` does not exist → run
2. If `graph-enriched.json` mtime > `graph_search.db` mtime → run
3. Otherwise → skip

`cache --check index` → exit 0 if graph_search.db exists AND sha256(graph-enriched.json) matches `.cache/index-input-hash.txt`
`cache --target index` → writes `.cache/index-input-hash.txt`

---

### Phase: embeddings

| | |
|---|---|
| **Dependencies** | `enrich` |
| **Input files** | `graph-enriched.json`, `node_descriptions.json`, `community_summaries.json` |
| **Output files** | `vectors/` (LanceDB), `tfidf_idf.json` |
| **Cache files written** | `.cache/embeddings-config-hash.txt`, `.cache/node-texts.json` |
| **Skip logic** | Config hash comparison + per-node composed text comparison |
| **Consumed by** | MCP tools (`graph_similar`, `graph_context`) |

**How staleness is checked internally:**
1. Compute `sha256(embeddings config.provider)` → compare vs `.cache/embeddings-config-hash.txt`
2. Config changed → force full regeneration
3. For each node: compose text from graph data + community summary + node description
4. Compare composed text against `.cache/node-texts.json` (previous texts)
5. Nodes with changed text → re-embed
6. All texts unchanged AND no stale vectors → skip

`cache --check embeddings` → exit 0 if vectors/ exists AND input hash matches `.cache/embeddings-input-hash.txt` AND config hash matches `.cache/embeddings-config-hash.txt`
`cache --target embeddings` → writes `.cache/embeddings-input-hash.txt` + `.cache/embeddings-config-hash.txt`

---

### Phase: html

| | |
|---|---|
| **Dependencies** | `enrich` |
| **Input files** | `graph-enriched.json`, `community_summaries.json`, `node_descriptions.json` |
| **Output files** | `graph.html`, `graph_communities.html` |
| **Cache files written** | `.cache/html-config-hash.txt` |
| **Skip logic** | Config hash + mtime comparison (max input mtime vs min output mtime) |
| **Consumed by** | Humans (browser) |

**How staleness is checked internally:**
1. Compute `sha256(html_min_degree config)` → compare vs `.cache/html-config-hash.txt`
2. Config changed → force regeneration
3. Compute `max(mtime(graph-enriched.json), mtime(community_summaries.json), mtime(node_descriptions.json))`
4. Compute `min(mtime(graph.html), mtime(graph_communities.html))`
5. If max input > min output → run
6. Otherwise → skip

`cache --check html` → exit 0 if graph.html + graph_communities.html exist AND input hash matches `.cache/html-input-hash.txt` AND config hash matches `.cache/html-config-hash.txt`
`cache --target html` → writes `.cache/html-input-hash.txt` + `.cache/html-config-hash.txt`

---

### Phase: report

| | |
|---|---|
| **Dependencies** | `enrich` |
| **Input files** | `graph-enriched.json`, `community_summaries.json`, `node_descriptions.json` |
| **Output files** | `report.md` |
| **Cache files written** | (none — uses mtime) |
| **Skip logic** | mtime comparison (max input mtime vs output mtime) |
| **Consumed by** | Humans |

**How staleness is checked internally:**
1. Compute `max(mtime(graph-enriched.json), mtime(community_summaries.json), mtime(node_descriptions.json))`
2. If `report.md` mtime > max input mtime → skip
3. Otherwise → run

`cache --check report` → exit 0 if report.md exists AND input hash matches `.cache/report-input-hash.txt`
`cache --target report` → writes `.cache/report-input-hash.txt`

---

### Cache Dependency Graph (Data Flow)

```
Source files on disk
       │
       ▼
┌─────────────────┐     .cache/hashes.json
│  file-detection │     .cache/extractions/
│                 │───▶ detected-files.json
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌───────┐  ┌──────────┐
│ graph │  │ outlines │    .cache/outline-hashes.json
│       │  │          │───▶ outlines/**/*.outline.json
└───┬───┘  └──────────┘
    │
    ▼  graph-nodes.json
┌─────────────┐
│ communities │    .cache/graph-nodes-hash.txt
│             │───▶ graph.json
└──────┬──────┘
       │
       ▼  graph.json (IMMUTABLE from here down)
┌─────────────┐
│   enrich    │    .cache/enrich-input-hash.txt
│             │    .cache/enrich-config-hash.txt
│             │───▶ graph-enriched.json
│             │───▶ node_descriptions.json
│             │───▶ community_summaries.json
└──────┬──────┘
       │
  ┌────┼──────────┬───────────┐
  ▼    ▼          ▼           ▼
┌────┐┌──────────┐┌────┐ ┌──────┐
│idx ││embeddings││html│ │report│
│    ││          ││    │ │      │
└────┘└──────────┘└────┘ └──────┘
  │        │         │       │
  ▼        ▼         ▼       ▼
graph   vectors/   graph.   report.md
search  tfidf_idf  html
.db     .json      graph_communities.html
```

---

### Coherence Verification: Producer → Consumer Chains

| Output File | Produced By | Consumed By (skip check) | Match? |
|---|---|---|---|
| `detected-files.json` | file-detection | graph (read), outlines (read) | ✓ |
| `graph-nodes.json` | graph | communities (sha256 check) | ✓ |
| `graph.json` | communities | enrich (sha256 check via `.cache/enrich-input-hash.txt`) | ✓ |
| `graph-enriched.json` | enrich | search-index (mtime), embeddings (read), html (mtime), report (mtime) | ✓ |
| `node_descriptions.json` | enrich | embeddings (text composition), html (mtime), report (mtime) | ✓ |
| `community_summaries.json` | enrich | embeddings (text composition), html (mtime), report (mtime) | ✓ |
| `graph_search.db` | search-index | MCP tools | ✓ |
| `vectors/` | embeddings | MCP tools | ✓ |
| `graph.html` | html | Humans | ✓ |
| `report.md` | report | Humans | ✓ |

**No orphans. No circular dependencies. Every file is produced by exactly one phase and consumed by the correct downstream phases.**

---

### Enrich Invalidation Logic (Detail)

**`reponova enrich:metrics`** (start of enrichment, both CLI and skill):
1. If `.enrich/` directory exists:
   - Compute `sha256(graph.json)` → `current_hash`
   - Read `.cache/enrich-input-hash.txt` → `sealed_hash` (may not exist)
   - If `sealed_hash` does not exist OR `current_hash != sealed_hash` → `rm -rf .enrich/` (full invalidation)
2. Proceed with metric computation

**Resumption logic** (within CLI `reponova enrich` or skill workflow):
```
If .enrich/candidates.json missing       → redo Step 0 (enrich:metrics)
If .enrich/descriptions.json missing     → redo Step 1 entirely (all batches)
If .enrich/profiles.json missing         → redo Step 2 entirely
If .enrich/routing.json missing          → redo Step 3 entirely
If .enrich/restructure.json missing      → redo Step 4
If .enrich/graph-applied.json missing    → redo Step 5 (enrich:apply)
If .enrich/updated-profiles.json missing → redo Step 6 entirely
```

**No partial step resumption.** If a step was interrupted, the entire step is re-executed. The final merged file's existence is the only completion signal.

### When source file changes matter

If a source file changes but no new symbols are added/removed (just implementation changes inside a function body), `graph.json` stays the same — tree-sitter extracts the same symbol names, same edges. The enrichment cache remains valid.

This is intentional: enrichment is expensive and should not re-run on every typo fix. If the user wants descriptions to reflect implementation changes, they explicitly invalidate and re-run.

---

## IDE Skill: Complete Workflow

### Full run (first time or after graph changes)

```
User: /reponova enrich

Agent reads SKILL.md and executes:

┌─ Phase 1: Ensure structural graph exists ────────────────────────────────┐
│                                                                          │
│  $ reponova build --target communities                                   │
│                                                                          │
│  Runs file-detection → graph → communities.                              │
│  Incremental: if nothing changed, skipped instantly.                     │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ Phase 2: Check if enrichment is needed ─────────────────────────────────┐
│                                                                          │
│  $ reponova build --check enrich                                         │
│                                                                          │
│  Exit 0 → "Enrichment is up to date." STOP.                             │
│  Exit 1 → Continue.                                                      │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ Phase 3: Compute metrics ───────────────────────────────────────────────┐
│                                                                          │
│  $ reponova enrich:metrics                                               │
│                                                                          │
│  Produces .enrich/candidates.json + .enrich/edge-density.json            │
│  Invalidates .enrich/ if sha256(graph.json) != sealed hash.              │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ Phase 4: Node descriptions (LLM — agent reasoning) ────────────────────┐
│                                                                          │
│  If .enrich/descriptions.json exists → SKIP                              │
│                                                                          │
│  Agent reads source files in batches (Read tool / subagents)             │
│  For each batch: produces descriptions, writes .enrich/descriptions/     │
│  batch-NNN.json                                                          │
│                                                                          │
│  After all batches:                                                      │
│  $ reponova enrich:merge descriptions                                    │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ Phase 5: Community profiling (LLM — agent reasoning) ───────────────────┐
│                                                                          │
│  If .enrich/profiles.json exists → SKIP                                  │
│                                                                          │
│  Agent reads .enrich/descriptions.json + graph.json edges                │
│  For each community: produces profile, writes .enrich/profiles/          │
│  community-NNN.json                                                      │
│                                                                          │
│  After all communities:                                                  │
│  $ reponova enrich:merge profiles                                        │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ Phase 6: Candidate routing (LLM — agent reasoning) ─────────────────────┐
│                                                                          │
│  If .enrich/routing.json exists → SKIP                                   │
│                                                                          │
│  Agent reads .enrich/candidates.json + .enrich/profiles.json             │
│  For each batch of ~30 candidates: produces decisions, writes            │
│  .enrich/routing/batch-NNN.json                                          │
│                                                                          │
│  After all batches:                                                      │
│  $ reponova enrich:merge routing                                         │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ Phase 7: Merge/Split detection (LLM — agent reasoning) ─────────────────┐
│                                                                          │
│  If .enrich/restructure.json exists → SKIP                               │
│                                                                          │
│  Agent reads .enrich/profiles.json + .enrich/edge-density.json           │
│  + .enrich/routing.json                                                  │
│  Produces merge/split decisions, writes .enrich/restructure.json         │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ Phase 8: Apply decisions ───────────────────────────────────────────────┐
│                                                                          │
│  $ reponova enrich:apply                                                 │
│                                                                          │
│  Produces .enrich/graph-applied.json + .enrich/modified-communities.json │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ Phase 9: Regenerate modified profiles (LLM — agent reasoning) ──────────┐
│                                                                          │
│  If .enrich/updated-profiles.json exists → SKIP                          │
│                                                                          │
│  Agent reads .enrich/modified-communities.json                           │
│  For each modified community: produces new profile, writes               │
│  .enrich/updated-profiles/community-NNN.json                             │
│                                                                          │
│  After all modified communities:                                         │
│  $ reponova enrich:merge updated-profiles                                │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ Phase 10: Finalize ─────────────────────────────────────────────────────┐
│                                                                          │
│  $ reponova enrich:finalize                                              │
│                                                                          │
│  Produces graph-enriched.json, node_descriptions.json,                   │
│  community_summaries.json                                                │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ Phase 11: Seal cache + Downstream ───────────────────────────────────────┐
│                                                                          │
│  $ reponova cache --target enrich    ← MANDATORY (seals the cache)       │
│  $ reponova build --start-after enrich                                   │
│                                                                          │
│  cache --target enrich:                                                  │
│    - Verifies graph-enriched.json, node_descriptions.json,               │
│      community_summaries.json all exist                                  │
│    - Writes .cache/enrich-input-hash.txt  (sha256 of graph.json)         │
│    - Writes .cache/enrich-config-hash.txt (sha256 of enrich config)      │
│                                                                          │
│  If this call is omitted, next `build --check enrich` returns exit 1     │
│  and enrichment reruns unnecessarily.                                    │
│                                                                          │
│  Downstream: search-index, embeddings, html, report                      │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Incremental run (nothing changed)

```
User: /reponova enrich

1. $ reponova build --target communities     → skipped (graph unchanged)
2. $ reponova build --check enrich           → exit 0
3. Agent: "Enrichment is up to date."        → STOP (instant, no LLM calls)
```

### Incremental run (new files added)

```
User: /reponova enrich

1. $ reponova build --target communities     → re-runs graph + communities (new files)
2. $ reponova build --check enrich           → exit 1 (graph.json changed)
3. $ reponova enrich:metrics                 → deletes .enrich/ (graph.json hash != sealed hash), computes fresh
4-9. Agent performs LLM steps                → full enrichment
10. $ reponova enrich:finalize               → final files
11. $ reponova cache --target enrich         → seal (MANDATORY - records sha256(graph.json) + sha256(config))
12. $ reponova build --start-after enrich    → downstream
```

### Resumption after crash (skill interrupted at Step 3)

```
User: /reponova enrich

1. $ reponova build --target communities     → skipped
2. $ reponova build --check enrich           → exit 1 (no seal exists yet)
3. $ reponova enrich:metrics                 → SKIP (.enrich/candidates.json exists, graph.json hash unchanged)
4. Agent checks .enrich/descriptions.json    → exists → SKIP Step 1
5. Agent checks .enrich/profiles.json        → exists → SKIP Step 2
6. Agent checks .enrich/routing.json         → missing → REDO Step 3 from scratch
   (all batch files in .enrich/routing/ deleted, redo all batches)
7-10. Continue normally
```

---

## CLI `reponova enrich` (all-in-one with provider)

When running the full enrichment from CLI (not skill), the `reponova enrich` command orchestrates everything internally with the same resumption logic:

```bash
reponova enrich
```

Internally:
1. Calls `enrich:metrics` (skips if output exists and graph.json hash unchanged)
2. For each LLM step: checks if final file exists → skip or redo entirely
3. Runs LLM calls via configured provider (batched, parallel)
4. After each parallel step: calls `enrich:merge` internally
5. Calls `enrich:apply`
6. Runs Step 6 LLM calls
7. Calls `enrich:merge updated-profiles`
8. Calls `enrich:finalize`
9. **Calls `cache --target enrich` (seals the cache — FINAL ACTION)**

Same files, same logic, same resumption. Only difference from skill: LLM calls go to provider API instead of agent reasoning, and cache seal is automatic.

---

## Scaling: 8000+ Nodes Strategy

The hybrid approach (algorithmic pre-filter + targeted LLM review) is specifically designed for large graphs.

### Why it works at scale

- Step 0 eliminates 80-85% of nodes from LLM review (pure computation)
- Step 1 is embarrassingly parallel (independent batches)
- Step 2 produces compact profiles that make Steps 3-4 feasible in bounded prompts
- Step 3 only processes ~15-20% of nodes
- Step 4 sees only profiles (7k tokens for 100 communities), not full data

### Cost for 8000 nodes / 100 communities

| Step | Type | LLM Calls | Tokens/Call | Parallelism |
|------|------|-----------|-------------|-------------|
| 0 | CLI | 0 | 0 | N/A |
| 1 | LLM | ~130 | ~40k | 4 workers |
| 2 | LLM | ~100 | ~5k | 4 workers |
| 3 | LLM | ~50 | ~15k | 4 workers |
| 4 | LLM | 1-3 | ~10k | Sequential |
| 5 | CLI | 0 | 0 | N/A |
| 6 | LLM | ~15 | ~5k | 4 workers |
| 7 | CLI | 0 | 0 | N/A |
| **Total** | | **~300** | | |

Compared to naive 1-call-per-node: **300 vs 8000 calls** — 96% reduction.

---

## Parallelism Summary

### DAG-level (orchestrator manages)

| Level | Phases | Parallel? |
|-------|--------|-----------|
| 0 | file-detection | Single |
| 1 | graph, outlines | **Parallel** |
| 2 | communities | Single |
| 3 | enrich | Single (internally parallel) |
| 4 | search-index, embeddings, html, report | **Parallel** |

### Enrich-internal parallelism

| Step | Within step | File pattern | Across steps |
|------|------------|--------------|--------------|
| 0 | N/A | Single files | → Step 1 |
| 1 | **Batches concurrent** | `descriptions/batch-NNN.json` | → merge → Step 2 |
| 2 | **Communities concurrent** | `profiles/community-NNN.json` | → merge → Step 3 |
| 3 | **Batches concurrent** | `routing/batch-NNN.json` | → merge → Step 4 |
| 4 | Sequential | Single file | → Step 5 |
| 5 | N/A (CLI) | Single files | → Step 6 |
| 6 | **Communities concurrent** | `updated-profiles/community-NNN.json` | → merge → Step 7 |
| 7 | N/A (CLI) | Final outputs | Done |

Steps are strictly sequential. Within each step, parallel workers write independent files that are never shared.

---

## Configuration

```yaml
# reponova.yml

enrich:
  # Enable intelligent enrichment.
  # false or missing provider → algorithmic mode (current behavior, zero regression).
  enabled: true

  # LLM provider for enrichment (must support 32k+ context, good instruction following).
  # References a provider defined in the top-level `providers` section.
  # Minimum recommended: 7B+ parameter model or equivalent API.
  provider: enrich-llm

  # Step 0: boundary_ratio threshold for CANDIDATE classification.
  # Lower = more nodes reviewed by LLM (higher quality, higher cost).
  # Higher = fewer nodes reviewed (lower cost, might miss misplacements).
  candidate_threshold: 0.3

  # Step 1: max tokens per batch for node descriptions.
  # Larger = fewer calls but each prompt is bigger (needs larger context window).
  description_batch_tokens: 40000

  # Step 3: max candidates per prompt for routing.
  routing_batch_size: 30

  # Max concurrent LLM calls across all steps.
  concurrency: 4

  # Adaptive retry: bisection depth on truncated responses.
  # 0 = no retry, 3 = max 8x expansion of a failed batch.
  max_retry_depth: 3

providers:
  enrich-llm:
    type: openai
    base_url: http://localhost:11434/v1
    model: qwen2.5:14b
```

### Provider requirements for enrichment

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| Context window | 32k tokens | 128k tokens |
| Model size | 7B parameters | 14B+ parameters |
| Instruction following | Good JSON output | Reliable structured output |
| Temperature | 0 (deterministic) | 0 |

Models below 7B (e.g., Qwen 0.5B) cannot reliably follow the structured output instructions. The current default `context_size: 512` is completely insufficient — Step 1 alone requires 40k+ tokens per prompt.

---

## CLI vs Skill: Parallel Comparison

| | CLI (`reponova enrich`) | Skill (`/reponova enrich`) |
|---|---|---|
| **Step 0** | `enrich:metrics` (same) | `$ reponova enrich:metrics` (same) |
| **Step 1** | Provider API (batched, parallel) | Agent reads files, reasons, writes batch files |
| **Step 1 merge** | Internal call | `$ reponova enrich:merge descriptions` |
| **Step 2** | Provider API (parallel) | Agent profiles, writes batch files |
| **Step 2 merge** | Internal call | `$ reponova enrich:merge profiles` |
| **Step 3** | Provider API (batched, parallel) | Agent routes, writes batch files |
| **Step 3 merge** | Internal call | `$ reponova enrich:merge routing` |
| **Step 4** | Provider API (1-3 calls) | Agent reasons globally, writes file |
| **Step 5** | `enrich:apply` (same) | `$ reponova enrich:apply` (same) |
| **Step 6** | Provider API (parallel) | Agent reprofiles, writes batch files |
| **Step 6 merge** | Internal call | `$ reponova enrich:merge updated-profiles` |
| **Step 7** | `enrich:finalize` (same) | `$ reponova enrich:finalize` (same) |
| **Cache seal** | Automatic (internal, after finalize) | **EXPLICIT: `$ reponova cache --target enrich`** |
| **Downstream** | Automatic in `reponova build` | `$ reponova build --start-after enrich` |
| **Resumption** | Check final files, skip completed steps | Same logic (check final files) |
| **Works in CI** | ✓ | ✗ |
| **Cost** | API tokens | IDE session tokens |

### Skill advantages over CLI

| Aspect | CLI | Skill |
|--------|-----|-------|
| Context budget | Fixed per prompt (token budget) | Agent decides how much to read |
| Adaptive | If batch fails → bisect blind | Agent can re-read, adjust approach |
| Step 3 quality | Routes based on profiles only | Agent can re-read source of ambiguous nodes |
| Iteration | Single pass | Agent can re-evaluate after applying changes |
| Debugging | Logs only | Agent explains reasoning, can be questioned |

---

## What Changes from Current Architecture

| Aspect | Current | After |
|--------|---------|-------|
| DAG phases | 10 (including community-summaries + node-descriptions) | 8 (those two absorbed into enrich) |
| Community finality | Louvain = final | Louvain = hint, enrich revises (or copies in algo mode) |
| Node descriptions source | Node names + types (no code) | Actual source code (via tree-sitter line ranges) |
| Community summaries source | Node names + types (no code) | LLM-generated node descriptions + edge structure |
| Downstream input | `graph.json` (some phases) | Always `graph-enriched.json` |
| `graph.json` lifecycle | Overwritten by some phases | Immutable after communities phase |
| Intermediate state | None (in-memory) | `.enrich/` directory with physical files per step |
| Parallel file I/O | N/A | Each worker writes its own file, CLI merges |
| CLI commands | `build`, `mcp`, `install`, `check`, `models` | + `enrich`, `enrich:metrics`, `enrich:merge`, `enrich:apply`, `enrich:finalize`, `cache --target`, `cache --check`, `build --start-after` |
| Skill support | No enrichment workflow | Full workflow with CLI commands for heavy lifting |

---

## What Stays Unchanged

- `file-detection` phase (same code, same behavior)
- `graph` phase (tree-sitter extraction, same code)
- `outlines` phase (same code, same behavior)
- `communities` phase (Louvain algorithm, same code, same output — skips if graph-nodes.json unchanged)
- `search-index` phase (trivial change: reads `graph-enriched.json` instead of `graph.json`)
- `embeddings` phase (trivial change: reads `graph-enriched.json`)
- `html` phase (trivial change: reads `graph-enriched.json`)
- `report` phase (trivial change: reads `graph-enriched.json`)
- The entire MCP server and all 11 tools
- The programmatic API (`build()`, query functions)
- `reponova build --target` behavior (extended with `--start-after`)
- Incremental build logic for non-enrich phases
- All existing configuration (providers, embeddings, outlines, patterns, etc.)
