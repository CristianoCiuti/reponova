# Post-Refactor Audit Report

Date: 2026-05-09
Branch: `refactor` (commits `d7a1ecb`..`2cbd10c` + audit fix commit)

## Scope

Systematic audit of all changes from the deduplication and phase-atomicity refactor.
Five parallel probes searched `src/` for deviations from the centralized helpers:

1. Inline path normalization (should use `toPosix`/`relativePosix`)
2. Non-atomic file writes (should use `atomicWrite*`)
3. Inline error message extraction (should use `errorMessage`)
4. Inline `JSON.parse(readFileSync(...))` (should use `readJsonSafe` where appropriate)
5. Dead imports / unused exports

## Findings & Fixes Applied

### 1. Non-Atomic Writes in Pipeline — FIXED

Two CRITICAL locations were writing pipeline artifacts with plain `writeFileSync`:

| File | Issue | Fix |
|------|-------|-----|
| `src/pipeline/cache.ts` | `writeFileSync` for `hashes.json` and extraction cache files | Replaced with `atomicWriteJson` |
| `src/pipeline/phases/outlines.ts` | Manual tmpRoot staging with `writeFileSync` + `copyFileSync` | Replaced with direct `atomicWriteText`, eliminated tmpRoot boilerplate |

Remaining `writeFileSync` in `src/` — all verified OK:
- `src/shared/atomic-write.ts` — internal implementation (must use low-level writes)
- `src/cli/install.ts` — installer writing editor config/plugin/skill files (not pipeline)
- `src/intelligence/embeddings.ts` — model cache download (not pipeline artifact)

### 2. Inline Error Message Extraction — FIXED

Three locations duplicated the `errorMessage()` logic inline:

| File | Before | After |
|------|--------|-------|
| `src/cli/models.ts` | `error instanceof Error ? error.message : String(error)` | `errorMessage(error)` |
| `src/mcp/server.ts` | `error instanceof Error ? error.message : String(error)` | `errorMessage(error)` |
| `src/pipeline/engine/orchestrator.ts` | `outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)` | `errorMessage(outcome.reason)` |

No remaining `(e as Error).message` unsafe cast patterns found.

### 3. Inline JSON.parse(readFileSync) — FIXED

Two locations needed conversion to `readJsonSafe`:

| File | Issue | Fix |
|------|-------|-----|
| `src/pipeline/build-config-metadata.ts` | `loadBuildConfigFingerprint` would throw on missing graph.json despite returning `null` type | Replaced with `readJsonSafe` — now returns `null` gracefully |
| `src/pipeline/phases/file-detection.ts` | `readDetectedFiles` had no guard for missing file | Replaced with `readJsonSafe` + explicit error with actionable message |

Remaining `JSON.parse(readFileSync(...))` — all verified intentional:
- Pipeline phases reading `graph.json` (node-descriptions, embeddings, community-summaries) — graph.json is required to exist by pipeline ordering; throwing is correct
- `src/graph/loader.ts` — graph loader, throwing is correct
- `src/pipeline/cache.ts` — `loadBuildCache` and `loadCachedExtraction` already have `existsSync` + `try/catch` guards
- `src/pipeline/phases/report.ts` — has `existsSync` check
- `src/graph/export-json.ts` — has `existsSync` + `try/catch`
- `src/shared/utils.ts` `getVersion()` — reads `package.json` with `try/catch` fallback
- `src/shared/fs.ts` — `readJsonSafe` implementation itself

### 4. Inline Path Normalization — FIXED

| File | Issue | Fix |
|------|-------|-----|
| `src/extract/parser.ts` | `new URL(...).pathname.replace(/^\/([A-Z]:)/, "$1")` — inline Windows drive-letter fix | Replaced with `fileURLToPath(new URL(".", import.meta.url))` — standard Node.js API, handles edge cases |

No remaining `.replace(/\\\\/g, '/')`, `.split(sep).join('/')`, or `import { sep }` patterns found outside `src/shared/paths.ts`.

### 5. Dead Imports / Unused Exports — CLEAN

- `normalizePath`: Confirmed 0 references in `src/` — successfully deleted
- `queryAll`: Still actively used in 10+ files across `query/` and `mcp/` — correctly kept
- `src/shared/path-resolver.ts`: Imported by 18+ files — correctly kept
- All shared module exports (`paths.ts`, `fs.ts`, `utils.ts`, `atomic-write.ts`) have active consumers
- `tsc --noEmit --noUnusedLocals`: **0 diagnostics** — no dead imports

## Verification

| Check | Result |
|-------|--------|
| `tsc --noEmit` | Clean (0 errors) |
| `tsc --noEmit --noUnusedLocals` | Clean (0 diagnostics) |
| `vitest run` | 28 files, 435 tests, all pass |
| `tsup` build | Success (ESM + DTS) |

## Remaining Intentional Patterns

These patterns were reviewed and intentionally kept as-is:

### writeFileSync (non-pipeline)
- `src/cli/install.ts` — 11 occurrences for editor config/plugin/skill file writes during installation
- `src/intelligence/embeddings.ts` — 1 occurrence for model download cache

### JSON.parse(readFileSync) (with guards)
- `src/pipeline/cache.ts` — 2 occurrences with `existsSync` + `try/catch`
- `src/pipeline/phases/report.ts` — 1 occurrence with `existsSync` + `try/catch`
- `src/graph/export-json.ts` — 1 occurrence with `existsSync` + `try/catch`
- `src/shared/utils.ts` — 1 occurrence with `try/catch` fallback

### Template literal error logging
- Several files use `${err}` in log messages (implicit toString). These are acceptable for debug/warn logging and don't need `errorMessage()`.

## Summary

The audit found **8 deviations** across 7 files. All were fixed and verified. The refactor is now fully consistent:

- **All pipeline/query/graph writes** use atomic helpers
- **All error message extraction** uses `errorMessage()`
- **All path normalization** uses `toPosix()`/`relativePosix()`/`fileURLToPath()`
- **All appropriate JSON reads** use `readJsonSafe()`
- **Zero dead imports or unused exports**
