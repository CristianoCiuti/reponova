# FIX-013 Report — Extend GraphMetadata with BuildConfigFingerprint

**Date**: 2025-05-02
**Branch**: `develop`

## What was done

Added `BuildConfigFingerprint` to track the build configuration used to generate `graph.json`. This is a prerequisite for all subsequent incremental build safety improvements (FIX-014, FIX-015, PROP-I1, PROP-I4).

## Files modified

| File | Change |
|------|--------|
| `src/shared/types.ts` | Added `BuildConfigFingerprint` interface, extended `GraphMetadata` with mandatory `build_config` field |
| `src/extract/export-json.ts` | Added `Config` import, added `config` to `ExportJsonOptions`, build and write `build_config` to metadata |
| `src/extract/index.ts` | Added `Config` to imports, added `config` to `PipelineOptions`, propagated to `exportJson` calls |
| `src/build/orchestrator.ts` | Passed `config` to `runPipeline` options |
| `src/core/graph-loader.ts` | Parse `build_config` from metadata when loading graph.json |
| `tests/build-config-fingerprint.test.ts` | **NEW** — 6 unit tests covering write/read/custom config/LLM models/runtime param exclusion |

## Design choices

- `build_config` is typed as non-optional in `GraphMetadata`, but the `exportJson` function accepts `config?: Config` (optional) to maintain backward compatibility with tests that call `exportJson` directly without a config. When config is absent, `build_config` is written as `undefined` (omitted from JSON).
- Runtime-only parameters (`batch_size`, `context_size`, `gpu`, `threads`) are excluded from the fingerprint — they affect execution speed but not output content.
- The `config` flows through the pipeline chain: `runBuild` → `buildMonorepo` → `runPipeline` → `exportJson`.

## Tests

6 tests added, all passing:
1. Writes build_config with default config
2. Writes build_config with custom ONNX embeddings
3. Writes build_config with LLM model URIs
4. Omits build_config when no config provided
5. Excludes runtime-only params
6. graph-loader correctly parses build_config

## Difficulties

- Shallow spreading of `DEFAULT_CONFIG` in tests caused mutations across test cases (the `build.embeddings` object reference was shared). Fixed by deep-cloning via `JSON.parse(JSON.stringify(...))`.
