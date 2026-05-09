/**
 * Tests for BUG-E2E-005: tree-sitter WASM parser race condition fix.
 *
 * Validates that concurrent calls to parse() for the same grammar:
 * - Only invoke Language.load() once (not N times)
 * - Only invoke Parser.init() once (not N times)
 * - All callers receive the same parser instance
 * - Errors in init allow retry on next call
 * - Different grammars can load concurrently without interference
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// ─── Mock State ──────────────────────────────────────────────────────────────

const mock = vi.hoisted(() => {
  let initCallCount = 0;
  const loadCallCount = new Map<string, number>();
  let initDelay = 10;
  let loadDelay = 10;
  let shouldFailInit = false;
  let shouldFailLoad = false;
  const parserInstances: unknown[] = [];

  class MockParser {
    private lang: unknown = null;
    constructor() {
      parserInstances.push(this);
    }
    static async init(): Promise<void> {
      initCallCount++;
      if (shouldFailInit) throw new Error("mock init failure");
      await new Promise((r) => setTimeout(r, initDelay));
    }
    parse(input: string) {
      return { rootNode: { type: "program", text: input } };
    }
    setLanguage(lang: unknown) {
      this.lang = lang;
    }
  }

  class MockLanguage {
    static async load(wasmPath: string): Promise<{ name: string }> {
      const count = (loadCallCount.get(wasmPath) ?? 0) + 1;
      loadCallCount.set(wasmPath, count);
      if (shouldFailLoad) throw new Error("mock load failure");
      await new Promise((r) => setTimeout(r, loadDelay));
      return { name: wasmPath };
    }
  }

  return {
    MockParser,
    MockLanguage,
    get initCallCount() { return initCallCount; },
    get loadCallCount() { return loadCallCount; },
    get parserInstances() { return parserInstances; },
    set initDelay(v: number) { initDelay = v; },
    set loadDelay(v: number) { loadDelay = v; },
    set shouldFailInit(v: boolean) { shouldFailInit = v; },
    set shouldFailLoad(v: boolean) { shouldFailLoad = v; },
    reset() {
      initCallCount = 0;
      loadCallCount.clear();
      initDelay = 10;
      loadDelay = 10;
      shouldFailInit = false;
      shouldFailLoad = false;
      parserInstances.length = 0;
    },
  };
});

vi.mock("web-tree-sitter", () => ({
  Parser: mock.MockParser,
  Language: mock.MockLanguage,
}));

// Ensure grammar file "exists" for the mock
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: string) => {
      if (typeof p === "string" && p.includes("tree-sitter-")) return true;
      return actual.existsSync(p);
    },
  };
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("BUG-E2E-005: parser WASM race condition fix", () => {
  afterEach(async () => {
    // Reset module state between tests
    const mod = await import("../src/extract/parser.js");
    mod.clearParserCache();
    mock.reset();
    vi.resetModules();
  });

  it("concurrent parse() calls for the same grammar only call Language.load() once", async () => {
    const mod = await import("../src/extract/parser.js");
    mock.loadDelay = 50; // slow enough to ensure overlap

    // Fire 5 concurrent parse calls for the same grammar
    const results = await Promise.all([
      mod.parse("x = 1", "tree-sitter-python.wasm"),
      mod.parse("y = 2", "tree-sitter-python.wasm"),
      mod.parse("z = 3", "tree-sitter-python.wasm"),
      mod.parse("w = 4", "tree-sitter-python.wasm"),
      mod.parse("v = 5", "tree-sitter-python.wasm"),
    ]);

    // All should succeed
    for (const r of results) {
      expect(r).not.toBeNull();
      expect(r!.rootNode).toBeDefined();
    }

    // Parser.init() should be called exactly once
    expect(mock.initCallCount).toBe(1);

    // Language.load() should be called exactly once for this grammar
    const pythonLoads = [...mock.loadCallCount.values()].reduce((a, b) => a + b, 0);
    expect(pythonLoads).toBe(1);

    // Only one parser instance should be created
    expect(mock.parserInstances).toHaveLength(1);
  });

  it("concurrent parse() calls for different grammars load independently", async () => {
    const mod = await import("../src/extract/parser.js");
    mock.loadDelay = 30;

    const [r1, r2] = await Promise.all([
      mod.parse("x = 1", "tree-sitter-python.wasm"),
      mod.parse("fn main() {}", "tree-sitter-rust.wasm"),
    ]);

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();

    // Parser.init() called only once (shared runtime)
    expect(mock.initCallCount).toBe(1);

    // Language.load() called once per grammar
    expect(mock.loadCallCount.size).toBe(2);
    for (const count of mock.loadCallCount.values()) {
      expect(count).toBe(1);
    }

    // Two separate parser instances (one per grammar)
    expect(mock.parserInstances).toHaveLength(2);
  });

  it("sequential parse() calls for the same grammar reuse cached parser", async () => {
    const mod = await import("../src/extract/parser.js");

    await mod.parse("x = 1", "tree-sitter-python.wasm");
    await mod.parse("y = 2", "tree-sitter-python.wasm");
    await mod.parse("z = 3", "tree-sitter-python.wasm");

    // init + load only once
    expect(mock.initCallCount).toBe(1);
    const totalLoads = [...mock.loadCallCount.values()].reduce((a, b) => a + b, 0);
    expect(totalLoads).toBe(1);
    expect(mock.parserInstances).toHaveLength(1);
  });

  it("runtime init failure allows retry on next call", async () => {
    const mod = await import("../src/extract/parser.js");
    mock.shouldFailInit = true;

    // First call fails
    const r1 = await mod.parse("x = 1", "tree-sitter-python.wasm");
    expect(r1).toBeNull();

    // Reset failure, clear cache to allow retry
    mock.shouldFailInit = false;
    mod.clearParserCache();

    // Need fresh module import after clearParserCache to reset vi.resetModules state
    const mod2 = await import("../src/extract/parser.js");
    const r2 = await mod2.parse("x = 1", "tree-sitter-python.wasm");
    expect(r2).not.toBeNull();

    // init was called twice (first failed, second succeeded)
    expect(mock.initCallCount).toBe(2);
  });

  it("grammar load failure allows retry after cache clear", async () => {
    const mod = await import("../src/extract/parser.js");
    mock.shouldFailLoad = true;

    const r1 = await mod.parse("x = 1", "tree-sitter-python.wasm");
    expect(r1).toBeNull();

    mock.shouldFailLoad = false;
    mod.clearParserCache();

    const r2 = await mod.parse("x = 1", "tree-sitter-python.wasm");
    expect(r2).not.toBeNull();
  });

  it("concurrent calls during init failure all receive null", async () => {
    const mod = await import("../src/extract/parser.js");
    mock.shouldFailInit = true;
    mock.initDelay = 30;

    const results = await Promise.all([
      mod.parse("a = 1", "tree-sitter-python.wasm"),
      mod.parse("b = 2", "tree-sitter-python.wasm"),
      mod.parse("c = 3", "tree-sitter-python.wasm"),
    ]);

    // All should fail gracefully
    for (const r of results) {
      expect(r).toBeNull();
    }

    // init called only once (memoized even for failures)
    expect(mock.initCallCount).toBe(1);
  });

  it("concurrent calls during grammar load failure all receive null", async () => {
    const mod = await import("../src/extract/parser.js");
    mock.shouldFailLoad = true;
    mock.loadDelay = 30;

    const results = await Promise.all([
      mod.parse("a = 1", "tree-sitter-python.wasm"),
      mod.parse("b = 2", "tree-sitter-python.wasm"),
    ]);

    for (const r of results) {
      expect(r).toBeNull();
    }

    // Language.load called only once (in-flight memoization)
    const totalLoads = [...mock.loadCallCount.values()].reduce((a, b) => a + b, 0);
    expect(totalLoads).toBe(1);
  });
});
