# Development Plan: Intelligent Graph Enrichment

Incremental implementation plan for `INTELLIGENT-ENRICHMENT.md`.

No backward compatibility. Config is new. Cache is new. Old phases are deleted. Clean slate.

---

## Milestone 1: DAG Restructuring + Algorithmic Enrich

**Goal**: New DAG with `enrich` phase replacing `community-summaries` + `node-descriptions`. Algorithmic mode works. Pipeline produces correct output.

### 1.1 — Config schema

- Replace `community_summaries` and `node_descriptions` config sections with single `enrich:` section
- Fields: `enabled`, `provider`, `candidate_threshold`, `description_batch_tokens`, `routing_batch_size`, `concurrency`, `max_retry_depth`
- Keep `enrich.threshold` (degree threshold for algorithmic descriptions) and `enrich.max_communities` (cap for algorithmic summaries) as the algorithmic knobs
- Full final structure — LLM fields present but unused until M4

### 1.2 — Implement `enrich` phase (algorithmic mode)

- Create `src/pipeline/phases/enrich.ts`
- Register in registry: `id: "enrich"`, `dependencies: ["communities"]`
- Algorithmic mode (no provider):
  1. Read `graph.json`
  2. Generate node descriptions (name + type + edges — same algo as old phase)
  3. Generate community summaries (hub names + path — same algo as old phase)
  4. Copy `graph.json` → `graph-enriched.json`
  5. Write `node_descriptions.json`
  6. Write `community_summaries.json`
- Skip logic: sha256(graph.json) + sha256(enrich config) — skip if outputs exist and hashes match

### 1.3 — Migrate downstream phases

- `search-index.ts`: dependency → `["enrich"]`, read `graph-enriched.json`
- `embeddings.ts`: dependency → `["enrich"]`, read `graph-enriched.json`
- `html.ts`: dependency → `["enrich"]`, read `graph-enriched.json`
- `report.ts`: dependency → `["enrich"]`, read `graph-enriched.json`

### 1.4 — Delete obsolete phases

- Delete `src/pipeline/phases/community-summaries.ts`
- Delete `src/pipeline/phases/node-descriptions.ts`
- Remove from registry
- Extract reusable algorithmic logic into `src/pipeline/enrich/algorithmic.ts` before deleting

### 1.5 — Update README

- DAG diagram: 8 phases, 5 levels
- Build pipeline table
- Build Output section
- Config reference (new `enrich:` section replaces old sections)

**Exit criteria**: `reponova build` works end-to-end with new DAG. Produces `graph-enriched.json`, `node_descriptions.json`, `community_summaries.json`.

---

## Milestone 2: `build --start-after`

**Goal**: Run only phases downstream of a given phase.

### 2.1 — Implementation

- Add `--start-after` CLI option to `build` command
- Orchestrator: filter DAG to strict descendants of named phase
- Validate: phase exists, outputs present on disk
- Mutually exclusive with `--target`

### 2.2 — Update README

- Document `--start-after` flag in CLI Reference section
- Add usage examples

**Exit criteria**: `reponova build --start-after enrich` runs Level 4 phases only.

---

## Milestone 3: Cache Contract System

**Goal**: `cache --check <phase>` and `cache --target <phase>` as standardized interface. All phases use sha256-based contracts. No mtime.

### 3.1 — Cache interface

- `src/pipeline/cache/contract.ts`: `CacheContract` interface (`check()` → boolean, `seal()` → void)
- `src/pipeline/cache/context.ts`: CacheContext (output dir, config, hash utilities)
- `src/pipeline/cache/utils.ts`: sha256 file hash, composite hash, hash file read/write

### 3.2 — Implement contracts per phase

| Phase | check() | seal() |
|-------|---------|--------|
| file-detection | always false | no-op |
| graph | graph-nodes.json exists + sha256(detected-files.json) matches | graph-input-hash.txt |
| outlines | outlines/ exists + input hash + config hash | outlines-input-hash.txt + outlines-config-hash.txt |
| communities | graph.json exists + sha256(graph-nodes.json) matches | graph-nodes-hash.txt |
| enrich | 3 outputs exist + input hash + config hash | enrich-input-hash.txt + enrich-config-hash.txt |
| search-index | db exists + sha256(graph-enriched.json) matches | index-input-hash.txt |
| embeddings | vectors/ exists + input hash + config hash | embeddings-input-hash.txt + embeddings-config-hash.txt |
| html | html files exist + input hash + config hash | html-input-hash.txt + html-config-hash.txt |
| report | report.md exists + input hash | report-input-hash.txt |

### 3.3 — Integrate into phase execution

- `phase.execute()` calls `contract.check()` at start (unless `--force`)
- `phase.execute()` calls `contract.seal()` after completion
- Replaces all ad-hoc skip logic in every phase
- Phases keep internal incremental logic (hashes.json, outline-hashes.json, node-texts.json) as fine-grained optimization under the coarse contract

### 3.4 — CLI commands

- `reponova cache --check <phase>` → exit 0 (fresh) / exit 1 (stale)
- `reponova cache --target <phase>` → seal, fail if preconditions unmet

### 3.5 — Update README

- Document `cache --check` and `cache --target` commands in CLI Reference section
- Document cache architecture (hash-based, per-phase contracts)

**Exit criteria**: All 8 phases use CacheContract. CLI commands work. Hash-based end-to-end.

---

## Milestone 4: Intelligent Enrichment (LLM + Skill)

**Goal**: Full LLM enrichment (Steps 0-7). CLI orchestration. IDE skill definition.

### 4.1 — `enrich:metrics`

- Compute boundary_ratio, classify STABLE/CANDIDATE
- Compute inter-community edge density matrix
- Output: `.enrich/candidates.json`, `.enrich/edge-density.json`
- Invalidation: sha256(graph.json) changed → rm -rf `.enrich/`

### 4.2 — `enrich:merge`

- `reponova enrich:merge <step>` (descriptions | profiles | routing | updated-profiles)
- Read batch files → validate → merge into single file

### 4.3 — `enrich:apply`

- Apply routing + restructure decisions to graph
- Output: `.enrich/graph-applied.json`, `.enrich/modified-communities.json`

### 4.4 — `enrich:finalize`

- Assemble final output from `.enrich/` intermediates
- Output: `graph-enriched.json`, `node_descriptions.json`, `community_summaries.json`

### 4.5 — `reponova enrich` (all-in-one CLI orchestration)

- Steps 0-7 sequentially with resumption
- Batching by directory, token budget packing
- Parallel workers (configurable concurrency)
- Adaptive retry (bisect on truncation)
- Prompt templates per step
- Auto-seals cache after finalize

### 4.6 — Intelligent mode in enrich phase

- `enrich.provider` configured → intelligent mode (delegates to orchestration)
- No provider → algorithmic mode (M1 behavior)

### 4.7 — IDE skill

- `SKILL.md` with full agent workflow
- Prompt templates, output schemas, resumption logic
- Explicit cache seal instruction

**Exit criteria**: LLM enrichment works end-to-end. Skill is defined and complete.

---

## Dependency Graph

```
M1 (DAG + Algorithmic)
 │
 ├──► M2 (--start-after)
 │
 └──► M3 (Cache Contracts)
          │
          └──► M4 (LLM + Skill) ◄── M2
```

M2 and M3 parallelize after M1. M4 needs both.

---

## Implementation Order

```
1.1 → 1.2 → 1.3 → 1.4 → 1.5
     ↓
2.1 ─────────────────────────── (parallel with M3)
3.1 → 3.2 → 3.3 → 3.4
     ↓ (after M2 + M3)
4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 4.6 → 4.7
```
