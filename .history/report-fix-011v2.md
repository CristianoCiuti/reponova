# FIX-011v2 Report

## Summary
- Added outline hash persistence in `.cache/outline-hashes.json` and integrated SHA-256 file hashing into outline generation.
- Updated outline generation to skip unchanged files only when both the stored hash matches and the outline artifact still exists.
- Added Vitest coverage for unchanged-file skipping and content-change-triggered regeneration.

## Files Changed
- `src/build/outlines.ts`
- `tests/outline-incremental.test.ts`

## Verification
- Targeted test command: `npx vitest run tests/outline-incremental.test.ts`
- Build verification: `npm run build`
