# FIX-010v2 Report

## Summary
- Updated MCP startup to read embeddings configuration directly from `graph.json` metadata instead of inferring the method from artifact presence.
- Added status output for persisted build configuration and CLI checks for missing `build_config` plus metadata/artifact consistency mismatches.
- Added Vitest coverage for metadata-based embeddings resolution, missing metadata failures, status formatting, and artifact verification warnings/errors.

## Files Changed
- `src/core/build-config-metadata.ts`
- `src/mcp/server.ts`
- `src/mcp/tools/status.ts`
- `src/cli/check.ts`
- `tests/mcp-build-config.test.ts`

## Verification
- Targeted test command: `npx vitest run tests/mcp-build-config.test.ts`
- Build verification: `npm run build`
