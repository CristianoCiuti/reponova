# FIX-014 Report — Config change detection in orchestrator

**Date**: 2025-05-02
**Branch**: `develop`

## What was done

Created `config-diff.ts` module that compares the current build config against the previous build's config fingerprint stored in `graph.json` metadata (from FIX-013). Integrated it into the orchestrator to detect and log config changes, and to force outline regeneration when outline config changes.

## Files modified/created

| File | Change |
|------|--------|
| `src/build/config-diff.ts` | **NEW** — `loadPreviousBuildConfig()` function, `ConfigDiff` interface |
| `src/build/orchestrator.ts` | Import config-diff, call at build start, use `outlinesChanged` flag |
| `tests/config-diff.test.ts` | **NEW** — 11 unit tests |

## Design choices

- Each subsystem is compared independently (embeddings, outlines, community_summaries, node_descriptions) with individual boolean flags
- Arrays (outlines.paths, outlines.exclude) are compared via `JSON.stringify` for deep equality
- Model comparison uses `?? null` to normalize `undefined` and `null` (both mean "no LLM")
- First build or pre-FIX-013 builds are treated as `isFirstBuild: true` with no changes flagged
- Corrupted graph.json is handled gracefully (returns first-build state)

## Tests

11 tests covering:
- No graph.json → first build
- No build_config → first build
- Matching config → no changes
- Embeddings method/model/enabled changes
- Outlines paths change
- Community summaries model change
- Node descriptions threshold change
- Corrupted JSON handling
- Previous config preservation
