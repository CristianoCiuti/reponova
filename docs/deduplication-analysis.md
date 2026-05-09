# Deduplication & Strategic Refactoring Analysis

Data-driven audit of duplicated logic across `src/`.
Each finding includes exact occurrence counts, file locations, and a verdict on whether centralizing makes sense.

---

## Findings Summary

| # | Pattern | Occurrences | Files | Verdict |
|---|---------|-------------|-------|---------|
| 1 | Path normalization `.replace(/\\\\/g, "/")` | 30 | 9 | **CENTRALIZE** — `toPosix()` already exists unused |
| 2 | Basename via `.split("/").pop()` | 8 | 6 | **CENTRALIZE** — pair with `toPosix()` |
| 3 | `JSON.parse(readFileSync(...))` with guards | 22 | 11 | **CENTRALIZE** — `readJsonSafe<T>()` helper |
| 4 | `mkdirSync(..., { recursive: true })` | 25 | 9 | **NO** — `mkdirSync` already idempotent with `recursive` |
| 5 | Atomic write (tmp+rename) re-implementations | 3 | 2 | **CENTRALIZE** — `atomicWriteJson` exists but isn't used everywhere |
| 6 | `err instanceof Error ? err.message : String(err)` | 10 | 6 | **CENTRALIZE** — `errorMessage()` one-liner |
| 7 | BFS/DFS over SQLite edges | 3 impls | 3 | **PARTIAL** — share neighbor query, keep algorithm-specific logic |
| 8 | Progress/ETA timing (`Date.now()` arithmetic) | 14 | 3 | **CENTRALIZE** — `ProgressTimer` class |
| 9 | `SyntaxNode` interface defined twice | 2 defs | 2 | **CENTRALIZE** — outline uses a subset of extract's |
| 10 | Node metadata fields repeated across types | 6 types | 4 | **NO** — types serve different layers, `extends` would couple them |

---

## 1. Path Normalization — `toPosix()`

**30 occurrences across 9 files.**

```
builder.ts        8   path-resolver.ts  7   python.ts        4
extract/index.ts  3   import-resolver.ts 3  comm-summary.ts  2
markdown.ts       1   diagrams.ts       1   export-json.ts   1
```

The codebase already has `normalizePath()` in `shared/utils.ts` (line 31) — but **zero callers use it**. Every module inlines `.replace(/\\\\/g, "/")` instead.

`normalizePath` also does more than needed (resolves relative paths) which is probably why nobody adopted it.

### Recommendation

Replace `normalizePath` with a simpler, focused function:

```ts
// shared/utils.ts
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
```

Then replace all 30 inline `.replace(...)` calls with `toPosix(p)`.

For the common combo `relative(a, b).replace(...)` (found in 7 places across 3 files), add:

```ts
export function relativePosix(from: string, to: string): string {
  return relative(from, to).replace(/\\/g, "/");
}
```

**Risk**: Zero. Pure string transform, identical behavior.

---

## 2. Basename via `.split("/").pop()`

**8 occurrences across 6 files.**

```
diagrams.ts  3   builder.ts   1   python.ts       1
markdown.ts  1   embeddings.ts 1  cli/models.ts   1
```

Node's `path.basename()` doesn't normalize backslashes first, so the codebase works around it with `split("/").pop()`. This pairs naturally with `toPosix()`:

```ts
export function posixBasename(p: string): string {
  return toPosix(p).split("/").pop() ?? p;
}
```

**Risk**: Zero.

---

## 3. JSON File Reading with Guards

**22 occurrences across 11 files.**

The repeated pattern:

```ts
if (existsSync(path)) {
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as T;
    // use data
  } catch { /* fallback */ }
}
```

Found in:
```
embeddings.ts (phase)  4   node-descriptions.ts  4   context-builder.ts  3
community-summaries.ts 3   vector-store.ts       2   utils.ts            1
tfidf-embeddings.ts    1   build-config-meta.ts  1   html.ts             1
outlines.ts            1   mcp/tools/outline.ts  1
```

Most callers want "read JSON or return a default". Some want to throw on parse error. Two variants cover everything:

```ts
// shared/fs.ts
export function readJsonSafe<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; }
  catch { return undefined; }
}

export function readJsonOr<T>(path: string, fallback: T): T {
  return readJsonSafe<T>(path) ?? fallback;
}
```

**Not recommending**: a `readJsonStrict` variant. The 1-2 callers that need to throw on error are better served by a direct `JSON.parse(readFileSync(...))` — adding a separate function for that gains nothing.

### What NOT to consolidate

Each caller does something different with the parsed data (different types, different fallbacks, different error logging). Only the **read + parse + guard** is duplicate — the surrounding logic is intentionally per-module. A helper should return the parsed data and let callers handle it.

**Risk**: Low. Type parameter makes it type-safe. Callers that log on parse failure can check `undefined` and log themselves.

---

## 4. `mkdirSync` with `{ recursive: true }` — NO ACTION

**25 occurrences across 9 files.**

```
cli/install.ts  10   outlines.ts   3   pipeline/build.ts  3
atomic-write.ts  2   path-resolver.ts 2  vector-store.ts   2
llm-engine.ts    1   embeddings.ts  1   pipeline/cache.ts  1
```

An `ensureDir()` wrapper would save ~15 characters per call but adds a layer of indirection for a one-line operation that's already idempotent (`recursive: true` handles the existence check). The `cli/install.ts` alone accounts for 10 of the 25 — and those are in a sequence of directory creations where reading `mkdirSync` is more explicit than `ensureDir`.

### Verdict: Not worth centralizing.

`mkdirSync(dir, { recursive: true })` is self-documenting, idempotent, and standard Node.js. An `ensureDir` would be a wrapper-for-wrapper's-sake.

---

## 5. Atomic Write — Use `atomicWriteJson` Consistently

**`shared/atomic-write.ts` already exists** with `atomicWriteJson()` and `atomicWriteText()`. Most pipeline phases use it. Two modules don't:

| Module | What it does instead |
|--------|---------------------|
| `query/vector-store.ts` (`persistSidecar`) | Manual `writeFileSync` to `.tmp` + `renameSync` |
| `graph/export-json.ts` | Direct `writeFileSync` (no atomicity) |

### Recommendation

- `vector-store.ts`: Replace `persistSidecar()`'s manual tmp+rename with `atomicWriteJson(sidecarPath, records)`. The existing helper already handles cross-drive issues on Windows.
- `export-json.ts`: Replace `writeFileSync(outputPath, ...)` with `atomicWriteJson(outputPath, data)`. A crash mid-write currently corrupts `graph.json` — atomic writes prevent this.

**Risk**: Low. Same semantics, better crash safety.

---

## 6. Error Message Extraction

**10 occurrences across 6 files.**

```ts
const msg = err instanceof Error ? err.message : String(err);
```

```
llm-engine.ts      2   embeddings.ts (intelligence) 2   vector-store.ts      2
embeddings.ts (phase) 2   path-resolver.ts           1   cli/build.ts         1
```

### Recommendation

```ts
// shared/utils.ts
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

**Risk**: Zero. Pure extraction, no behavior change.

---

## 7. BFS/DFS over SQLite — Partial Consolidation

Three independent implementations of graph traversal via SQL queries:

| Location | Algorithm | Direction | SQL Pattern |
|----------|-----------|-----------|-------------|
| `query/impact.ts` | BFS | Directional (up/down) | `WHERE source_id = ?` or `WHERE target_id = ?` |
| `mcp/tools/search.ts` | BFS | Undirected | `WHERE source_id = ? OR target_id = ?` |
| `mcp/tools/search.ts` | DFS | Undirected | `WHERE source_id = ? OR target_id = ?` |

Also `query/shortest-path.ts` (Dijkstra) and `query/context-builder.ts` (1-hop expansion) query edges similarly.

### What's actually duplicated

The **neighbor enumeration SQL** is nearly identical — only the WHERE clause and result mapping differ. The BFS/DFS loop scaffolding is textbook and short (~20 lines each).

### What's NOT worth centralizing

- The algorithms themselves (BFS vs DFS vs Dijkstra) have different return types, different filtering logic (`includeTests`, direction, weight), and different data shapes. A generic `traverseGraph()` would need so many parameters it'd be harder to read than the current 20-line implementations.
- The SQL queries are slightly different (directional vs undirected, JOIN for labels vs no JOIN). A "universal query builder" would obscure intent.

### Recommendation: Extract only the neighbor query

```ts
// query/db.ts (extend existing)
export function getNeighborEdges(
  db: Database,
  nodeId: string,
  direction: "outgoing" | "incoming" | "both"
): Array<{ source_id: string; target_id: string; type: string }> {
  const sql = direction === "outgoing"
    ? "SELECT source_id, target_id, type FROM edges WHERE source_id = ?"
    : direction === "incoming"
    ? "SELECT source_id, target_id, type FROM edges WHERE target_id = ?"
    : "SELECT source_id, target_id, type FROM edges WHERE source_id = ? OR target_id = ?";
  const params = direction === "both" ? [nodeId, nodeId] : [nodeId];
  return queryAll(db, sql, params);
}
```

Keep BFS/DFS/Dijkstra implementations inline — they're short, specialized, and readable as-is.

**Risk**: Low. Doesn't change algorithms, just extracts the SQL string.

---

## 8. Progress/ETA Timing

**14 `Date.now()` calls across 3 intelligence files.**

The exact same arithmetic repeats:

```ts
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
const avgMs = ((Date.now() - startTime) / (i + 1)).toFixed(0);
const remaining = (((Date.now() - startTime) / (i + 1)) * (total - i - 1) / 1000).toFixed(0);
log.info(`  [${i+1}/${total}] ${elapsed}s elapsed, ~${avgMs}ms/item, ~${remaining}s remaining`);
```

Found in:
- `intelligence/node-description-generator.ts` — 5 `Date.now()` calls
- `intelligence/community-summary-generator.ts` — 5 `Date.now()` calls
- `intelligence/embeddings.ts` — 4 `Date.now()` calls

### Recommendation

```ts
// shared/utils.ts
export class ProgressTimer {
  private start = Date.now();
  constructor(private total: number) {}

  tick(i: number): { elapsed: string; avgMs: string; remaining: string } {
    const ms = Date.now() - this.start;
    const done = i + 1;
    return {
      elapsed: (ms / 1000).toFixed(1),
      avgMs: (ms / done).toFixed(0),
      remaining: ((ms / done) * (this.total - done) / 1000).toFixed(0),
    };
  }
}
```

Usage: `const t = new ProgressTimer(nodes.length); ... const { elapsed, avgMs, remaining } = t.tick(i);`

**Risk**: Zero. Same arithmetic, fewer inline calculations.

---

## 9. `SyntaxNode` — Defined Twice

Two interfaces represent the same tree-sitter node:

| Location | Fields |
|----------|--------|
| `extract/types.ts:192` | Full: `type, text, startPosition, endPosition, children, childCount, namedChildren, namedChildCount, parent, childForFieldName, childrenForFieldName, descendantsOfType` |
| `outline/languages/types.ts:15` | Subset: `type, text, startPosition, endPosition, children, namedChildren, childForFieldName` |

The outline module defines a **strict subset** — fewer fields, same names, same shapes. Both represent `web-tree-sitter`'s `SyntaxNode`.

### Recommendation

Delete `SyntaxNode` from `outline/languages/types.ts` and import from `extract/types.ts`. The subset relationship means every `extract.SyntaxNode` is already a valid `outline.SyntaxNode` — the outline code just doesn't use the extra fields.

```ts
// outline/languages/types.ts
import type { SyntaxNode } from "../../extract/types.js";
export type { SyntaxNode };
```

**Risk**: Zero. The outline code only reads fields that exist on both interfaces. No runtime change.

---

## 10. Node Metadata Types — NO ACTION

Six types share `id/label/type/source_file/repo/community` fields:

```
GraphNode          shared/types.ts        — canonical graph node
SearchResult       shared/types.ts        — adds rank
ContextCandidate   shared/types.ts        — adds score, paths
NodeDetail         shared/types.ts        — adds edges, centrality
VectorRecord       query/vector-store.ts  — adds text, vector
NodeEmbeddingInput intelligence/embeddings.ts — adds signature, docstring
```

At first glance, extracting a `NodeMetadata` base interface and using `extends` seems appealing. But:

1. **These types serve different layers** — `GraphNode` is serialized to `graph.json`, `VectorRecord` goes to LanceDB, `SearchResult` is an API return type. Coupling them via inheritance means a field change in the base ripples across all layers.
2. **The "shared" fields are just 3-6 optional strings** — the duplication is ~5 lines per type, not complex logic.
3. **TypeScript structural typing already handles compatibility** — you can pass a `GraphNode` where a `{ id: string; label: string }` is expected without any shared interface.

### Verdict: Not worth centralizing.

The duplication is cosmetic (a few repeated field declarations), not behavioral. Coupling these types would be worse than the current repetition.

### Exception: `Float32Array` vs `number[]` for vectors

`EmbeddingResult.vector` is `Float32Array` (in-memory), `VectorRecord.vector` is `number[]` (serialized). This isn't a type to unify — it's an intentional boundary. But there's no explicit conversion helper; callers do `Array.from(vector)` inline. A small helper would document the boundary:

```ts
export function vectorToArray(v: Float32Array): number[] { return Array.from(v); }
```

---

## Strategic Refactoring Opportunities

Beyond deduplication, two structural improvements emerge from this audit.

### A. `shared/utils.ts` is a grab bag — split by concern

Currently `shared/utils.ts` contains:
- `getVersion()` — package metadata
- `normalizePath()` — path manipulation (unused)
- `log.*` — logging
- `formatNumber()`, `truncate()` — string formatting

After adding `toPosix()`, `errorMessage()`, and `ProgressTimer`, it'd have 8+ unrelated exports.

**Recommendation**: Split into focused modules:
- `shared/utils.ts` — keep `log`, `setLogLevel`, `formatNumber`, `truncate`, `errorMessage`
- `shared/paths.ts` — `toPosix`, `relativePosix`, `posixBasename` (replace dead `normalizePath`)
- `shared/fs.ts` — `readJsonSafe`, `readJsonOr` (new)
- `shared/atomic-write.ts` — keep as-is

`getVersion()` could move to `shared/version.ts` or stay — it's fine either way.

### B. `graph/loader.ts` builds adjacency maps duplicating what graph/builder already knows

`graph/loader.ts` has `buildAdjacencyMap()` and `buildNodeMap()` — these reconstruct in-memory structures from `graph.json` that the graph builder already had before serialization. This is expected (the loader reconstructs from disk), but there's no shared `AdjacencyMap` type. Adding one would make the data flow explicit:

```ts
// graph/loader.ts — already the right place
export interface AdjacencyMap {
  outgoing: Map<string, Array<{ target: string; type: string; weight: number }>>;
  incoming: Map<string, Array<{ source: string; type: string; weight: number }>>;
}
```

Then `shortest-path.ts` and any future in-memory traversal can import and use this type instead of rebuilding their own maps.

---

## Implementation Priority

Ordered by impact-to-effort ratio:

| Priority | Item | Impact | Effort |
|----------|------|--------|--------|
| 1 | `toPosix()` + `relativePosix()` + `posixBasename()` | 30+ replacements, eliminates most widespread duplication | Low — mechanical find/replace |
| 2 | `readJsonSafe<T>()` + `readJsonOr<T>()` | 22 replacements, eliminates scattered try/catch/guard patterns | Low — create helper, update callers |
| 3 | `errorMessage()` | 10 replacements | Trivial |
| 4 | `ProgressTimer` | 3 files, ~14 inline calculations | Trivial |
| 5 | Use `atomicWriteJson` in vector-store + export-json | 2 files, better crash safety | Trivial |
| 6 | Unify `SyntaxNode` (delete outline duplicate) | 1 file change | Trivial |
| 7 | Extract `getNeighborEdges()` from traversal code | 3 files, cleaner SQL management | Low |
| — | Delete dead `normalizePath()` from `shared/utils.ts` | Cleanup | Trivial |

Items 1-6 are safe, mechanical changes. Item 7 is optional — the traversal code is readable as-is.

---

## What NOT to Refactor

Things that look like duplication but aren't:

- **`mkdirSync` calls** — already idempotent, wrapper adds nothing
- **Node metadata type fields** — structural typing handles compatibility, coupling via inheritance is worse
- **BFS/DFS algorithms** — short, specialized, different return types; a generic version would be harder to read
- **`graphology` iteration** (`forEachNode`, `forEachEdge`) — each usage extracts different attributes for different purposes; wrapping the API adds indirection without reducing complexity
- **`console.error` in CLI** — `log.*` writes to stderr (for MCP stdio), but CLI commands legitimately use `console.error` for user-facing error output. Different audiences, different channels.
