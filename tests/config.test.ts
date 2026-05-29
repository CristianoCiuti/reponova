import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../src/shared/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("loadConfig", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns default config when no file exists", () => {
    // Run from a temp dir so we don't pick up the project's reponova.yml
    const tmpDir = mkdtempSync(join(tmpdir(), "rn-test-config-"));
    tmpDirs.push(tmpDir);
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { config } = loadConfig(undefined);
      expect(config.output).toBe("reponova-out");
      expect(config.repos).toEqual([]);
      expect(config.incremental).toBe(true);
      expect(config.patterns).toEqual([]);
      expect(config.exclude).toEqual([]);
      expect(config.enrich.enabled).toBe(true);
      expect(config.enrich.max_communities).toBe(0);
      expect(config.enrich.threshold).toBe(0.8);
      expect(config.models.gpu).toBe("auto");
      expect(config.models.cache_dir).toBe("~/.cache/reponova/models");
      expect(config.models.download_on_first_use).toBe(true);
      expect(config.outlines.enabled).toBe(true);
      expect(config.providers).toEqual({});
      expect(config.embeddings.enabled).toBe(true);
      expect(config.embeddings.batch_size).toBe(128);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("returns default enrich.max_tokens per step", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rn-test-config-"));
    tmpDirs.push(tmpDir);
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { config } = loadConfig(undefined);
      expect(config.enrich.max_tokens).toEqual({
        descriptions: 32768,
        profiles: 2048,
        routing: 8192,
        restructure: 4096,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("returns default enrich.profile limits", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rn-test-config-"));
    tmpDirs.push(tmpDir);
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { config } = loadConfig(undefined);
      expect(config.enrich.profile).toEqual({
        max_nodes: 80,
        max_edges: 50,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("returns default enrich.restructure_max_pairs", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rn-test-config-"));
    tmpDirs.push(tmpDir);
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { config } = loadConfig(undefined);
      expect(config.enrich.restructure_max_pairs).toBe(20);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("throws on non-existent explicit path", () => {
    expect(() => loadConfig("/nonexistent/path/config.yml")).toThrow("Config file not found");
  });
});
