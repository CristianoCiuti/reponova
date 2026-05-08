# Incremental Execution — Per-Phase Skip Criteria

> Each phase is analyzed as a standalone unit.
> For each: what it consumes, how to determine staleness, and at what granularity it can skip work.

---

## Principle

Each phase owns its own cache. A cache file is **written by the phase at the end of its execution** and **read by the same phase at the beginning of its next execution** to determine what changed. No other phase reads or writes another phase's cache.

---

## Cache Ownership

| Cache file | Written by | Read by | Content |
|-----------|-----------|---------|---------|
| `.cache/file-hashes.json` | `graph` | `graph` | `{ relPath: sha256 }` — file content hashes from last run |
| `.cache/extractions/<hash>.json` | `graph` | `graph` | Serialized `FileExtraction` per file |
| `.cache/graph-nodes-hash.txt` | `communities` | `communities` | SHA-256 of `graph-nodes.json` from last run |
| `.cache/outline-hashes.json` | `outlines` | `outlines` | `{ relPath: sha256 }` — file content hashes from last run |
| `.cache/community-summary-fingerprints.json` | `community-summaries` | `community-summaries` | `{ fingerprint: CommunitySummary }` |
| `.cache/node-description-fingerprints.json` | `node-descriptions` | `node-descriptions` | `{ nodeId: fingerprint }` |
| `.cache/node-texts.json` | `embeddings` | `embeddings` | `{ nodeId: composedText }` |

`html`, `report`, `index`, and `file-detection` have no cache files — they use mtime comparison on their inputs/outputs or always run.

---

## file-detection

**Consumes**: workspace filesystem, config (`repos[].path`, `build.patterns`, `build.exclude`, `build.docs`, `build.images`)

**Produces**: `detected-files.json`

**Skip criteria**: none — **always run**.

File detection is a directory walk. It takes milliseconds. The cost of determining whether to skip (hashing config + listing dirs to compare) is comparable to just running it. The output (`detected-files.json`) is deterministic: same filesystem + same config = same output. Downstream phases compare their own inputs.

**Granularity**: all-or-nothing.

---

## graph

**Consumes**: `detected-files.json`, source file contents on disk

**Produces**: `graph-nodes.json`

**Skip criteria (per-file)**:

For each file in `detected-files.json`:
1. Compute SHA-256 of file contents
2. Compare with stored hash from previous run (`.cache/file-hashes.json`)
3. If hash matches AND cached `FileExtraction` exists for that file → reuse cached extraction
4. If hash differs OR no cached extraction → re-extract with tree-sitter

After extraction, the full set of `FileExtraction[]` (cached + fresh) is assembled into a graph. The graph is always rebuilt entirely — there's no incremental graph assembly because edge resolution depends on the global symbol table.

| Condition | Action |
|-----------|--------|
| File hash unchanged + cached extraction exists | Reuse cached extraction |
| File hash changed | Re-extract file |
| File in cache but not in `detected-files.json` | Removed — drop from cache |
| File in `detected-files.json` but not in cache | New — extract |

**Config invalidation**: none specific to this phase. Config changes that affect file selection are handled by `file-detection` (different `detected-files.json` → different file set → changed hashes).

**Granularity**: per-file for extraction, all-or-nothing for graph assembly.

**Cache artifacts** (internal to phase):
- `.cache/file-hashes.json` — `{ relPath: sha256 }`
- `.cache/extractions/<pathHash>.json` — serialized `FileExtraction` per file

---

## outlines

**Consumes**: `detected-files.json`, source file contents on disk

**Produces**: `outlines/**/*.outline.json`

**Skip criteria (per-file)**:

For each file in `detected-files.json`:
1. Compute SHA-256 of file contents
2. Compare with stored hash from previous run (`.cache/outline-hashes.json`)
3. If hash matches AND outline file exists → skip
4. If hash differs OR outline missing → regenerate outline

Additionally:
- Files present in the cache but absent from `detected-files.json` → delete stale outline
- Empty directories after cleanup → remove

**Config invalidation**: none. Config changes that affect which files are processed are already reflected in `detected-files.json`.

**Granularity**: fully per-file. Each outline is independent.

**Cache artifacts** (internal to phase):
- `.cache/outline-hashes.json` — `{ relPath: sha256 }`

---

## communities

**Consumes**: `graph-nodes.json`

**Produces**: `graph.json`

**Skip criteria**:

Louvain operates on the entire graph topology. There is no per-node incrementality — changing a single edge can cascade community assignments across the entire graph.

| Condition | Action |
|-----------|--------|
| `graph-nodes.json` content unchanged since last run | Skip |
| `graph-nodes.json` content changed | Full re-run |

**How to detect change**: compute SHA-256 of `graph-nodes.json` and compare with a stored hash (`.cache/graph-nodes-hash.txt`). The hash must be on the **semantic content** (nodes + edges), not the raw file bytes, to avoid false positives from metadata fields like timestamps.

Alternative (simpler): compare mtime of `graph-nodes.json` vs mtime of `graph.json`. If `graph-nodes.json` is newer → re-run. This is what `shouldRunIndexer` already does in the current code, and it works because `graph-nodes.json` is only written when its content actually changes (see `exportJson`'s content-comparison logic).

**Config invalidation**: none. Louvain has no user-facing config (resolution is hardcoded). If resolution becomes configurable, changing it forces a full re-run.

**Granularity**: all-or-nothing.

**Cache artifacts** (internal to phase):
- `.cache/graph-nodes-hash.txt` — SHA-256 of `graph-nodes.json` content (or just use mtime comparison)

---

## community-summaries

**Consumes**: `graph.json`

**Produces**: `community_summaries.json`

**Skip criteria (per-community)**:

Each community's identity is defined by its member nodes. The fingerprint captures the composition:

```
fingerprint(community) = SHA-256(sorted(members.map(node =>
  SHA-256(node.id | node.label | node.type | node.signature | node.docstring | node.source_file)
)))
```

| Condition | Action |
|-----------|--------|
| Community fingerprint matches cache AND cached summary exists | Reuse cached summary |
| Community fingerprint changed (member added/removed/modified) | Regenerate summary |
| Community no longer exists (nodes reassigned) | Drop from output |
| New community appeared | Generate summary |

This is fingerprint-based, not ID-based. Community IDs can be reassigned by Louvain between runs (same set of nodes gets a different numeric ID). The fingerprint is content-based, so if a community has the same members with the same attributes, its cached summary is reused regardless of the new ID.

**Config invalidation**:

| Config field | Effect |
|-------------|--------|
| `community_summaries.model` changed | Full regeneration (different model → different prose) |
| `community_summaries.context_size` changed (AND model is set) | Full regeneration |
| `community_summaries.max_number` changed | Only affects which communities qualify — fingerprint logic handles the rest |

**Granularity**: per-community.

**Cache artifacts** (internal to phase):
- `.cache/community-summary-fingerprints.json` — `{ fingerprint: CommunitySummary }`

---

## node-descriptions

**Consumes**: `graph.json`

**Produces**: `node_descriptions.json`

**Skip criteria (per-node)**:

Only high-degree nodes qualify (above the `threshold` percentile). For each qualifying node:

```
fingerprint(node) = SHA-256(node.id | node.source_file | node.type | node.label | node.signature | node.docstring | degree)
```

| Condition | Action |
|-----------|--------|
| Node fingerprint matches cache AND cached description exists | Reuse cached description |
| Node fingerprint changed (metadata or degree changed) | Regenerate description |
| Node no longer qualifies (degree dropped below threshold) | Drop from output |
| Node newly qualifies (degree rose above threshold) | Generate description |

Note: `degree` is part of the fingerprint. A node that gains or loses edges will have a different degree → different fingerprint → regeneration. This is correct because the description is about the node's structural role, which changes with connectivity.

**Config invalidation**:

| Config field | Effect |
|-------------|--------|
| `node_descriptions.model` changed | Full regeneration |
| `node_descriptions.context_size` changed (AND model is set) | Full regeneration |
| `node_descriptions.threshold` changed | Different nodes qualify — re-evaluate all, generate new ones, drop old ones |

**Granularity**: per-node.

**Cache artifacts** (internal to phase):
- `.cache/node-description-fingerprints.json` — `{ nodeId: fingerprint }`

---

## index

**Consumes**: `graph.json`

**Produces**: `graph_search.db`

**Skip criteria**:

The SQLite index is a monolithic artifact. There's no incremental SQLite population that's worth the complexity — the entire index rebuilds in milliseconds for any reasonable graph size.

| Condition | Action |
|-----------|--------|
| `graph.json` mtime ≤ `graph_search.db` mtime | Skip |
| `graph.json` mtime > `graph_search.db` mtime | Full re-run |
| `graph_search.db` doesn't exist | Full re-run |

**Config invalidation**: none. The index schema is fixed.

**Granularity**: all-or-nothing.

**Cache artifacts**: none (the output IS the cache).

---

## embeddings

**Consumes**: `graph.json`, `community_summaries.json`, `node_descriptions.json`

**Produces**: `vectors/`, `tfidf_idf.json` (TF-IDF only)

**Skip criteria (per-node)**:

For each node, the composed text determines the embedding:

```
composedText(node) = composeNodeText(node) + nodeDescription + communitySummary
```

The cache stores composed texts: `{ nodeId: composedText }`.

| Condition | Action |
|-----------|--------|
| Composed text identical to cached text AND vector exists | Skip this node |
| Composed text changed (node metadata, description, or summary changed) | Re-embed this node |
| Node no longer in graph | Remove vector |
| New node in graph | Embed |

The composed text changes when ANY of its three sources changes:
- Node attributes changed (label, signature, docstring...) → `graph.json` changed
- Community summary changed → `community_summaries.json` changed
- Node description changed → `node_descriptions.json` changed

This means the phase naturally re-embeds exactly the affected nodes without needing to know WHICH input file changed.

**Config invalidation**:

| Config field | Effect |
|-------------|--------|
| `embeddings.method` changed (tfidf ↔ onnx) | Full re-embed (vectors are incompatible) |
| `embeddings.model` changed | Full re-embed |
| `embeddings.dimensions` changed | Full re-embed |

**TF-IDF special case**: when nodes are added or removed, the IDF vocabulary changes globally. Every existing vector becomes stale because the TF-IDF dimensions now represent different terms. In this case, ALL nodes must be re-embedded. This is inherent to TF-IDF — ONNX embeddings don't have this problem because each vector is self-contained.

| Scenario | ONNX | TF-IDF |
|----------|------|--------|
| 3 nodes changed out of 500 | Re-embed 3 | Re-embed 3 |
| 1 node added | Embed 1 | Re-embed ALL (IDF changed) |
| 1 node removed | Remove 1 | Re-embed ALL (IDF changed) |

**Granularity**: per-node for ONNX, potentially all-or-nothing for TF-IDF when nodes are added/removed.

**Cache artifacts** (internal to phase):
- `.cache/node-texts.json` — `{ nodeId: composedText }`

---

## html

**Consumes**: `graph.json`, `community_summaries.json`, `node_descriptions.json`

**Produces**: `graph.html`, `graph_communities.html`

**Skip criteria**:

HTML files are monolithic outputs. There's no per-node HTML generation.

| Condition | Action |
|-----------|--------|
| All inputs older than both output files | Skip |
| Any input newer than either output file | Full re-run |
| Either output file missing | Full re-run |

Specifically, re-run when:
```
max(mtime(graph.json), mtime(community_summaries.json), mtime(node_descriptions.json))
  > min(mtime(graph.html), mtime(graph_communities.html))
```

**Config invalidation**:

| Config field | Effect |
|-------------|--------|
| `build.html` toggled off | Delete output files, skip |
| `build.html_min_degree` changed | Full re-run |

**Granularity**: all-or-nothing.

**Cache artifacts**: none (mtime comparison suffices).

---

## report

**Consumes**: `graph.json`, `community_summaries.json`, `node_descriptions.json`

**Produces**: `report.md`

**Skip criteria**:

Same pattern as `html` — monolithic output.

| Condition | Action |
|-----------|--------|
| All inputs older than `report.md` | Skip |
| Any input newer than `report.md` | Full re-run |
| `report.md` missing | Full re-run |

**Config invalidation**: none. The report format is fixed.

**Granularity**: all-or-nothing.

**Cache artifacts**: none (mtime comparison suffices).

---

## Summary Matrix

| Phase | Detection Method | Granularity | Config Fields That Force Full Re-run |
|-------|-----------------|-------------|--------------------------------------|
| `file-detection` | Always run | — | — |
| `graph` | Per-file SHA-256 | Per-file extraction, full graph assembly | — |
| `outlines` | Per-file SHA-256 | Per-file | — |
| `communities` | Input mtime or content hash | All-or-nothing | (Louvain resolution, if configurable) |
| `community-summaries` | Per-community fingerprint | Per-community | `model`, `context_size` |
| `node-descriptions` | Per-node fingerprint | Per-node | `model`, `context_size`, `threshold` |
| `index` | Input mtime | All-or-nothing | — |
| `embeddings` | Per-node composed text hash | Per-node (ONNX) / global (TF-IDF on add/remove) | `method`, `model`, `dimensions` |
| `html` | Input mtime | All-or-nothing | `html`, `html_min_degree` |
| `report` | Input mtime | All-or-nothing | — |
