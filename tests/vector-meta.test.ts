import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadVectorMeta, writeVectorMeta } from "../src/query/vector-meta.js";
import type { VectorMeta } from "../src/shared/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = join(tmpdir(), `rn-test-vector-meta-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

describe("vector-meta: loadVectorMeta / writeVectorMeta", () => {
  it("returns null when _meta.json does not exist", () => {
    const dir = makeTempDir();
    expect(loadVectorMeta(dir)).toBeNull();
  });

  it("writes and reads TF-IDF metadata (provider: null)", () => {
    const dir = makeTempDir();
    const meta: VectorMeta = {
      provider: null,
      models: null,
      dimensions: 384,
      record_count: 50,
      created_at: "2026-05-20T15:00:00.000Z",
    };

    writeVectorMeta(dir, meta);

    expect(existsSync(join(dir, "vectors", "_meta.json"))).toBe(true);
    expect(loadVectorMeta(dir)).toEqual(meta);
  });

  it("writes and reads ONNX metadata (provider with models)", () => {
    const dir = makeTempDir();
    const meta: VectorMeta = {
      provider: { type: "onnx", model: "all-MiniLM-L6-v2" },
      models: { cache_dir: "~/.cache/reponova/models", download_on_first_use: true },
      dimensions: 384,
      record_count: 100,
      created_at: "2026-05-20T16:00:00.000Z",
    };

    writeVectorMeta(dir, meta);

    const loaded = loadVectorMeta(dir);
    expect(loaded).toEqual(meta);
    expect(loaded!.provider!.type).toBe("onnx");
    expect(loaded!.provider!.model).toBe("all-MiniLM-L6-v2");
    expect(loaded!.models!.cache_dir).toBe("~/.cache/reponova/models");
  });

  it("writes and reads OpenAI metadata (provider with api_key ref)", () => {
    const dir = makeTempDir();
    const meta: VectorMeta = {
      provider: {
        type: "openai",
        model: "text-embedding-3-small",
        base_url: "https://api.openai.com/v1",
        api_key: "env:OPENAI_API_KEY",
        timeout: 30,
      },
      models: null,
      dimensions: 1536,
      record_count: 200,
      created_at: "2026-05-20T17:00:00.000Z",
    };

    writeVectorMeta(dir, meta);

    const loaded = loadVectorMeta(dir);
    expect(loaded).toEqual(meta);
    expect(loaded!.provider!.api_key).toBe("env:OPENAI_API_KEY");
  });

  it("creates vectors/ directory if it does not exist", () => {
    const dir = makeTempDir();
    expect(existsSync(join(dir, "vectors"))).toBe(false);

    writeVectorMeta(dir, {
      provider: null,
      models: null,
      dimensions: 384,
      record_count: 0,
      created_at: "2026-05-20T18:00:00.000Z",
    });

    expect(existsSync(join(dir, "vectors", "_meta.json"))).toBe(true);
  });

  it("overwrites existing _meta.json", () => {
    const dir = makeTempDir();

    writeVectorMeta(dir, {
      provider: null,
      models: null,
      dimensions: 384,
      record_count: 10,
      created_at: "2026-05-20T18:00:00.000Z",
    });

    writeVectorMeta(dir, {
      provider: { type: "onnx", model: "all-MiniLM-L6-v2" },
      models: { cache_dir: "/tmp/models", download_on_first_use: false },
      dimensions: 384,
      record_count: 20,
      created_at: "2026-05-20T19:00:00.000Z",
    });

    const loaded = loadVectorMeta(dir);
    expect(loaded!.record_count).toBe(20);
    expect(loaded!.provider!.type).toBe("onnx");
  });

  it("persists valid JSON on disk", () => {
    const dir = makeTempDir();
    writeVectorMeta(dir, {
      provider: null,
      models: null,
      dimensions: 384,
      record_count: 5,
      created_at: "2026-05-20T20:00:00.000Z",
    });

    const raw = readFileSync(join(dir, "vectors", "_meta.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.provider).toBeNull();
    expect(parsed.dimensions).toBe(384);
  });
});
