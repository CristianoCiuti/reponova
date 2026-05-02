# FIX-016 Report — Serialization of docstring/signature/bases in graph.json

**Date**: 2025-05-02
**Branch**: `develop`

## What was done

Fixed a bug where `docstring`, `signature`, and `bases` fields were not serialized in `graph.json`, causing `intelligence.ts` to always receive `undefined` for these fields. This degraded embedding quality for `graph_similar` and `graph_context` across all projects.

## Root cause chain

1. Python extractor correctly captures `docstring`, `signature`, `bases` per symbol
2. `graph-builder.ts` saved `docstring` and `signature` in graphology node attributes, but NOT `bases`
3. `export-json.ts` defined `JsonNode` without these fields → they were omitted from JSON
4. `intelligence.ts` reads `node.properties?.signature` etc. from graph.json → always `undefined`
5. `composeNodeText()` generated embeddings without signature/docstring/bases for all nodes

## Files modified

| File | Change |
|------|--------|
| `src/extract/export-json.ts` | Added `docstring`, `signature`, `bases` to `JsonNode` interface + conditional serialization |
| `src/extract/graph-builder.ts` | Added `bases: symbol.bases` to graphology node attributes |
| `tests/node-serialization.test.ts` | **NEW** — 7 unit tests covering all serialization scenarios |

## Design choices

- Empty/undefined fields are NOT written to JSON (no `"docstring": null` pollution)
- Empty `bases` arrays are NOT serialized (saves space, avoids noise)
- The `bases` field uses `Array.isArray()` check before serialization for type safety
- No changes needed in `intelligence.ts` — it already reads these fields correctly

## Tests

7 tests added, all passing:
1. Serializes docstring for nodes with docstrings
2. Serializes signature for functions with signatures
3. Serializes bases for classes with inheritance
4. Does NOT serialize empty/undefined fields
5. Does NOT serialize empty bases array
6. graph-builder stores bases in graphology attributes
7. Full pipeline: extraction → graph → export preserves all three fields

## Impact

After this fix, `composeNodeText()` will produce richer text for embeddings:
- Before: `authenticate_user`
- After: `authenticate_user (username: str, password: str) -> bool Authenticate a user against the database.`

This directly improves `graph_similar` and `graph_context` quality.
