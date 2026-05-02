# FIX-015 Report

## Summary
- Added `cleanStaleArtifacts()` in `src/build/artifact-cleanup.ts` to remove stale vectors, TF-IDF cache, outlines, community summaries, and node descriptions when config changes invalidate them.
- Wired cleanup into the build orchestrator immediately after config diff detection so stale outputs are removed before downstream phases run.
- Added exhaustive Vitest coverage for first-build no-op behavior, per-artifact cleanup scenarios, and preservation of unrelated artifacts.

## Files Changed
- `src/build/artifact-cleanup.ts`
- `src/build/orchestrator.ts`
- `tests/artifact-cleanup.test.ts`

## Verification
- Targeted test command: `npx vitest run tests/artifact-cleanup.test.ts`
- Build verification: `npm run build`
