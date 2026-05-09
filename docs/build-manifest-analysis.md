# Build Manifest & Phase Self-Tracking Analysis

Analysis of the current phase contract, what's missing, and what needs to change to make phases truly self-sufficient with integrated manifest tracking.

---

## Problem Statement

The pipeline is designed around independent, atomic phases that communicate via filesystem. But today the orchestrator compensates for responsibilities that should belong to each phase:

| Responsibility | Where it lives today | Where it should live |
|---|---|---|
| Timing (start/elapsed) | `orchestrator.executePhase()` | Phase itself |
| Log start/done/skipped | `orchestrator.executePhase()` | Phase itself |
| Error → skip conversion | `orchestrator.collectResults()` | Phase itself |
| **Execution tracking (manifest)** | **Nowhere** | **Phase itself** |

If you call `outlinesPhase.execute(ctx)` directly today — without the orchestrator — you get no timing, no standardized logging, no error handling, and no record that the phase ever ran. The orchestrator acts as a crutch.

The goal: each phase writes its own entry in a shared `build-manifest.json`, recording start time, end time, duration, and status. If called from the orchestrator, it works. If called standalone, it works identically.

---

## Current Phase Contract

```ts
// src/pipeline/engine/phase.ts

interface PhaseContext {
  config: Config;
  configDir: string;
  outputDir: string;
  workspace: string;
  force: boolean;
}

interface PhaseResult {
  processed: number;
  skipped: boolean;
  skipReason?: string;
}

interface Phase {
  readonly id: string;
  readonly label: string;
  readonly dependencies: string[];
  execute(ctx: PhaseContext): Promise<PhaseResult>;
}
```

Problems:
1. `PhaseResult` has no timing information — the orchestrator measures it externally
2. `PhaseContext` has no mechanism for the phase to write status — there's nothing to write to
3. `Phase.execute()` is a bare call — no lifecycle hooks for pre/post tracking

---

## Current Orchestrator Coupling

```ts
// src/pipeline/engine/orchestrator.ts — executePhase()

async function executePhase(phase: Phase, ctx: PhaseContext): Promise<PhaseResult> {
  log.info(`  [${phase.id}] ${phase.label}...`);     // ← orchestrator logs for the phase
  const start = Date.now();                            // ← orchestrator times the phase

  const result = await phase.execute(ctx);             // ← bare call
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (result.skipped) {
    log.info(`  [${phase.id}] Skipped: ${result.skipReason ?? "up to date"} (${elapsed}s)`);
  } else {
    log.info(`  [${phase.id}] Done: ${result.processed} processed (${elapsed}s)`);
  }

  return result;                                       // ← timing is lost, not in PhaseResult
}
```

```ts
// orchestrator.ts — collectResults()

if (outcome.status === "rejected") {
  const message = errorMessage(outcome.reason);
  log.warn(`  [${phase.id}] Failed (non-blocking): ${message}`);
  results.set(phase.id, {
    processed: 0,
    skipped: true,
    skipReason: `error: ${message}`,                   // ← orchestrator converts error to skip
  });
}
```

These are responsibilities the phase itself should own.

---

## Phase Independence Audit

Every phase was analyzed for true standalone capability:

| Phase | Can run standalone? | Filesystem dependencies |
|---|---|---|
| `file-detection` | ✅ Yes | None (walks workspace) |
| `graph` | ✅ Yes | `detected-files.json` |
| `communities` | ✅ Yes | `graph-nodes.json` |
| `community-summaries` | ✅ Yes | `graph.json` |
| `node-descriptions` | ✅ Yes | `graph.json` |
| `embeddings` | ✅ Yes | `graph.json`, summaries, descriptions |
| `search-index` | ✅ Yes | `graph.json` |
| `outlines` | ✅ Yes | `detected-files.json` |
| `html` | ✅ Yes | `graph.json`, summaries, descriptions |
| `report` | ✅ Yes | `graph.json`, summaries, descriptions |

All phases:
- Import only `Phase`/`PhaseContext`/`PhaseResult` types from the engine (no orchestrator imports)
- Communicate with other phases exclusively via filesystem
- Decide internally whether to skip (cache/config checks)
- Can be called with a manually-constructed `PhaseContext`

**The architecture is already independent. The contract just doesn't include self-tracking.**

---

## Proposed Design: Phase-Owned Manifest

### Manifest File

`outputDir/build-manifest.json` — a single shared file where each phase writes only its own entry:

```json
{
  "file-detection": {
    "status": "completed",
    "startedAt": "2026-05-09T14:30:01.123Z",
    "finishedAt": "2026-05-09T14:30:01.456Z",
    "durationMs": 333
  },
  "graph": {
    "status": "completed",
    "startedAt": "2026-05-09T14:30:01.460Z",
    "finishedAt": "2026-05-09T14:30:03.890Z",
    "durationMs": 2430
  },
  "embeddings": {
    "status": "skipped",
    "startedAt": "2026-05-09T14:30:04.001Z",
    "finishedAt": "2026-05-09T14:30:04.012Z",
    "durationMs": 11
  }
}
```

Each phase reads the existing manifest, updates **only its own key**, and writes back atomically. Other phases' entries are preserved.

### Updated PhaseContext

```ts
interface PhaseContext {
  config: Config;
  configDir: string;
  outputDir: string;
  workspace: string;
  force: boolean;
  manifest: BuildManifest;    // NEW — self-tracking handle
}
```

### BuildManifest Module

New file: `src/pipeline/engine/manifest.ts`

```ts
type PhaseStatus = "running" | "completed" | "skipped" | "failed";

interface PhaseManifestEntry {
  status: PhaseStatus;
  startedAt: string;           // ISO 8601
  finishedAt: string | null;   // null while running
  durationMs: number | null;   // null while running
}

class BuildManifest {
  private readonly manifestPath: string;

  constructor(outputDir: string) {
    this.manifestPath = join(outputDir, "build-manifest.json");
  }

  /** Called by a phase to record its own execution. */
  record(phaseId: string, entry: PhaseManifestEntry): void {
    const manifest = readJsonSafe<Record<string, PhaseManifestEntry>>(this.manifestPath) ?? {};
    manifest[phaseId] = entry;
    atomicWriteJson(this.manifestPath, manifest);
  }
}
```

Key properties:
- **Read-modify-write** — each `record()` call reads the current manifest, updates one key, writes atomically
- **No orchestrator involvement** — the phase calls `ctx.manifest.record()` directly
- **Concurrent safety** — phases within the same level run in parallel, but `atomicWriteJson` ensures no partial writes; read-modify-write is safe because each phase writes a different key
- **Standalone-safe** — if you construct `PhaseContext` manually with a `BuildManifest(outputDir)`, the phase self-tracks identically

### Phase Execution Pattern

Each phase would wrap its own execution:

```ts
async execute(ctx: PhaseContext): Promise<PhaseResult> {
  const startedAt = new Date();
  ctx.manifest.record(this.id, {
    status: "running",
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
  });

  // ... existing phase logic ...

  const finishedAt = new Date();
  ctx.manifest.record(this.id, {
    status: result.skipped ? "skipped" : "completed",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  });

  return result;
}
```

For failed phases (uncaught errors), the manifest shows `"status": "running"` with `finishedAt: null` — a crash indicator. The orchestrator's `collectResults` can optionally update this to `"failed"`, but even without it, a `"running"` entry with no `finishedAt` is an unambiguous signal.

### Orchestrator Changes

The orchestrator's `executePhase()` function becomes simpler — it no longer needs to time or log on behalf of phases. It still:
- Runs DAG ordering and parallelism
- Wraps `Promise.allSettled` for non-blocking failures
- Optionally updates crashed phases to `"failed"` status in the manifest

But the timing, logging, and tracking responsibilities shift to where they belong: the phase itself.

---

## Concurrency Consideration

Phases within the same level run in parallel (`Promise.allSettled`). Two phases calling `ctx.manifest.record()` at the same time:

1. Phase A reads manifest → `{ "file-detection": {...} }`
2. Phase B reads manifest → `{ "file-detection": {...} }`
3. Phase A writes manifest → `{ "file-detection": {...}, "graph": {...} }`
4. Phase B writes manifest → `{ "file-detection": {...}, "outlines": {...} }` — **graph entry lost**

This is a read-modify-write race. Mitigation options:

| Option | Trade-off |
|---|---|
| **File lock** (e.g. `proper-lockfile`) | Correct but adds a dependency |
| **Per-phase manifest files** (`build-manifest/<phase-id>.json`) | No contention, merge on read; more files |
| **In-memory mutex** (single-process guarantee) | Simple, correct for current architecture; doesn't survive process crash |
| **Append-only log** (JSONL) | No read-modify-write; slightly harder to query |

Recommended: **In-memory mutex** — the pipeline is single-process, phases within a level share the same event loop. A simple async lock (or serial write queue) eliminates the race with zero dependencies and minimal complexity. `atomicWriteJson` already handles file-level atomicity (no partial writes); the mutex handles logical atomicity (no lost updates).

If the architecture ever moves to multi-process phase execution, upgrade to per-phase files or a file lock.

---

## Impact on Existing Code

### Files to create
- `src/pipeline/engine/manifest.ts` — `BuildManifest` class

### Files to modify
- `src/pipeline/engine/phase.ts` — add `manifest: BuildManifest` to `PhaseContext`
- `src/pipeline/build.ts` — construct `BuildManifest` and include in `PhaseContext`
- `src/pipeline/engine/orchestrator.ts` — simplify `executePhase()` (remove timing/logging that phases now own)
- All 10 phase files — add `ctx.manifest.record()` calls at start and end

### Files unchanged
- `src/pipeline/engine/dag.ts` — pure graph algorithms, no phase awareness
- `src/pipeline/engine/registry.ts` — just registers phase instances
- All shared helpers, query, extract, graph modules — no phase awareness

### Boilerplate concern
Adding `manifest.record()` to all 10 phases is repetitive. Options to reduce:
- A base class or wrapper function that handles the manifest bookkeeping
- A higher-order function: `withManifest(phase)` that wraps `execute()` with automatic tracking
- Keep it explicit — 4 lines per phase, fully visible, no magic

Explicit is preferred: each phase controls exactly when it marks "running" and "completed", with full visibility. No hidden behavior.

---

## Summary

| Aspect | Today | After |
|---|---|---|
| Phase timing | Orchestrator measures externally | Phase self-measures |
| Phase logging | Orchestrator logs start/done | Phase logs its own lifecycle |
| Execution tracking | Nowhere (in-memory only) | `build-manifest.json`, phase-written |
| Standalone phase call | No tracking | Full tracking, identical to orchestrated |
| Orchestrator role | Times, logs, tracks, sequences | Sequences and parallelizes only |
