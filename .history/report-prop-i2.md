# PROP-I2 Report

## Summary
- Added selective intelligence skip flags so embeddings, community summaries, and node descriptions can be regenerated independently.
- Updated the orchestrator to detect config-only rebuilds with zero source changes and run only the affected subsystems, while skipping indexer and unrelated downstream phases.
- Added a targeted orchestrator test that verifies summary-only config changes trigger only summary regeneration and dependent community/report refreshes.

## Files Changed
- `src/build/intelligence.ts`
- `src/build/orchestrator.ts`
- `tests/orchestrator-selective-subsystems.test.ts`

## Verification
- Targeted test command: `npx vitest run tests/orchestrator-selective-subsystems.test.ts`
- Build verification: `npm run build`
