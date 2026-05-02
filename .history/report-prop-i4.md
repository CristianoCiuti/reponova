# PROP-I4 Report

## Summary
- Added deterministic semantic graph hashing that includes only structural/semantic node and edge fields and excludes volatile metadata like line numbers, community assignments, confidence, and weight.
- Cached the semantic hash in `.cache/semantic-graph-hash.txt` and integrated orchestrator skipping when the semantic graph is unchanged and config is unchanged.
- Added Vitest coverage for determinism, semantic change detection, volatility exclusion, and cache persistence.

## Files Changed
- `src/build/graph-hash.ts`
- `src/build/orchestrator.ts`
- `tests/graph-hash.test.ts`

## Verification
- Targeted test command: `npx vitest run tests/graph-hash.test.ts`
- Build verification: `npm run build`
