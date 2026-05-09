# Pipeline Phase Atomicity Audit

Analysis of write safety and output integrity across all pipeline phases.

---

## `build-manifest.json`

**Does not exist.** Zero references in the codebase. It was removed in previous refactors and never replaced. Phase tracking is now handled by the orchestrator's DAG engine (`pipeline/engine/`) which uses `PhaseResult` return values — no manifest file.

---

## Phase Write Patterns

Every pipeline phase produces output files. The critical invariant:

> **A phase must never leave its output in a corrupted state.** If a phase crashes mid-execution, the previous output must remain intact for the next build.

### Inventory

| Phase | Output file(s) | Write method | Atomic? |
|---|---|---|---|
| `file-detection` | `detected-files.json` | `atomicWriteJson` | ✅ |
| `graph` | `graph-nodes.json` | `exportJson()` → `writeFileSync` | ❌ |
| `communities` | `graph.json`, `.cache/graph-nodes-hash.txt` | `exportJson()` → `writeFileSync`, `atomicWriteText` | ❌ / ✅ |
| `community-summaries` | `community_summaries.json` + cache files | `atomicWriteJson`, `atomicWriteText` | ✅ |
| `node-descriptions` | `node_descriptions.json` + cache files | `atomicWriteJson`, `atomicWriteText` | ✅ |
| `embeddings` | `vectors/`, `tfidf_idf.json`, `.cache/node-texts.json` | `atomicWriteJson`, `atomicWriteText`, LanceDB | ✅ |
| `index` (search-index) | `graph_search.db` | `saveDatabase()` → `writeFileSync` | ❌ |
| `html` | `graph.html`, `graph_communities.html` | `writeFileSync` | ❌ |
| `outlines` | `outlines/*.outline.json`, `.cache/outline-hashes.json` | tmpDir → `copyFileSync` batch commit, `atomicWriteJson` | ✅ |
| `report` | `report.md` | `writeFileSync` | ❌ |

---

## Non-Atomic Writes (Problems)

### 🔴 `graph-nodes.json` and `graph.json` — CRITICAL

**File**: `src/graph/export-json.ts`, line 148

```ts
writeFileSync(outputPath, JSON.stringify(data, null, 2));
```

`graph.json` is the **canonical graph file**. Every downstream phase reads it:
- `communities` → reads `graph-nodes.json`
- `community-summaries`, `node-descriptions`, `embeddings` → read `graph.json`
- `search-index` → reads `graph.json`
- `html` → reads `graph.json`
- `report` → reads `graph.json`

A crash during `JSON.stringify` of a large graph (thousands of nodes) or during `writeFileSync` leaves the file truncated. The next build attempt finds a corrupted JSON file and **every downstream phase fails**.

Additionally, `exportJson` has a "skip if unchanged" optimization (lines 129-144) that reads the existing file, compares, and returns early if identical. This is correct but the actual write path when content changed is still a direct `writeFileSync`.

### 🟡 `graph.html` and `graph_communities.html` — MEDIUM

**File**: `src/graph/export-html.ts`, lines 100 and 191

```ts
writeFileSync(outputPath, html);
```

Two separate `writeFileSync` calls for two HTML files. A crash between the two leaves output inconsistent (one updated, one stale). The HTML files are regenerable but corruption is user-visible.

### 🟡 `graph_search.db` — MEDIUM

**File**: `src/query/db.ts`, line 88

```ts
export function saveDatabase(db: Database, dbPath: string): void {
  if (dbPath === ":memory:") return;
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(dbPath, buffer);
}
```

Direct binary write. A crash during write corrupts the SQLite file, breaking all MCP query tools until the next successful build. The file is fully regenerable from `graph.json`.

### 🟢 `report.md` — LOW

**File**: `src/pipeline/phases/report.ts`, line 153

```ts
writeFileSync(outputPath, lines.join("\n"));
```

Pure text report, fully regenerable, no downstream consumers. Low risk but still inconsistent with the atomic pattern used elsewhere.

---

## Deletion Without Replacement

Several phases delete their output files when the feature is disabled in config:

```ts
// community-summaries.ts:34-37
if (!csConfig.enabled) {
  removeFile(summariesPath);     // deletes community_summaries.json
  removeFile(cachePath);
  removeFile(configHashPath);
  return { processed: 0, skipped: true };
}

// node-descriptions.ts:29-33
if (!ndConfig.enabled) {
  removeFile(descriptionsPath);  // deletes node_descriptions.json
  removeFile(cachePath);
  removeFile(configHashPath);
  return { processed: 0, skipped: true };
}

// embeddings.ts:33-39
if (!embConfig.enabled) {
  removeDirectory(vectorsPath);  // deletes vectors/
  removeFile(tfidfPath);         // deletes tfidf_idf.json
  removeFile(cachePath);
  removeFile(configHashPath);
  return { processed: 0, skipped: true };
}

// html.ts:29-33
if (!config.html) {
  removeFile(htmlPath);          // deletes graph.html
  removeFile(communityHtmlPath); // deletes graph_communities.html
  return { processed: 0, skipped: true };
}
```

**These deletions are correct by design.** When a feature is disabled, "no file" IS the correct output. Downstream phases treat missing files as optional (load with fallback to empty/undefined). There is no "updated version" to write — absence is the intended state.

The phases that generate content (the non-disabled path) all use `atomicWriteJson` / `atomicWriteText`, so a crash during generation preserves the previous file. The only exception is the non-atomic writers listed above.

---

## Orchestrator Failure Handling

The orchestrator (`pipeline/engine/orchestrator.ts`, lines 138-159) treats phase failures as **non-blocking**:

```ts
if (outcome.status === "rejected") {
  log.warn(`[${phase.id}] Failed (non-blocking): ${message}`);
  results.set(phase.id, { processed: 0, skipped: true, skipReason: `error: ${message}` });
}
```

This means downstream phases **continue running** after an upstream failure, reading whatever output files exist on disk. This is correct IF the upstream phase's writes are atomic (previous file intact on failure). For the non-atomic writers, a crash mid-write leaves a corrupted file that downstream phases will read.

---

## Fix Plan

All four non-atomic writers should use atomic write patterns. The fixes are mechanical.

| File | Current | Fix |
|---|---|---|
| `src/graph/export-json.ts` | `writeFileSync(outputPath, ...)` | `atomicWriteText(outputPath, JSON.stringify(data, null, 2))` |
| `src/graph/export-html.ts` | `writeFileSync(outputPath, html)` × 2 | `atomicWriteText(outputPath, html)` × 2 |
| `src/query/db.ts` | `writeFileSync(dbPath, buffer)` | Write to tmpfile + copyFileSync + unlinkSync (binary atomic write) |
| `src/pipeline/phases/report.ts` | `writeFileSync(outputPath, ...)` | `atomicWriteText(outputPath, lines.join("\n"))` |

For `db.ts`, `atomicWriteText` won't work because the content is a binary `Buffer`, not a string. A small `atomicWriteBuffer` helper or inline tmp+copy pattern is needed.
