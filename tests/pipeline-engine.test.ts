import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Phase, PhaseContext, PhaseResult } from "../src/pipeline/engine/phase.js";
import { PhaseRegistry } from "../src/pipeline/engine/registry.js";
import {
  buildDAG,
  pruneDAG,
  resolveTransitiveDeps,
  topologicalLevels,
  validate,
} from "../src/pipeline/engine/dag.js";
import { orchestrate } from "../src/pipeline/engine/orchestrator.js";
import { BuildManifest, type ManifestData } from "../src/pipeline/engine/manifest.js";
import { ProviderRegistry } from "../src/intelligence/provider-registry.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `rn-test-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function createContext(): PhaseContext {
  return {
    config: {} as any,
    configDir: "/tmp",
    outputDir: testDir,
    workspace: "/tmp/ws",
    force: false,
    manifest: new BuildManifest(testDir),
    providerRegistry: new ProviderRegistry({}, { cache_dir: "~/.cache/reponova/models", gpu: "cpu", threads: 0, download_on_first_use: false }),
  };
}

function createPhase(options: {
  id: string;
  label?: string;
  dependencies?: string[];
  result?: PhaseResult;
  implementation?: (ctx: PhaseContext) => Promise<PhaseResult>;
}) {
  const result = options.result ?? { processed: 1, skipped: false };
  const execute = vi.fn(
    options.implementation ?? (async (_ctx: PhaseContext) => result),
  );

  const phase: Phase = {
    id: options.id,
    label: options.label ?? options.id,
    dependencies: options.dependencies ?? [],
    execute,
  };

  return { phase, execute };
}

function createRegistry(phases: Phase[]): PhaseRegistry {
  const registry = new PhaseRegistry();
  for (const phase of phases) {
    registry.register(phase);
  }
  return registry;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PhaseRegistry", () => {
  it("registers phases and retrieves them by id", () => {
    const registry = new PhaseRegistry();
    const { phase } = createPhase({ id: "graph", label: "Graph" });

    registry.register(phase);

    expect(registry.get("graph")).toBe(phase);
  });

  it("returns all phases", () => {
    const registry = new PhaseRegistry();
    const { phase: a } = createPhase({ id: "a" });
    const { phase: b } = createPhase({ id: "b" });

    registry.register(a);
    registry.register(b);

    expect(registry.getAll()).toEqual([a, b]);
  });

  it("reports whether a phase exists", () => {
    const registry = new PhaseRegistry();
    const { phase } = createPhase({ id: "a" });

    registry.register(phase);

    expect(registry.has("a")).toBe(true);
    expect(registry.has("missing")).toBe(false);
  });

  it("throws when registering a duplicate phase id", () => {
    const registry = new PhaseRegistry();
    const { phase } = createPhase({ id: "dup" });

    registry.register(phase);

    expect(() => registry.register(phase)).toThrow('Duplicate phase ID: "dup"');
  });
});

describe("DAG", () => {
  it("buildDAG creates a map from phases", () => {
    const { phase: a } = createPhase({ id: "a" });
    const { phase: b } = createPhase({ id: "b", dependencies: ["a"] });

    const dag = buildDAG([a, b]);

    expect(dag).toBeInstanceOf(Map);
    expect(dag.size).toBe(2);
    expect(dag.get("a")).toBe(a);
    expect(dag.get("b")).toBe(b);
  });

  it("validate passes for a valid dag", () => {
    const { phase: a } = createPhase({ id: "a" });
    const { phase: b } = createPhase({ id: "b", dependencies: ["a"] });
    const dag = buildDAG([a, b]);

    expect(() => validate(dag)).not.toThrow();
  });

  it("validate throws for a missing dependency", () => {
    const { phase: a } = createPhase({ id: "a", dependencies: ["missing"] });
    const dag = buildDAG([a]);

    expect(() => validate(dag)).toThrow('Phase "a" depends on "missing", which is not registered');
  });

  it("validate throws for cycles", () => {
    const { phase: a } = createPhase({ id: "a", dependencies: ["b"] });
    const { phase: b } = createPhase({ id: "b", dependencies: ["c"] });
    const { phase: c } = createPhase({ id: "c", dependencies: ["a"] });
    const dag = buildDAG([a, b, c]);

    expect(() => validate(dag)).toThrow("Cycle detected in phase DAG: a → b → c → a");
  });

  it("topologicalLevels groups independent phases together and dependents later", () => {
    const { phase: a } = createPhase({ id: "a" });
    const { phase: b } = createPhase({ id: "b" });
    const { phase: c } = createPhase({ id: "c", dependencies: ["a"] });
    const { phase: d } = createPhase({ id: "d", dependencies: ["a", "b"] });
    const { phase: e } = createPhase({ id: "e", dependencies: ["c"] });
    const dag = buildDAG([a, b, c, d, e]);

    const levels = topologicalLevels(dag);

    expect(levels.map((level) => level.map((phase) => phase.id))).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ]);
  });

  it("resolveTransitiveDeps returns the target and all transitive dependencies", () => {
    const { phase: a } = createPhase({ id: "a" });
    const { phase: b } = createPhase({ id: "b", dependencies: ["a"] });
    const { phase: c } = createPhase({ id: "c", dependencies: ["a"] });
    const { phase: d } = createPhase({ id: "d", dependencies: ["b", "c"] });
    const dag = buildDAG([a, b, c, d]);

    expect(resolveTransitiveDeps(dag, "d")).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("resolveTransitiveDeps throws for an unknown target", () => {
    const { phase: a } = createPhase({ id: "a" });
    const dag = buildDAG([a]);

    expect(() => resolveTransitiveDeps(dag, "missing")).toThrow('Target phase "missing" not found');
  });

  it("pruneDAG returns only the requested subset of phases", () => {
    const { phase: a } = createPhase({ id: "a" });
    const { phase: b } = createPhase({ id: "b", dependencies: ["a"] });
    const { phase: c } = createPhase({ id: "c", dependencies: ["b"] });
    const dag = buildDAG([a, b, c]);

    const pruned = pruneDAG(dag, new Set(["a", "c"]));

    expect([...pruned.keys()]).toEqual(["a", "c"]);
    expect(pruned.get("a")).toBe(a);
    expect(pruned.get("c")).toBe(c);
    expect(pruned.has("b")).toBe(false);
  });
});

describe("Orchestrator", () => {
  it("runs a full chain in dependency order and returns the build result", async () => {
    const order: string[] = [];
    const { phase: a, execute: executeA } = createPhase({
      id: "a",
      implementation: async (_ctx: PhaseContext) => {
        order.push("a");
        return { processed: 1, skipped: false };
      },
    });
    const { phase: b, execute: executeB } = createPhase({
      id: "b",
      dependencies: ["a"],
      implementation: async (_ctx: PhaseContext) => {
        order.push("b");
        return { processed: 2, skipped: false };
      },
    });
    const { phase: c, execute: executeC } = createPhase({
      id: "c",
      dependencies: ["b"],
      implementation: async (_ctx: PhaseContext) => {
        order.push("c");
        return { processed: 3, skipped: false };
      },
    });

    const result = await orchestrate(createRegistry([a, b, c]), createContext(), { force: false });

    expect(order).toEqual(["a", "b", "c"]);
    expect(executeA).toHaveBeenCalledOnce();
    expect(executeB).toHaveBeenCalledOnce();
    expect(executeC).toHaveBeenCalledOnce();
    expect(result.outputDir).toBe(testDir);
    expect(result.phases).toBeInstanceOf(Map);
    expect(result.phases.get("a")).toEqual({ processed: 1, skipped: false });
    expect(result.phases.get("b")).toEqual({ processed: 2, skipped: false });
    expect(result.phases.get("c")).toEqual({ processed: 3, skipped: false });
    expect(result.totalProcessed).toBe(6);
  });

  it("prunes execution to the target and its dependencies", async () => {
    const order: string[] = [];
    const { phase: a, execute: executeA } = createPhase({
      id: "a",
      implementation: async (_ctx: PhaseContext) => {
        order.push("a");
        return { processed: 1, skipped: false };
      },
    });
    const { phase: b, execute: executeB } = createPhase({
      id: "b",
      dependencies: ["a"],
      implementation: async (_ctx: PhaseContext) => {
        order.push("b");
        return { processed: 2, skipped: false };
      },
    });
    const { phase: c, execute: executeC } = createPhase({
      id: "c",
      dependencies: ["b"],
      implementation: async (_ctx: PhaseContext) => {
        order.push("c");
        return { processed: 3, skipped: false };
      },
    });

    const result = await orchestrate(createRegistry([a, b, c]), createContext(), {
      target: "b",
      force: false,
    });

    expect(order).toEqual(["a", "b"]);
    expect(executeA).toHaveBeenCalledOnce();
    expect(executeB).toHaveBeenCalledOnce();
    expect(executeC).not.toHaveBeenCalled();
    expect([...result.phases.keys()]).toEqual(["a", "b"]);
    expect(result.totalProcessed).toBe(3);
  });

  it("preserves skipped phase results", async () => {
    const skippedResult = { processed: 0, skipped: true, skipReason: "cached" } satisfies PhaseResult;
    const { phase } = createPhase({ id: "cache", result: skippedResult });

    const result = await orchestrate(createRegistry([phase]), createContext(), { force: false });

    expect(result.phases.get("cache")).toEqual(skippedResult);
    expect(result.totalProcessed).toBe(0);
  });

  it("catches phase errors and reports them as skipped", async () => {
    const { phase: ok } = createPhase({ id: "ok", result: { processed: 2, skipped: false } });
    const { phase: failing } = createPhase({
      id: "failing",
      implementation: async (_ctx: PhaseContext) => {
        throw new Error("boom");
      },
    });

    const result = await orchestrate(createRegistry([ok, failing]), createContext(), { force: false });

    expect(result.phases.get("ok")).toEqual({ processed: 2, skipped: false });
    expect(result.phases.get("failing")).toEqual({
      processed: 0,
      skipped: true,
      skipReason: "error: boom",
    });
    expect(result.totalProcessed).toBe(2);
  });

  it("executes independent phases in concurrency-limited batches", async () => {
    const starts: string[] = [];
    const aDeferred = createDeferred<PhaseResult>();
    const bDeferred = createDeferred<PhaseResult>();
    const { phase: a } = createPhase({
      id: "a",
      implementation: async (_ctx: PhaseContext) => {
        starts.push("a");
        return aDeferred.promise;
      },
    });
    const { phase: b } = createPhase({
      id: "b",
      implementation: async (_ctx: PhaseContext) => {
        starts.push("b");
        return bDeferred.promise;
      },
    });
    const { phase: c } = createPhase({
      id: "c",
      implementation: async (_ctx: PhaseContext) => {
        starts.push("c");
        return { processed: 1, skipped: false };
      },
    });

    const runPromise = orchestrate(createRegistry([a, b, c]), createContext(), {
      force: false,
      concurrency: 2,
    });

    await Promise.resolve();

    expect(starts).toEqual(["a", "b"]);

    aDeferred.resolve({ processed: 1, skipped: false });
    bDeferred.resolve({ processed: 1, skipped: false });

    const result = await runPromise;

    expect(starts).toEqual(["a", "b", "c"]);
    expect(result.totalProcessed).toBe(3);
  });
});

describe("BuildManifest", () => {
  it("records a phase entry and persists it to disk", () => {
    const manifest = new BuildManifest(testDir);
    manifest.record("test-phase", {
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
    });

    const raw = JSON.parse(readFileSync(join(testDir, "build-manifest.json"), "utf-8")) as ManifestData;
    expect(raw["test-phase"]).toEqual({
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
    });
  });

  it("preserves other phases when recording a new one", () => {
    const manifest = new BuildManifest(testDir);
    manifest.record("phase-a", {
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
    });
    manifest.record("phase-b", {
      status: "skipped",
      startedAt: "2026-01-01T00:00:01.000Z",
      finishedAt: "2026-01-01T00:00:01.010Z",
      durationMs: 10,
    });

    const raw = JSON.parse(readFileSync(join(testDir, "build-manifest.json"), "utf-8")) as ManifestData;
    expect(Object.keys(raw)).toEqual(["phase-a", "phase-b"]);
    expect(raw["phase-a"]!.status).toBe("completed");
    expect(raw["phase-b"]!.status).toBe("skipped");
  });

  it("overwrites the same phase entry on re-record", () => {
    const manifest = new BuildManifest(testDir);
    manifest.record("phase-x", {
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      durationMs: null,
    });
    manifest.record("phase-x", {
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:02.000Z",
      durationMs: 2000,
    });

    const raw = JSON.parse(readFileSync(join(testDir, "build-manifest.json"), "utf-8")) as ManifestData;
    expect(raw["phase-x"]!.status).toBe("completed");
    expect(raw["phase-x"]!.durationMs).toBe(2000);
  });

  it("works when manifest file does not exist yet", () => {
    const subDir = join(testDir, "sub");
    mkdirSync(subDir, { recursive: true });
    const manifest = new BuildManifest(subDir);

    expect(existsSync(join(subDir, "build-manifest.json"))).toBe(false);

    manifest.record("first", {
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.500Z",
      durationMs: 500,
    });

    expect(existsSync(join(subDir, "build-manifest.json"))).toBe(true);
    const raw = JSON.parse(readFileSync(join(subDir, "build-manifest.json"), "utf-8")) as ManifestData;
    expect(raw["first"]!.status).toBe("completed");
  });
});

describe("Orchestrator + Manifest integration", () => {
  it("failed phases are recorded as failed in the manifest", async () => {
    const { phase: ok } = createPhase({
      id: "ok",
      implementation: async (ctx: PhaseContext) => {
        const startedAt = new Date();
        ctx.manifest.record("ok", { status: "running", startedAt: startedAt.toISOString(), finishedAt: null, durationMs: null });
        const finishedAt = new Date();
        ctx.manifest.record("ok", { status: "completed", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
        return { processed: 1, skipped: false };
      },
    });
    const { phase: failing } = createPhase({
      id: "failing",
      implementation: async (ctx: PhaseContext) => {
        ctx.manifest.record("failing", { status: "running", startedAt: new Date().toISOString(), finishedAt: null, durationMs: null });
        throw new Error("boom");
      },
    });

    const ctx = createContext();
    await orchestrate(createRegistry([ok, failing]), ctx, { force: false });

    const raw = JSON.parse(readFileSync(join(testDir, "build-manifest.json"), "utf-8")) as ManifestData;
    expect(raw["ok"]!.status).toBe("completed");
    expect(raw["failing"]!.status).toBe("failed");
  });

  it("preserves real startedAt when collectResults catches an uncaught phase error (BUG-1)", async () => {
    const knownStart = "2026-01-01T10:00:00.000Z";
    const { phase: crashing } = createPhase({
      id: "crashing",
      implementation: async (ctx: PhaseContext) => {
        // Phase records "running" with a known timestamp, then crashes
        // without catching (simulates a bug bypassing the phase's try/catch)
        ctx.manifest.record("crashing", {
          status: "running",
          startedAt: knownStart,
          finishedAt: null,
          durationMs: null,
        });
        throw new Error("uncaught crash");
      },
    });

    const ctx = createContext();
    await orchestrate(createRegistry([crashing]), ctx, { force: false });

    const raw = JSON.parse(readFileSync(join(testDir, "build-manifest.json"), "utf-8")) as ManifestData;
    const entry = raw["crashing"]!;

    // collectResults must preserve the real startedAt from readEntry(), not use a new Date()
    expect(entry.status).toBe("failed");
    expect(entry.startedAt).toBe(knownStart);
    expect(entry.finishedAt).toBeTypeOf("string");
    // durationMs is computed from the real startedAt to the time collectResults finishes
    expect(entry.durationMs).toBeTypeOf("number");
    expect(entry.durationMs).toBeGreaterThan(0);
  });

  it("does not overwrite manifest when phase already recorded non-running status (BUG-2)", async () => {
    const phaseStart = "2026-01-01T12:00:00.000Z";
    const phaseFinish = "2026-01-01T12:00:05.000Z";
    const { phase: selfHandled } = createPhase({
      id: "self-handled",
      implementation: async (ctx: PhaseContext) => {
        // Phase records "failed" via its own try/catch, then re-throws
        // (simulates a phase that catches/records but forgets to return)
        ctx.manifest.record("self-handled", {
          status: "failed",
          startedAt: phaseStart,
          finishedAt: phaseFinish,
          durationMs: 5000,
        });
        throw new Error("re-thrown after recording failed");
      },
    });

    const ctx = createContext();
    await orchestrate(createRegistry([selfHandled]), ctx, { force: false });

    const raw = JSON.parse(readFileSync(join(testDir, "build-manifest.json"), "utf-8")) as ManifestData;
    const entry = raw["self-handled"]!;

    // collectResults must NOT overwrite because status is "failed", not "running"
    expect(entry.status).toBe("failed");
    expect(entry.startedAt).toBe(phaseStart);
    expect(entry.finishedAt).toBe(phaseFinish);
    expect(entry.durationMs).toBe(5000);
  });

  it("skipped phases are recorded as skipped in the manifest", async () => {
    const { phase } = createPhase({
      id: "cached",
      implementation: async (ctx: PhaseContext) => {
        const startedAt = new Date();
        ctx.manifest.record("cached", { status: "running", startedAt: startedAt.toISOString(), finishedAt: null, durationMs: null });
        const finishedAt = new Date();
        ctx.manifest.record("cached", { status: "skipped", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
        return { processed: 0, skipped: true, skipReason: "cached" };
      },
    });

    const ctx = createContext();
    await orchestrate(createRegistry([phase]), ctx, { force: false });

    const raw = JSON.parse(readFileSync(join(testDir, "build-manifest.json"), "utf-8")) as ManifestData;
    expect(raw["cached"]!.status).toBe("skipped");
    expect(raw["cached"]!.durationMs).toBeTypeOf("number");
    expect(raw["cached"]!.finishedAt).toBeTypeOf("string");
  });
});
