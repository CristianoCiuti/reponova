import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  let initializeResolver: (() => void) | null = null;
  let shouldRejectInit = false;

  const order: string[] = [];
  const initializeCalls: Array<{ embeddingsConfig?: unknown; cacheDir?: unknown }> = [];
  const buildContextCalls: Array<Record<string, unknown>> = [];
  const formatCalls: unknown[] = [];
  let instanceCount = 0;

  class MockContextBuilder {
    constructor(_db: unknown, _graphDir: string) {
      instanceCount += 1;
    }

    async initialize(embeddingsConfig?: unknown, cacheDir?: unknown): Promise<void> {
      initializeCalls.push({ embeddingsConfig, cacheDir });
      order.push(`initialize:${instanceCount}`);

      if (shouldRejectInit) {
        throw new Error("init failed");
      }

      await new Promise<void>((resolve) => {
        initializeResolver = () => {
          order.push(`initialize-resolved:${instanceCount}`);
          resolve();
        };
      });
    }

    async buildContext(args: Record<string, unknown>) {
      buildContextCalls.push(args);
      order.push(`build:${instanceCount}`);
      return {
        query: args.query as string,
        total_tokens: 1,
        max_tokens: 1,
        sections: [],
      };
    }

    formatAsText(result: unknown): string {
      formatCalls.push(result);
      return "formatted context";
    }

    async dispose(): Promise<void> {
      order.push(`dispose:${instanceCount}`);
    }
  }

  return {
    MockContextBuilder,
    get initializeResolver() {
      return initializeResolver;
    },
    set shouldRejectInit(value: boolean) {
      shouldRejectInit = value;
    },
    get shouldRejectInit() {
      return shouldRejectInit;
    },
    order,
    initializeCalls,
    buildContextCalls,
    formatCalls,
    reset() {
      initializeResolver = null;
      shouldRejectInit = false;
      order.length = 0;
      initializeCalls.length = 0;
      buildContextCalls.length = 0;
      formatCalls.length = 0;
      instanceCount = 0;
    },
  };
});

vi.mock("../src/core/context-builder.js", () => ({
  ContextBuilder: state.MockContextBuilder,
}));

describe("FIX-012: initContextBuilder race handling", () => {
  afterEach(async () => {
    const mod = await import("../src/mcp/tools/context.js");
    await mod.disposeContextBuilder();
    state.reset();
    vi.resetModules();
  });

  it("awaits in-flight initContextBuilder before handling a context request", async () => {
    const mod = await import("../src/mcp/tools/context.js");
    const db = {} as unknown;
    const initPromise = mod.initContextBuilder(db as never, "/graph", {
      enabled: true,
      method: "tfidf",
      model: "all-MiniLM-L6-v2",
      dimensions: 384,
      batch_size: 128,
    }, "~/.cache/reponova/models");

    const handlePromise = mod.handleContext(db as never, "/graph", { query: "auth flow" });
    await Promise.resolve();

    expect(state.buildContextCalls).toHaveLength(0);

    state.initializeResolver?.();
    const result = await handlePromise;
    await initPromise;

    expect(state.initializeCalls).toHaveLength(1);
    expect(state.buildContextCalls).toHaveLength(1);
    expect(state.order).toEqual(["initialize:1", "initialize-resolved:1", "build:1"]);
    expect(result).toEqual({
      content: [{ type: "text", text: "formatted context" }],
    });
  });

  it("falls back to lazy init when initContextBuilder was never called", async () => {
    const mod = await import("../src/mcp/tools/context.js");
    const db = {} as unknown;
    const handlePromise = mod.handleContext(db as never, "/graph", { query: "lazy init" });

    await Promise.resolve();
    state.initializeResolver?.();
    const result = await handlePromise;

    expect(state.initializeCalls).toHaveLength(1);
    expect(state.initializeCalls[0]).toEqual({ embeddingsConfig: undefined, cacheDir: undefined });
    expect(state.buildContextCalls).toHaveLength(1);
    expect(result).toEqual({
      content: [{ type: "text", text: "formatted context" }],
    });
  });

  it("swallows init errors so handleContext can recover with lazy init", async () => {
    const mod = await import("../src/mcp/tools/context.js");
    const db = {} as unknown;
    state.shouldRejectInit = true;

    await expect(mod.initContextBuilder(db as never, "/graph")).resolves.toBeUndefined();

    state.shouldRejectInit = false;
    const handlePromise = mod.handleContext(db as never, "/graph", { query: "recover" });
    await Promise.resolve();
    state.initializeResolver?.();
    const result = await handlePromise;

    expect(state.initializeCalls).toHaveLength(2);
    expect(state.buildContextCalls).toHaveLength(1);
    expect(result).toEqual({
      content: [{ type: "text", text: "formatted context" }],
    });
  });
});
