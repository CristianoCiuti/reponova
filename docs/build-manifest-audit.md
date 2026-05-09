# Build Manifest Implementation Audit

Audit of the implementation against `docs/build-manifest-analysis.md`.

Date: 2026-05-09
Commit: `f58ddba`

---

## Methodology

4 parallel probes searched the codebase:
1. Orchestrator simplification check
2. Manifest record coverage at every return point
3. Phase self-logging check
4. Concurrency and crash handling verification

---

## Deviations

### DEV-1: Orchestrator NOT simplified (HIGH)

**Analysis said:**
> "The orchestrator's `executePhase()` function becomes simpler — it no longer needs to time or log on behalf of phases."
> Summary table: "Orchestrator role | Sequences and parallelizes only"

**Reality:** `executePhase()` still times AND logs on behalf of phases:

```ts
// src/pipeline/engine/orchestrator.ts — lines 119-133
async function executePhase(phase: Phase, ctx: PhaseContext): Promise<PhaseResult> {
  log.info(`  [${phase.id}] ${phase.label}...`);       // ← still logging start
  const start = Date.now();                              // ← still timing

  const result = await phase.execute(ctx);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (result.skipped) {
    log.info(`  [${phase.id}] Skipped: ${result.skipReason ?? "up to date"} (${elapsed}s)`);
  } else {
    log.info(`  [${phase.id}] Done: ${result.processed} processed (${elapsed}s)`);
  }
  // ← timing and logging still fully owned by orchestrator
  return result;
}
```

This duplicates the timing that phases now record in the manifest. The orchestrator measures elapsed time independently, while every phase also computes `durationMs` via `startedAt`/`finishedAt`. Two independent timing measurements exist for the same execution.

---

### DEV-2: Phases do NOT self-log their lifecycle (HIGH)

**Analysis said:**
> Summary table: "Phase logging | Phase logs its own lifecycle"

**Reality:** Zero phases log their own start/done/skipped lifecycle. Grep for `[phase-id]`-style log messages in phases returns no matches. Phases log domain-specific messages (e.g., `"127 source files"`, `"8 communities detected"`) but NOT lifecycle messages like `"[graph] Starting..."` or `"[graph] Done: 127 processed (2.4s)"`.

All lifecycle logging remains exclusively in `orchestrator.executePhase()`. If you call a phase directly (without the orchestrator), you get zero lifecycle logging — only domain-specific messages.

---

### DEV-3: Error → skip conversion still in orchestrator (MEDIUM)

**Analysis said:**
> Problem table: "Error → skip conversion | `orchestrator.collectResults()` | Phase itself"

**Reality:** `collectResults()` still catches rejected promises and converts them to skipped results:

```ts
// src/pipeline/engine/orchestrator.ts — lines 148-163
if (outcome.status === "rejected") {
  const message = errorMessage(outcome.reason);
  log.warn(`  [${phase.id}] Failed (non-blocking): ${message}`);
  ctx.manifest.record(phase.id, {
    status: "failed",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
  });
  results.set(phase.id, {
    processed: 0,
    skipped: true,
    skipReason: `error: ${message}`,
  });
}
```

Phases that throw uncaught errors don't get to record their own failure — the orchestrator does it for them. If you call a phase directly and it throws, nobody records "failed" in the manifest. The phase's last manifest state would be `"running"` with `finishedAt: null`.

This is a pragmatic safety net for the orchestrated flow, but it violates the "phase owns everything" principle from the analysis.

---

## Bugs

### BUG-1: Failed phase manifest has dummy timestamps (MEDIUM)

When the orchestrator records a "failed" entry, it uses `new Date().toISOString()` for BOTH `startedAt` and `finishedAt`, and sets `durationMs: 0`:

```ts
ctx.manifest.record(phase.id, {
  status: "failed",
  startedAt: new Date().toISOString(),   // ← NOT the phase's original startedAt
  finishedAt: new Date().toISOString(),   // ← timestamp when orchestrator caught the error
  durationMs: 0,                          // ← actual duration is lost
});
```

The phase already recorded `{ status: "running", startedAt: "2026-05-09T14:30:01.123Z", ... }` before throwing. The orchestrator overwrites this with a new `startedAt` that has no relation to when the phase actually started. The real start time and actual duration are lost.

**Expected:** The orchestrator should read the existing manifest entry to preserve the original `startedAt`, set `finishedAt` to now, and compute `durationMs` from the difference.

### BUG-2: Crash indicator behavior contradicts analysis (LOW)

**Analysis said:**
> "For failed phases (uncaught errors), the manifest shows `"status": "running"` with `finishedAt: null` — a crash indicator. The orchestrator's `collectResults` can optionally update this to `"failed"`."

**Reality:** The orchestrator ALWAYS overwrites `"running"` with `"failed"`. There's no way to distinguish between "the phase failed and the orchestrator caught it" vs. "the process crashed mid-phase" — both result in different manifest states depending on whether the orchestrator was involved.

This is not necessarily wrong (the analysis said "optionally"), but the behavior should be documented clearly. Currently the `"running"` crash indicator only works for standalone phase calls or actual process crashes, not for orchestrated failures.

---

## Verified Correct

### OK-1: Manifest record at every return point ✅

All 10 phases have `ctx.manifest.record()` at every return point. Verified via grep:

| Phase | manifest.record() calls | Return points | Match? |
|---|---|---|---|
| file-detection | 2 | 1 | ✅ (2 = 1 running + 1 return) |
| graph | 3 | 2 | ✅ |
| communities | 3 | 2 | ✅ |
| community-summaries | 5 | 4 | ✅ |
| node-descriptions | 6 | 5 | ✅ |
| embeddings | 6 | 5* | ✅ |
| search-index | 3 | 2 | ✅ |
| outlines | 5 | 4 | ✅ |
| html | 4 | 3 | ✅ |
| report | 3 | 2 | ✅ |

*embeddings has additional returns in helper functions `generateTfidf`/`generateOnnx` which are not inside `execute()` — manifest is recorded before/after calling these helpers.

### OK-2: Concurrency safety ✅

The analysis recommended an in-memory mutex. The implementation went simpler — direct synchronous read-modify-write — with the reasoning that `readJsonSafe` and `atomicWriteJson` are both synchronous, and JS is single-threaded.

**Verified correct.** Both functions use sync Node.js APIs:
- `readJsonSafe`: `existsSync` + `readFileSync`
- `atomicWriteJson`: `writeFileSync` + `mkdirSync` + `copyFileSync` + `unlinkSync`

Since `record()` is fully synchronous and JS can't context-switch during synchronous execution, the race scenario from the analysis (A reads → B reads → A writes → B writes, losing A's update) is impossible. This is valid for the current single-process architecture.

### OK-3: PhaseContext updated correctly ✅

`PhaseContext` includes `manifest: BuildManifest` as specified. `build.ts` constructs it with `new BuildManifest(outputDir)`.

### OK-4: BuildManifest module matches spec ✅

`src/pipeline/engine/manifest.ts` implements the exact types and API from the analysis:
- `PhaseStatus = "running" | "completed" | "skipped" | "failed"`
- `PhaseManifestEntry { status, startedAt, finishedAt, durationMs }`
- `BuildManifest.record(phaseId, entry)` — read-modify-write with atomicWriteJson

### OK-5: Tests cover manifest behavior ✅

6 new tests added (441 total, all pass):
- BuildManifest CRUD: record, preserve other keys, overwrite same key, create from scratch
- Orchestrator integration: failed phases → "failed" status, skipped phases → "skipped" status

### OK-6: Files unchanged as expected ✅

`dag.ts`, `registry.ts`, shared helpers, query, extract, and graph modules were not modified — matching the analysis.

---

## Summary

| Finding | Severity | Status |
|---|---|---|
| DEV-1: Orchestrator still times and logs | HIGH | Not fixed — duplicates phase responsibility |
| DEV-2: Phases don't self-log lifecycle | HIGH | Not implemented |
| DEV-3: Error→skip still in orchestrator | MEDIUM | Not moved to phases |
| BUG-1: Failed manifest has dummy timestamps | MEDIUM | Original startedAt lost on failure |
| BUG-2: Crash indicator always overwritten | LOW | "running" never survives in orchestrated flow |
| OK-1: Every return point has manifest.record | — | ✅ Correct |
| OK-2: Concurrency safety | — | ✅ Correct |
| OK-3: PhaseContext updated | — | ✅ Correct |
| OK-4: BuildManifest matches spec | — | ✅ Correct |
| OK-5: Tests adequate | — | ✅ Correct |
| OK-6: Unchanged files correct | — | ✅ Correct |
