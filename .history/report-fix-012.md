# FIX-012 Report

## Summary
- Added `_initPromise` coordination in `src/mcp/tools/context.ts` so `handleContext()` waits for startup initialization before performing lazy initialization.
- Wrapped eager initialization in a non-throwing `_doInit()` path so failed startup init clears state and still allows lazy-init recovery.
- Added Vitest coverage for in-flight init waiting, direct lazy initialization, and recovery after eager-init failure.

## Files Changed
- `src/mcp/tools/context.ts`
- `tests/context-init-race.test.ts`

## Verification
- Targeted test command: `npx vitest run tests/context-init-race.test.ts`
- Build verification: `npm run build`
