# M1/M2/M3 Implementation Audit

Comparison of actual implementation vs. plan specs (`intelligence/plan/M1.md`, `M2.md`, `M3.md`, `INTELLIGENT-ENRICHMENT.md`).

---

## Legend

- ✅ Matches spec
- ⚠️ Deviation (not necessarily wrong, but differs from spec)
- ❌ Bug / Missing / Spec violation

---

## M1: DAG Restructuring + Algorithmic Enrich

### Config Schema

| Item | Spec | Implementation | Status |
|------|------|---------------|--------|
| `EnrichConfig` interface | 8 fields (enabled, provider, threshold, max_communities, candidate_threshold, description_batch_tokens, routing_batch_size, concurrency, max_retry_depth) | Matches exactly | ✅ |
| `Config.enrich` field | Replace `community_summaries` + `node_descriptions` | `enrich: EnrichConfig` present, old fields gone from interface | ✅ |
| `DEFAULT_CONFIG` | enrich defaults (threshold=0.8, max_communities=0, etc.) | Matches exactly | ✅ |
| `BuildConfigFingerprint` | `enrich: { enabled: boolean }` (remove old fields) | Matches: `enrich: { enabled: boolean }`, old fields gone | ✅ |
| `EnrichConfigSchema` (zod) | All fields with .min/.max/.default | Matches exactly | ✅ |
| Remove `migrateLegacyConfig` | Spec says "Remove `migrateLegacyConfig` function (no backward compat)" | **KEPT** — function still exists and migrates `community_summaries`/`node_descriptions` → `enrich` | ⚠️ D1 |
| Old config keys cause zod error | Spec: "old community_summaries/node_descriptions sections cause parse error" | **Does NOT error** — migration silently promotes them. Zod passthrough strips unknown keys anyway. | ⚠️ D2 |
| `validateProviderReferences` | Remove old 2 `validateLlmProvider` calls, add `enrich.provider` validation | Only `validateLlmProvider(config, "enrich", config.enrich.provider)` — old calls removed | ✅ |

### Enrich Phase

| Item | Spec | Implementation | Status |
|------|------|---------------|--------|
| File `src/pipeline/phases/enrich.ts` | NEW — id="enrich", deps=["communities"] | Matches | ✅ |
| Algorithmic logic extracted to `src/pipeline/enrich/algorithmic.ts` | NEW file with all algorithmic functions | Matches — `algorithmicDescription`, `selectTargetNodes`, `buildCommunityData`, `findHubs`, `findPrimaryPath`, `buildAlgorithmicSummary`, `computeEdgeCounts` all present | ✅ |
| `graph-enriched.json` = byte-for-byte copy of `graph.json` | `copyFileSync(graphJsonPath, graphEnrichedPath)` | Matches exactly | ✅ |
| `node_descriptions.json` output | Array of `{id, description}` | Matches | ✅ |
| `community_summaries.json` output | Array of `{id, label, nodeCount, summary, hub_nodes, primary_path, repos}` | Matches | ✅ |
| Community label format | `"Community {id}"` in algorithmic mode | Matches | ✅ |
| `enabled=false` behavior | Remove output files | Matches — calls `removeFile()` on all 3 outputs + hash files | ✅ |
| Skip logic | sha256(graph.json) + sha256(config subset) + output existence | **Moved to contract** (M3 absorbs this) — enrich phase itself no longer has internal skip logic, contract does it | ✅ (handled by M3 contract) |

### Downstream Phase Migration

| Phase | Spec deps | Actual deps | Spec file | Actual file | Status |
|-------|-----------|-------------|-----------|-------------|--------|
| search-index | `["enrich"]` | `["enrich"]` | `graph-enriched.json` | `graph-enriched.json` | ✅ |
| embeddings | `["enrich"]` | `["enrich"]` | `graph-enriched.json` | `graph-enriched.json` | ✅ |
| html | `["enrich"]` | `["enrich"]` | `graph-enriched.json` | `graph-enriched.json` | ✅ |
| report | `["enrich"]` | `["enrich"]` | `graph-enriched.json` | `graph-enriched.json` | ✅ |

### Registry

| Item | Spec | Implementation | Status |
|------|------|---------------|--------|
| 9 phases registered | 8 phases (file-detection, graph, outlines, communities, enrich, index, embeddings, html, report) | 9 registered (count includes `index` as separate from `search-index`) | ✅ |
| No `community-summaries` | Deleted | Confirmed — file does not exist, not in registry | ✅ |
| No `node-descriptions` | Deleted | Confirmed — file does not exist, not in registry | ✅ |

### Deletion of Old Files

| File | Spec | Actual | Status |
|------|------|--------|--------|
| `src/pipeline/phases/community-summaries.ts` | DELETE | Deleted | ✅ |
| `src/pipeline/phases/node-descriptions.ts` | DELETE | Deleted | ✅ |
| `src/intelligence/community-summary-generator.ts` | "Optionally delete if no other consumers" | **Still exists** — consumed by `tests/intelligence.test.ts` and `src/index.ts` (public API export) | ⚠️ D3 |
| `src/intelligence/node-description-generator.ts` | "Optionally delete if no other consumers" | **Still exists** — consumed by `tests/intelligence.test.ts` | ⚠️ D4 |

### README Update

| Item | Spec | Actual | Status |
|------|------|--------|--------|
| DAG diagram (8 phases, 5 levels) | Update from 10-phase to 8-phase diagram | **NOT UPDATED** — still shows old 10-phase DAG with `community-summaries`, `node-descriptions` | ❌ D5 |
| Pipeline phase table | Remove old phases, add enrich | **NOT UPDATED** — still lists `community-summaries` and `node-descriptions` as phases | ❌ D5 |
| `--target` examples | Update paths | **NOT UPDATED** — still shows `community-summaries → node-descriptions → html` | ❌ D5 |
| Config reference | Replace old sections with `enrich:` | **NOT UPDATED** — still has `community_summaries:` and `node_descriptions:` in full config reference | ❌ D5 |
| Build output section | Add `graph-enriched.json` | **NOT UPDATED** — no mention of `graph-enriched.json` | ❌ D5 |
| `.cache/` files | Update hash file names | **NOT UPDATED** — still lists `community-summaries-config-hash.txt` and `node-descriptions-config-hash.txt` | ❌ D5 |

---

## M2: `build --start-after`

### DAG Utilities

| Item | Spec | Implementation | Status |
|------|------|---------------|--------|
| `resolveTransitiveDescendants` function | BFS through reverse adjacency, excludes source phase | Matches exactly | ✅ |
| `topologicalLevels` fix | Skip deps not in pruned DAG (`if (!dag.has(dep)) continue`) | Matches — line 90 in dag.ts | ✅ |

### Orchestrator

| Item | Spec | Implementation | Status |
|------|------|---------------|--------|
| `OrchestratorOptions.startAfter` | New optional field | Present | ✅ |
| `startAfter` logic | Validate outputs exist → resolve descendants → prune → early return if empty | Matches exactly | ✅ |

### Build Options

| Item | Spec | Implementation | Status |
|------|------|---------------|--------|
| `BuildOptions.startAfter` | New optional field | Present in `src/pipeline/build.ts` | ✅ |
| Passed to orchestrator | `startAfter: options.startAfter` | Matches | ✅ |

### CLI

| Item | Spec | Implementation | Status |
|------|------|---------------|--------|
| `--start-after` option | type: string | Present | ✅ |
| `.conflicts("target", "start-after")` | Mutually exclusive | Present | ✅ |
| Handler passes `startAfter` | `argv["start-after"]` | Matches | ✅ |

### Phase Outputs

| Item | Spec | Implementation | Status |
|------|------|---------------|--------|
| `PHASE_OUTPUTS` registry | Per-phase expected output files | Present in `phase-outputs.ts` | ✅ |
| `PHASE_OUTPUT_DIRS` registry | Per-phase expected output directories | Present | ✅ |
| `validatePhaseOutputsExist` | Throws with clear error message listing missing files | Matches | ✅ |
| `html` outputs in PHASE_OUTPUTS | Spec: `["graph.html"]` | Actual: `["graph.html", "graph_communities.html"]` | ⚠️ D6 |

### README Update

| Item | Spec | Actual | Status |
|------|------|--------|--------|
| `--start-after` documented | Add to CLI reference + examples | **NOT IN README** | ❌ D5 |

---

## M3: Cache Contract System

### Core Interfaces

| Item | Spec | Implementation | Status |
|------|------|---------------|--------|
| `CacheContract` interface | `phaseId`, `check()`, `seal()`, `invalidate()` | Matches exactly (`src/pipeline/cache/contract.ts`) | ✅ |
| `CacheCheckResult` | `{ fresh: boolean, reason: string }` | Matches | ✅ |
| `CacheContext` | `{ outputDir, cacheDir, config }` | Matches (`src/pipeline/cache/context.ts`) | ✅ |

### Hash Utilities

| Item | Spec | Implementation | Status |
|------|------|---------------|--------|
| `hashFile` | SHA256 of file content → hex | Present | ✅ |
| `hashString` | SHA256 of string → hex | Present | ✅ |
| `hashObject` | SHA256 of JSON with sorted keys | Present, with proper `sortObjectKeys` implementation | ✅ |
| `readHashFile` | Returns null if file doesn't exist | Present | ✅ |
| `writeHashFile` | Writes hash (creates parent dirs) | Present (uses `mkdirSync` for parents) | ✅ |
| `allFilesExist` | Checks all paths exist | Present | ✅ |
| `allDirsExist` | Checks all dirs exist | Present | ✅ |
| `dirExistsAndNonEmpty` | Extra utility not in spec | Present (used by outlines/embeddings contracts) | ✅ (improvement) |

### Phase Interface

| Item | Spec | Implementation | Status |
|------|------|---------------|--------|
| `contract?: CacheContract` field on `Phase` | Optional field | Present in `src/pipeline/engine/phase.ts` line 61 | ✅ |

### Orchestrator Integration

| Item | Spec | Implementation | Status |
|------|------|---------------|--------|
| `executePhase` checks contract before execution | `if (contract && !ctx.force)` → check | Present (orchestrator.ts lines 149-160) | ✅ |
| `executePhase` seals after successful execution | `if (contract && !result.skipped)` → seal | Present (lines 164-175) | ✅ |
| Seal failure is non-fatal | Try/catch around `contract.seal()` | Present (empty catch block) | ✅ |
| Additional condition: `!result.skipReason?.startsWith("error:")` | Not in spec — extra guard prevents sealing on error results | Implementation adds safety check | ✅ (improvement) |

### Per-Phase Contracts

| Phase | Spec contract | Implementation | Status |
|-------|--------------|----------------|--------|
| file-detection | Always stale, no-op seal/invalidate | Matches exactly | ✅ |
| graph | input=detected-files.json, config={incremental, patterns, exclude, exclude_common} | Matches | ✅ |
| outlines | input=detected-files.json, config={outlines.enabled}, dir check | Matches (uses `dirExistsAndNonEmpty`) | ✅ |
| communities | input=graph-nodes.json, no config hash | Matches — only input hash, no config | ✅ |
| enrich | input=graph.json, config={enabled, threshold, max_communities, provider}, 3 output files | Matches | ✅ |
| index (search-index) | input=graph-enriched.json, no config | Matches | ✅ |
| embeddings | input=graph-enriched.json, config={enabled, provider, batch_size}, dir check | Matches | ✅ |
| html | input=graph-enriched.json, config={html, html_min_degree}, 2 output files | Matches | ✅ |
| report | input=graph-enriched.json, no config | Matches | ✅ |

### Contract Attachment

| Phase | Contract attached? | Status |
|-------|-------------------|--------|
| file-detection | `fileDetectionContract` | ✅ |
| graph | `graphContract` | ✅ |
| outlines | `outlinesContract` | ✅ |
| communities | `communitiesContract` | ✅ |
| enrich | `enrichContract` | ✅ |
| search-index | `searchIndexContract` | ✅ |
| embeddings | `embeddingsContract` | ✅ |
| html | `htmlContract` | ✅ |
| report | `reportContract` | ✅ |

All 9 phases have contracts. ✅

### Removal of Ad-Hoc Skip Logic

| Phase | Spec: "Remove internal coarse skip logic" | Actual | Status |
|-------|------------------------------------------|--------|--------|
| enrich | Only `enabled=false` disabled check remains | Correct — contract handles cache, phase handles disabled | ✅ |
| html | Only `config.html===false` disabled check remains | Correct | ✅ |
| search-index | No internal skip logic | Correct — no skip logic remaining | ✅ |
| report | No internal skip logic | Correct — no skip logic remaining | ✅ |
| embeddings | Spec: "Remove coarse skip logic, keep fine-grained" | **Still has internal `configChanged` / `effectiveForce` logic** reading config hash from `.cache/embeddings-config-hash.txt` and `node-texts.json` diffing | ⚠️ D7 |

### CLI Command

| Item | Spec | Implementation | Status |
|------|------|---------------|--------|
| `src/cli/cache.ts` exists | NEW file | Present | ✅ |
| `--check <phase>` | exit 0 fresh / exit 1 stale | Matches | ✅ |
| `--seal <phase>` | Validates outputs then seals | Matches | ✅ |
| `--invalidate <phase>` | Calls contract.invalidate | Matches | ✅ |
| `--status` | Table with all phases | Matches (prints aligned table) | ✅ |
| Mutual exclusion check | Only one op at a time | Present (`.check()` validation) | ✅ |

### Communities Contract Legacy Cleanup

| Item | Spec | Implementation | Status |
|------|------|---------------|--------|
| Renamed from `graph-nodes-hash.txt` to `communities-input-hash.txt` | "Migration: delete old file on first run" | Seal removes `LEGACY_HASH_FILE` ("graph-nodes-hash.txt") before writing new | ✅ |

### README Update

| Item | Spec | Actual | Status |
|------|------|--------|--------|
| `reponova cache` command documented | Add to CLI Reference | **NOT IN README** | ❌ D5 |
| Cache architecture section | Document hash-based contracts | **NOT IN README** | ❌ D5 |

---

## Cross-Cutting Discrepancies

### D1 — Legacy Migration Kept (AGAINST SPEC)

**Spec (M1.md Step 1.5):** "Remove `migrateLegacyConfig` function (no backward compat)"

**Actual:** `migrateLegacyConfig` still exists in `src/shared/config.ts` (line 99). It promotes `community_summaries`/`node_descriptions` into the new `enrich` section.

**Impact:** Low — provides smoother upgrade path for existing users. Not strictly a bug, but contradicts the "clean slate, no backward compatibility" design constraint.

**Fix:** Either remove the migration logic (breaking old configs immediately), or formally acknowledge it as a deliberate deviation from the plan and update `M1.md` to reflect the decision.

---

### D2 — Old Config Keys Don't Error (AGAINST SPEC)

**Spec (M1.md Verification Checklist):** "Old config keys (`community_summaries`, `node_descriptions`) cause a zod validation error"

**Actual:** The migration promotes them silently. Additionally, the zod schema uses default behavior (`.passthrough()` or `.strip()`) so unknown top-level keys don't cause errors.

**Impact:** Medium — users with old configs won't realize their settings need updating. They'll silently get migrated behavior which may differ.

**Fix:** Same as D1 — either remove migration OR keep migration but emit a deprecation warning (and update spec to reflect this choice).

---

### D3 + D4 — Old Generator Files Not Deleted

**Spec (M1.md Step 4):** "Optionally delete (if no other consumers): `src/intelligence/community-summary-generator.ts`, `src/intelligence/node-description-generator.ts`"

**Actual:** Both files still exist. Consumers:
- `src/index.ts` exports `CommunitySummaryGenerator` (public API)
- `tests/intelligence.test.ts` imports and tests both generators

**Impact:** Low — dead code that's still tested. The algorithmic logic was correctly extracted to `src/pipeline/enrich/algorithmic.ts`. The old generators are now unused by the pipeline but exposed as public API.

**Fix:** 
1. Remove the public API export from `src/index.ts` (breaking change for anyone importing `CommunitySummaryGenerator`)
2. Remove or update `tests/intelligence.test.ts` to test the new `algorithmic.ts` functions instead
3. Delete the old generator files

OR formally mark them as "retained for public API compatibility" in the plan.

---

### D5 — README Not Updated (ALL MILESTONES)

**Spec:** M1 Step 6, M2 "README Changes", M3 "README Changes" all specify README updates.

**Actual:** README is **completely untouched**. It still shows:
- Old 10-phase DAG diagram with `community-summaries` and `node-descriptions`
- Old `--target` examples referencing non-existent phases
- Old config reference with `community_summaries:` and `node_descriptions:` sections
- Old `.cache/` file listing with `community-summaries-config-hash.txt` and `node-descriptions-config-hash.txt`
- No mention of: `graph-enriched.json`, `enrich` phase, `--start-after`, `reponova cache`

**Impact:** HIGH — README is now factually incorrect. Anyone reading it will have a wrong mental model of the pipeline.

**Fix:** Full README rewrite covering:
1. DAG diagram → 8 phases, 5 levels (with enrich at Level 3)
2. Pipeline phase table → remove old phases, add enrich
3. `--target` examples → update paths
4. Add `--start-after` documentation with examples
5. Add `reponova cache` CLI documentation
6. Config reference → replace `community_summaries`/`node_descriptions` with `enrich:`
7. Build output section → add `graph-enriched.json`, update `.cache/` file listing
8. Provider-based config example → update to use `enrich.provider`

---

### D6 — PHASE_OUTPUTS for HTML Has Extra File

**Spec (M2.md):** `"html": ["graph.html"]`

**Actual:** `"html": ["graph.html", "graph_communities.html"]`

**Impact:** None — this is actually more correct than the spec. The HTML phase produces both files. Having only `graph.html` in the spec was an oversight.

**Fix:** Update M2.md spec to match implementation. No code change needed.

---

### D7 — Embeddings Phase Retains Internal Config-Based Skip Logic

**Spec (M3):** "Remove coarse skip logic from phases. Contract handles the coarse gate. Keep fine-grained incrementality (per-node text diffing) internal."

**Actual:** The embeddings phase (lines 54-56) still:
1. Reads the config hash from `.cache/embeddings-config-hash.txt` internally
2. Compares it against current config to compute `configChanged`
3. Uses `effectiveForce = force || configChanged` to decide whether to diff or rebuild entirely

This is **in addition to** the orchestrator-level contract check. The contract already checks both input hash and config hash. So if the contract says "stale" (config changed), the phase runs. Then inside, it ALSO detects the config change and forces a full re-embed.

**Impact:** Low — it's redundant but not wrong. The internal `configChanged` logic affects whether the phase does incremental work (diff against `node-texts.json`) or full rebuild. This is actually the "fine-grained internal" behavior the spec allows. However:
- The contract ALSO writes `embeddings-config-hash.txt` via `seal()`
- The phase ALSO reads it internally (redundant read)

**Fix:** This is arguably correct behavior per the M3 spec's "coarse + fine-grained layers" design:
- Contract: "Has anything changed?" → enter phase
- Internal: "Was it just data change, or config change too?" → controls whether to diff or full-rebuild

No fix needed, but the phase could be simplified by receiving a `reason` from the contract (e.g., "config hash mismatch") to avoid the redundant hash file read. Low priority.

---

## Summary

| Category | Count |
|----------|-------|
| ✅ Matches spec | ~45 items |
| ⚠️ Minor deviation (functional, not wrong) | 5 (D1, D2, D3, D4, D7) |
| ❌ Missing / Incorrect | 1 major (D5 — README) |

### Priority Fix Order

1. **D5 (README)** — HIGH priority. The README is actively misleading. Full rewrite needed.
2. **D1 + D2 (Migration logic)** — MEDIUM. Decide: keep migration (update spec) or remove (enforce clean break).
3. **D3 + D4 (Old generators)** — LOW. Dead code in pipeline but still public API. Decide and clean up.
4. **D6 (Spec typo)** — Trivial. Update spec document only.
5. **D7 (Embeddings redundancy)** — LOW. Works correctly, just slightly redundant.
