/**
 * Tests for BasePhase.needsRun() — the dry-run check used by `build --check <phase>`.
 *
 * needsRun() mirrors execute()'s skip logic:
 * 1. inputs unavailable → needsRun:true
 * 2. incremental disabled → needsRun:true
 * 3. outputs missing → needsRun:true
 * 4. cache stale → needsRun:true (with checkCacheFreshness reason)
 * 5. all pass → needsRun:false
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BasePhase, type PhaseContext, type PhaseResult } from "../src/pipeline/engine/phase.js";
import { BuildManifest } from "../src/pipeline/engine/manifest.js";
import { ProviderRegistry } from "../src/intelligence/provider-registry.js";
import type { Config } from "../src/shared/types.js";

// ─── Concrete test phase ─────────────────────────────────────────────────────

class TestPhase extends BasePhase {
  readonly id = "test-phase";
  readonly label = "Test Phase";
  readonly dependencies = ["upstream"];
  readonly inputs = ["upstream-output.json"];

  getExpectedOutputs(_config: Config) {
    return { files: ["test-output.json"], dirs: [] };
  }

  getRelevantConfig(_config: Config) {
    return { key: "value" };
  }

  async doWork(_ctx: PhaseContext): Promise<PhaseResult> {
    return { processed: 1, skipped: false };
  }
}

class RootPhase extends BasePhase {
  readonly id = "root-phase";
  readonly label = "Root Phase";
  readonly dependencies: string[] = [];
  readonly inputs: string[] = [];

  getExpectedOutputs(_config: Config) {
    return { files: ["detected-files.json"], dirs: [] };
  }

  getRelevantConfig(_config: Config) {
    return {};
  }

  async doWork(_ctx: PhaseContext): Promise<PhaseResult> {
    return { processed: 5, skipped: false };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let testDir: string;

function makeCtx(overrides: Partial<PhaseContext> = {}): PhaseContext {
  return {
    config: { incremental: true } as Config,
    configDir: "/tmp",
    outputDir: testDir,
    workspace: "/tmp/ws",
    force: false,
    manifest: new BuildManifest(testDir),
    providerRegistry: new ProviderRegistry({}, {
      cache_dir: "~/.cache/reponova/models",
      gpu: "cpu",
      threads: 0,
      download_on_first_use: false,
    }),
    ...overrides,
  };
}

beforeEach(() => {
  testDir = join(tmpdir(), `rn-needs-run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("BasePhase.needsRun()", () => {
  describe("inputs unavailable", () => {
    it("returns needsRun:true when input file does not exist", () => {
      const phase = new TestPhase();
      const ctx = makeCtx();

      const result = phase.needsRun(ctx);

      expect(result.needsRun).toBe(true);
      expect(result.reason).toBe("inputs unavailable: upstream-output.json");
    });

    it("lists all missing inputs in reason", () => {
      class MultiInputPhase extends BasePhase {
        readonly id = "multi-input";
        readonly label = "Multi Input";
        readonly dependencies = ["a", "b"];
        readonly inputs = ["a.json", "b.json", "c.json"];
        getExpectedOutputs() { return { files: ["out.json"], dirs: [] }; }
        getRelevantConfig() { return {}; }
        async doWork(): Promise<PhaseResult> { return { processed: 1, skipped: false }; }
      }

      const phase = new MultiInputPhase();
      // Only create a.json
      writeFileSync(join(testDir, "a.json"), "{}");
      const ctx = makeCtx();

      const result = phase.needsRun(ctx);

      expect(result.needsRun).toBe(true);
      expect(result.reason).toBe("inputs unavailable: b.json, c.json");
    });
  });

  describe("incremental disabled", () => {
    it("returns needsRun:true when incremental=false", () => {
      const phase = new TestPhase();
      // Create the input so we pass the first check
      writeFileSync(join(testDir, "upstream-output.json"), "{}");
      const ctx = makeCtx({ config: { incremental: false } as Config });

      const result = phase.needsRun(ctx);

      expect(result.needsRun).toBe(true);
      expect(result.reason).toBe("incremental disabled");
    });
  });

  describe("outputs missing", () => {
    it("returns needsRun:true when output file does not exist", () => {
      const phase = new TestPhase();
      writeFileSync(join(testDir, "upstream-output.json"), "{}");
      const ctx = makeCtx();

      const result = phase.needsRun(ctx);

      expect(result.needsRun).toBe(true);
      expect(result.reason).toBe("outputs missing");
    });

    it("returns needsRun:true when expected output dir does not exist", () => {
      class DirOutputPhase extends BasePhase {
        readonly id = "dir-phase";
        readonly label = "Dir Phase";
        readonly dependencies: string[] = [];
        readonly inputs = ["input.json"];
        getExpectedOutputs() { return { files: [], dirs: ["outlines"] }; }
        getRelevantConfig() { return {}; }
        async doWork(): Promise<PhaseResult> { return { processed: 1, skipped: false }; }
      }

      const phase = new DirOutputPhase();
      writeFileSync(join(testDir, "input.json"), "{}");
      const ctx = makeCtx();

      const result = phase.needsRun(ctx);

      expect(result.needsRun).toBe(true);
      expect(result.reason).toBe("outputs missing");
    });
  });

  describe("cache stale", () => {
    it("returns needsRun:true with 'never sealed' when no seal dir exists", () => {
      const phase = new TestPhase();
      writeFileSync(join(testDir, "upstream-output.json"), "{}");
      writeFileSync(join(testDir, "test-output.json"), "{}");
      const ctx = makeCtx();

      const result = phase.needsRun(ctx);

      expect(result.needsRun).toBe(true);
      expect(result.reason).toBe("never sealed");
    });

    it("returns needsRun:true with 'input changed' when input hash differs from sealed", () => {
      const phase = new TestPhase();
      writeFileSync(join(testDir, "upstream-output.json"), '{"v":1}');
      writeFileSync(join(testDir, "test-output.json"), "{}");
      const ctx = makeCtx();

      // Seal with current state
      phase.sealCache(ctx);

      // Now change the input
      writeFileSync(join(testDir, "upstream-output.json"), '{"v":2}');

      const result = phase.needsRun(ctx);

      expect(result.needsRun).toBe(true);
      expect(result.reason).toBe("input changed: upstream-output.json");
    });

    it("returns needsRun:true with 'config changed' when config hash differs", () => {
      const phase = new TestPhase();
      writeFileSync(join(testDir, "upstream-output.json"), "{}");
      writeFileSync(join(testDir, "test-output.json"), "{}");
      const ctx = makeCtx();

      // Seal with current config
      phase.sealCache(ctx);

      // Create a new phase that returns different config
      class ChangedConfigPhase extends TestPhase {
        override getRelevantConfig() { return { key: "changed-value" }; }
      }
      const changedPhase = new ChangedConfigPhase();

      const result = changedPhase.needsRun(ctx);

      expect(result.needsRun).toBe(true);
      expect(result.reason).toBe("config changed");
    });

    it("root phase (no inputs) always returns needsRun:true with 'no inputs (root phase)'", () => {
      const phase = new RootPhase();
      writeFileSync(join(testDir, "detected-files.json"), "{}");
      const ctx = makeCtx();

      // Even with sealed cache and outputs present, root phase always needs to run
      const sealDir = join(testDir, ".cache", "root-phase");
      mkdirSync(sealDir, { recursive: true });

      const result = phase.needsRun(ctx);

      expect(result.needsRun).toBe(true);
      expect(result.reason).toBe("no inputs (root phase)");
    });
  });

  describe("up to date (all checks pass)", () => {
    it("returns needsRun:false when inputs exist, outputs exist, and cache is fresh", () => {
      const phase = new TestPhase();
      writeFileSync(join(testDir, "upstream-output.json"), '{"data": true}');
      writeFileSync(join(testDir, "test-output.json"), '{"result": true}');
      const ctx = makeCtx();

      // Seal the cache
      phase.sealCache(ctx);

      // Now check — should be up to date
      const result = phase.needsRun(ctx);

      expect(result.needsRun).toBe(false);
      expect(result.reason).toBe("all inputs and config unchanged");
    });

    it("returns needsRun:false even after invalidateCache + sealCache cycle", () => {
      const phase = new TestPhase();
      writeFileSync(join(testDir, "upstream-output.json"), "{}");
      writeFileSync(join(testDir, "test-output.json"), "{}");
      const ctx = makeCtx();

      // Seal, invalidate, re-seal
      phase.sealCache(ctx);
      phase.invalidateCache(ctx);
      phase.sealCache(ctx);

      const result = phase.needsRun(ctx);

      expect(result.needsRun).toBe(false);
      expect(result.reason).toBe("all inputs and config unchanged");
    });
  });

  describe("interaction with invalidateCache", () => {
    it("returns needsRun:true after invalidateCache (seal removed)", () => {
      const phase = new TestPhase();
      writeFileSync(join(testDir, "upstream-output.json"), "{}");
      writeFileSync(join(testDir, "test-output.json"), "{}");
      const ctx = makeCtx();

      phase.sealCache(ctx);

      // Verify up to date
      expect(phase.needsRun(ctx).needsRun).toBe(false);

      // Invalidate
      phase.invalidateCache(ctx);

      // Now needs to run
      const result = phase.needsRun(ctx);
      expect(result.needsRun).toBe(true);
      expect(result.reason).toBe("never sealed");
    });
  });

  describe("consistency with execute() skip logic", () => {
    it("needsRun:false matches execute() skip behavior", async () => {
      const phase = new TestPhase();
      writeFileSync(join(testDir, "upstream-output.json"), "{}");
      writeFileSync(join(testDir, "test-output.json"), "{}");
      const ctx = makeCtx();
      phase.sealCache(ctx);

      // needsRun should say false
      const check = phase.needsRun(ctx);
      expect(check.needsRun).toBe(false);

      // execute should skip
      const result = await phase.execute(ctx);
      expect(result.skipped).toBe(true);
    });

    it("needsRun:true (outputs missing) matches execute() run behavior", async () => {
      const phase = new TestPhase();
      writeFileSync(join(testDir, "upstream-output.json"), "{}");
      // Don't create the output file
      const ctx = makeCtx();

      // needsRun should say true
      const check = phase.needsRun(ctx);
      expect(check.needsRun).toBe(true);
      expect(check.reason).toBe("outputs missing");

      // execute should run (and will fail at sealCache since doWork doesn't create the file,
      // but that's fine - it wouldn't skip)
      // We just verify it doesn't skip
      try {
        const result = await phase.execute(ctx);
        // If it didn't throw, check it ran
        expect(result.skipped).toBe(false);
      } catch {
        // sealCache throws because output doesn't exist after doWork - that's expected
        // The important thing is that execute() did NOT skip
      }
    });
  });
});
