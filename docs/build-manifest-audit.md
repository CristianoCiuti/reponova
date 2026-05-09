# Build Manifest Implementation Audit (Post-Fix)

Second audit after fixing DEV-1/2/3 and BUG-1/2 from the first audit.

Date: 2026-05-09
Commits: `fd39de1` (audit doc), `58e7dbd` (all fixes)
Previous audit: commit `f58ddba`

---

## Methodology

4 parallel probes searched the codebase (2 explore agents + 2 manual grep sets):
1. Orchestrator simplification — verify executePhase() and collectResults()
2. Phase self-logging lifecycle — verify all 10 phases log start/done/skipped/failed
3. Phase try/catch error handling — verify all 10 phases catch their own errors
4. Manifest readEntry and BUG-1/BUG-2 fix verification

---

## Previously Found Issues — All Fixed

### DEV-1: Orchestrator simplified ✅ FIXED

**Was:** `executePhase()` timed and logged on behalf of phases (Date.now, elapsed, log.info).

**Now:** `executePhase()` is a bare delegate (lines 122-124):

```ts
async function executePhase(phase: Phase, ctx: PhaseContext): Promise<PhaseResult> {
  return phase.execute(ctx);
}
```

No timing, no logging, no error handling. Orchestrator only sequences and parallelizes.

---

### DEV-2: Phases self-log lifecycle ✅ FIXED

**Was:** Zero phases logged their own lifecycle. All lifecycle logging was in the orchestrator.

**Now:** All 10 phases log their own lifecycle at every entry and exit point. Verified via grep — 42 lifecycle log calls across 10 phases:

| Phase | Start log | Done/Skipped/Failed logs | Return points | Match? |
|---|---|---|---|---|
| file-detection | 1 | 1 done + 1 failed | 2 (success + catch) | ✅ |
| graph | 1 | 2 done + 1 failed | 3 (empty + success + catch) | ✅ |
| communities | 1 | 1 skip + 1 done + 1 failed | 3 (skip + success + catch) | ✅ |
| community-summaries | 1 | 3 skip + 1 done + 1 failed | 5 (3 skip + success + catch) | ✅ |
| node-descriptions | 1 | 4 skip + 1 done + 1 failed | 6 (4 skip + success + catch) | ✅ |
| embeddings | 1 | 5 skip + 2 done + 1 failed | 8 (5 skip + 2 conditional + catch) | ✅ |
| search-index | 1 | 1 skip + 1 done + 1 failed | 3 (skip + success + catch) | ✅ |
| outlines | 1 | 3 skip + 1 done + 1 failed | 5 (3 skip + success + catch) | ✅ |
| html | 1 | 2 skip + 1 done + 1 failed | 4 (2 skip + success + catch) | ✅ |
| report | 1 | 1 skip + 1 done + 1 failed | 3 (skip + success + catch) | ✅ |

Log format matches original orchestrator format exactly:
- Start: `log.info(\`  [${this.id}] ${this.label}...\`)`
- Done: `log.info(\`  [${this.id}] Done: ${result.processed} processed (${elapsed}s)\`)`
- Skipped: `log.info(\`  [${this.id}] Skipped: <reason> (${elapsed}s)\`)`
- Failed: `log.warn(\`  [${this.id}] Failed: ${message} (${elapsed}s)\`)`

Standalone phase calls now produce identical lifecycle logging to orchestrated calls.

---

### DEV-3: Phases own error handling ✅ FIXED

**Was:** Phases threw uncaught errors; orchestrator `collectResults()` converted them to skipped results.

**Now:** All 10 phases wrap their `execute()` body in `try/catch`. Verified via grep:

| Phase | try/catch | errorMessage import | Records "failed" | Returns skip | log.warn |
|---|---|---|---|---|---|
| file-detection | ✅ | ✅ | ✅ | ✅ | ✅ |
| graph | ✅ | ✅ | ✅ | ✅ | ✅ |
| communities | ✅ | ✅ | ✅ | ✅ | ✅ |
| community-summaries | ✅ | ✅ | ✅ | ✅ | ✅ |
| node-descriptions | ✅ | ✅ | ✅ | ✅ | ✅ |
| embeddings | ✅ | ✅ | ✅ | ✅ | ✅ |
| search-index | ✅ | ✅ | ✅ | ✅ | ✅ |
| outlines | ✅ | ✅ | ✅ | ✅ | ✅ |
| html | ✅ | ✅ | ✅ | ✅ | ✅ |
| report | ✅ | ✅ | ✅ | ✅ | ✅ |

Each catch block:
1. Computes `finishedAt` and `elapsed`
2. Calls `errorMessage(err)` (imported from `../../shared/utils.js`)
3. Records `{ status: "failed", startedAt, finishedAt, durationMs }` in manifest
4. Logs `log.warn(\`  [${this.id}] Failed: ${message} (${elapsed}s)\`)`
5. Returns `{ processed: 0, skipped: true, skipReason: \`error: ${message}\` }`

Phases with inner resource cleanup (try/finally) are correctly nested:
- community-summaries: inner try/finally for `llmPool.disposeAll()`, outer try/catch for error conversion
- node-descriptions: same pattern for LLM pool
- embeddings: inner try/finally for `vectorStore.dispose()`, plus inner try/catch in `generateTfidf`/`generateOnnx` helpers

---

### BUG-1: Real timestamps preserved ✅ FIXED

**Was:** Orchestrator used `new Date().toISOString()` for both startedAt and finishedAt, losing the phase's original start time.

**Now:** `collectResults()` reads the existing manifest entry via `readEntry()` (lines 146-156):

```ts
const existing = ctx.manifest.readEntry(phase.id);
if (!existing || existing.status === "running") {
  const finishedAt = new Date();
  ctx.manifest.record(phase.id, {
    status: "failed",
    startedAt: existing?.startedAt ?? finishedAt.toISOString(),  // preserves real start
    finishedAt: finishedAt.toISOString(),
    durationMs: existing
      ? finishedAt.getTime() - new Date(existing.startedAt).getTime()  // real duration
      : 0,
  });
}
```

`BuildManifest.readEntry()` added (manifest.ts lines 36-39):
```ts
readEntry(phaseId: string): PhaseManifestEntry | undefined {
  const manifest = readJsonSafe<ManifestData>(this.manifestPath);
  return manifest?.[phaseId];
}
```

Types verified: `readEntry` returns `PhaseManifestEntry | undefined`, `existing?.startedAt` and `existing.status` are correctly typed.

---

### BUG-2: Crash indicator respected ✅ FIXED

**Was:** Orchestrator always overwrote "running" → "failed", making it impossible to distinguish orchestrated failure from process crash.

**Now:** `collectResults()` only writes "failed" when `!existing || existing.status === "running"` (line 147). If the phase already recorded "failed" (via its own try/catch), the orchestrator respects it and does not overwrite.

Manifest state by scenario:
- Phase catches error → manifest: "failed" (set by phase) — orchestrator does NOT overwrite
- Phase has uncaught error (orchestrated) → manifest: "failed" (set by safety net) — overwrites "running"
- Process crash (standalone) → manifest: "running" with `finishedAt: null` — crash indicator preserved

---

## New Findings

### DEV-A: Orchestrator safety net still converts errors to skipped results (LOW)

`collectResults()` lines 158-163 still log and convert rejected promises to skipped PhaseResult entries:

```ts
log.warn(`  [${phase.id}] Failed (non-blocking): ${message}`);
results.set(phase.id, {
  processed: 0,
  skipped: true,
  skipReason: `error: ${message}`,
});
```

**Assessment:** This is a SAFETY NET, not primary error handling. Since all 10 phases now have try/catch, this code path is only reachable when:
1. A phase's own try/catch has a bug
2. A truly exceptional condition (OOM, stack overflow)
3. A future phase is added without proper try/catch

The analysis doc explicitly says: *"The orchestrator's collectResults can optionally update this to 'failed'"* — this is that optional update. The `log.warn` uses `[${phase.id}]` prefix which resembles phase lifecycle logging, but semantically it is the orchestrator reporting its own catch, not logging on behalf of the phase.

**Verdict:** Intentional safety net. Not a violation.

---

### DEV-B: manifest.ts JSDoc mentions "in-memory mutex" but implementation uses sync read-modify-write (COSMETIC)

The file header comment says:
> "The manifest file is read-modify-write with an in-memory mutex to prevent lost updates"

But there is no mutex — the concurrency safety comes from synchronous read-modify-write (which is equivalent for single-threaded JS). This was validated as correct in OK-2 of the first audit.

**Verdict:** Misleading comment, not a code bug. JSDoc should say "synchronous read-modify-write" instead of "in-memory mutex".

---

### TEST-1: No test coverage for BUG-1 timestamp preservation (LOW)

The existing test "failed phases are recorded as failed in the manifest" (pipeline-engine.test.ts) only asserts `status === "failed"`. It does not verify:
- `startedAt` equals the phase's original start time (not a dummy timestamp)
- `durationMs` is computed from the real start/finish difference (not 0)

**Suggested test:** Create a phase that records "running" with a known `startedAt`, then throws. After orchestrate, assert the manifest entry has the same `startedAt` and `durationMs > 0`.

---

### TEST-2: No test coverage for BUG-2 non-overwrite guard (LOW)

No test verifies that `collectResults()` respects a pre-existing non-"running" manifest entry. If a phase records "failed" via its own try/catch and then somehow the Promise still rejects, the orchestrator should NOT overwrite.

**Suggested test:** Create a phase that records `{ status: "failed", startedAt: X, finishedAt: Y, durationMs: Z }`, then throws. After orchestrate, assert the manifest entry is unchanged (same timestamps and duration).

---

### EDGE-1: Malformed startedAt would produce NaN durationMs (VERY LOW)

In `collectResults()` line 154:
```ts
finishedAt.getTime() - new Date(existing.startedAt).getTime()
```

If `existing.startedAt` were a malformed ISO string, `new Date(malformed).getTime()` returns `NaN`, producing `durationMs: NaN`.

**Assessment:** Currently impossible — all code paths write valid ISO strings via `new Date().toISOString()`. No guard needed unless external manifest editing is supported.

---

## Verified Correct (Carried Forward + Re-verified)

### OK-1: Manifest record at every return point ✅

All 10 phases have `ctx.manifest.record()` at every return point, including the new catch blocks. Total manifest.record() calls: 42 (10 "running" + 22 completed/skipped + 10 failed).

### OK-2: Concurrency safety ✅

Synchronous read-modify-write. No interleaving possible in single-threaded JS. Unchanged.

### OK-3: PhaseContext updated correctly ✅

`manifest: BuildManifest` in PhaseContext, constructed in `build.ts`. Unchanged.

### OK-4: BuildManifest module matches spec ✅

Now includes `readEntry()` in addition to `record()`. Types and API match analysis.

### OK-5: Tests cover manifest behavior ✅

441 tests pass. 6 manifest-specific tests. E2E pipeline tests verify lifecycle logging output matches expected format (visible in test stderr output).

### OK-6: Files unchanged as expected ✅

`dag.ts`, `registry.ts`, shared helpers, query, extract, graph modules — not modified. Unchanged.

### OK-7: Analysis summary table fully satisfied ✅

| Aspect | Analysis "After" | Implementation | Match? |
|---|---|---|---|
| Phase timing | Phase self-measures | `startedAt`/`finishedAt`/`elapsed` in all 10 phases | ✅ |
| Phase logging | Phase logs its own lifecycle | 42 lifecycle logs across 10 phases | ✅ |
| Execution tracking | `build-manifest.json`, phase-written | `ctx.manifest.record()` at every entry/exit | ✅ |
| Standalone phase call | Full tracking, identical to orchestrated | try/catch + manifest + logging all internal | ✅ |
| Orchestrator role | Sequences and parallelizes only | `executePhase()` = bare delegate | ✅ |

---

## Summary

| Finding | Severity | Status |
|---|---|---|
| DEV-1: Orchestrator timing/logging | HIGH | ✅ Fixed — executePhase() is bare delegate |
| DEV-2: Phases don't self-log | HIGH | ✅ Fixed — 42 lifecycle logs across 10 phases |
| DEV-3: Error→skip in orchestrator | MEDIUM | ✅ Fixed — all 10 phases have try/catch |
| BUG-1: Dummy timestamps | MEDIUM | ✅ Fixed — readEntry() preserves real startedAt |
| BUG-2: Crash indicator overwritten | LOW | ✅ Fixed — only overwrites "running" status |
| DEV-A: Safety net still in collectResults | LOW | Intentional — analysis says "optionally" |
| DEV-B: JSDoc says "mutex" | COSMETIC | Misleading comment, not a code bug |
| TEST-1: No test for timestamp preservation | LOW | Test gap — suggested test provided |
| TEST-2: No test for non-overwrite guard | LOW | Test gap — suggested test provided |
| EDGE-1: Malformed ISO → NaN | VERY LOW | Impossible with current code paths |
| OK-1 through OK-7 | — | ✅ All verified correct |
