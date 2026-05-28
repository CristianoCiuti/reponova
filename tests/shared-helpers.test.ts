import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  toPosix,
  relativePosix,
  posixBasename,
} from "../src/shared/paths.js";
import { readJsonSafe, readJsonOr } from "../src/shared/fs.js";
import { errorMessage, ProgressTimer, countTokens } from "../src/shared/utils.js";
import {
  atomicWriteJson,
  atomicWriteText,
  atomicWriteBuffer,
} from "../src/shared/atomic-write.js";
import {
  formatCommunityName,
  loadCommunityLabels,
} from "../src/shared/community-labels.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `rn-test-helpers-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("shared/paths", () => {
  describe("toPosix", () => {
    it("converts backslashes to forward slashes", () => {
      expect(toPosix("src\\foo\\bar.ts")).toBe("src/foo/bar.ts");
    });

    it("leaves already-posix paths unchanged", () => {
      expect(toPosix("src/foo/bar.ts")).toBe("src/foo/bar.ts");
    });

    it("returns empty string unchanged", () => {
      expect(toPosix("")).toBe("");
    });

    it("normalizes mixed slashes", () => {
      expect(toPosix("src/foo\\bar.ts")).toBe("src/foo/bar.ts");
    });
  });

  describe("relativePosix", () => {
    it("returns a relative posix path for absolute inputs", () => {
      const from = resolve(tmpDir, "src");
      const to = resolve(tmpDir, "src", "shared", "paths.ts");

      expect(relativePosix(from, to)).toBe("shared/paths.ts");
    });

    it("returns an empty string for the same directory", () => {
      expect(relativePosix(tmpDir, tmpDir)).toBe("");
    });
  });

  describe("posixBasename", () => {
    it("extracts basename from a nested path", () => {
      expect(posixBasename("src/foo/bar.ts")).toBe("bar.ts");
    });

    it("returns the input when there is no directory", () => {
      expect(posixBasename("bar.ts")).toBe("bar.ts");
    });

    it("returns empty string for empty input", () => {
      expect(posixBasename("")).toBe("");
    });

    it("returns empty string for a trailing slash", () => {
      expect(posixBasename("src/foo/")).toBe("");
    });
  });
});

describe("shared/fs", () => {
  describe("readJsonSafe", () => {
    it("parses a valid JSON file", () => {
      const filePath = join(tmpDir, "valid.json");
      writeFileSync(filePath, JSON.stringify({ ok: true, count: 2 }));

      expect(readJsonSafe<{ ok: boolean; count: number }>(filePath)).toEqual({
        ok: true,
        count: 2,
      });
    });

    it("returns undefined for a non-existent file", () => {
      expect(readJsonSafe(join(tmpDir, "missing.json"))).toBeUndefined();
    });

    it("returns undefined for invalid JSON", () => {
      const filePath = join(tmpDir, "invalid.json");
      writeFileSync(filePath, "{not valid json");

      expect(readJsonSafe(filePath)).toBeUndefined();
    });

    it("supports a type parameter", () => {
      const filePath = join(tmpDir, "typed.json");
      writeFileSync(filePath, JSON.stringify({ name: "RepoNova" }));

      const result = readJsonSafe<{ name: string }>(filePath);
      expect(result?.name).toBe("RepoNova");
    });
  });

  describe("readJsonOr", () => {
    it("parses a valid JSON file", () => {
      const filePath = join(tmpDir, "or-valid.json");
      const fallback = { ok: false };
      writeFileSync(filePath, JSON.stringify({ ok: true }));

      expect(readJsonOr(filePath, fallback)).toEqual({ ok: true });
    });

    it("returns fallback for a non-existent file", () => {
      const fallback = { ok: false, source: "fallback" };

      expect(readJsonOr(join(tmpDir, "or-missing.json"), fallback)).toBe(fallback);
    });

    it("returns fallback for invalid JSON", () => {
      const filePath = join(tmpDir, "or-invalid.json");
      const fallback = { ok: false, source: "fallback" };
      writeFileSync(filePath, "invalid json");

      expect(readJsonOr(filePath, fallback)).toBe(fallback);
    });
  });
});

describe("shared/utils", () => {
  describe("errorMessage", () => {
    it("returns the message from an Error instance", () => {
      expect(errorMessage(new Error("boom"))).toBe("boom");
    });

    it("returns a string input unchanged", () => {
      expect(errorMessage("plain error")).toBe("plain error");
    });

    it("stringifies numbers", () => {
      expect(errorMessage(42)).toBe("42");
    });

    it("stringifies null", () => {
      expect(errorMessage(null)).toBe("null");
    });

    it("stringifies undefined", () => {
      expect(errorMessage(undefined)).toBe("undefined");
    });
  });

  describe("ProgressTimer", () => {
    it("tick(0) on the first item returns elapsed, avgMs, and remaining", () => {
      const originalNow = Date.now;
      let now = 1_000;
      Date.now = () => now;

      try {
        const timer = new ProgressTimer(4);
        now = 2_500;

        expect(timer.tick(0)).toEqual({
          elapsed: "1.5",
          avgMs: "1500",
          remaining: "5",
        });
      } finally {
        Date.now = originalNow;
      }
    });

    it("tick(i) returns string values and not NaN", () => {
      const originalNow = Date.now;
      let now = 5_000;
      Date.now = () => now;

      try {
        const timer = new ProgressTimer(3);
        now = 5_900;

        const result = timer.tick(1);
        expect(typeof result.elapsed).toBe("string");
        expect(typeof result.avgMs).toBe("string");
        expect(typeof result.remaining).toBe("string");
        expect(result.elapsed).not.toBe("NaN");
        expect(result.avgMs).not.toBe("NaN");
        expect(result.remaining).not.toBe("NaN");
      } finally {
        Date.now = originalNow;
      }
    });

    it("elapsedSec returns a string representation of seconds", () => {
      const originalNow = Date.now;
      let now = 10_000;
      Date.now = () => now;

      try {
        const timer = new ProgressTimer(2);
        now = 11_234;

        expect(timer.elapsedSec()).toBe("1.2");
      } finally {
        Date.now = originalNow;
      }
    });

    it("remaining decreases as progress increases", () => {
      const originalNow = Date.now;
      let now = 20_000;
      Date.now = () => now;

      try {
        const timer = new ProgressTimer(5);
        now = 21_000;
        const first = Number(timer.tick(0).remaining);

        now = 21_100;
        const second = Number(timer.tick(1).remaining);

        expect(second).toBeLessThan(first);
      } finally {
        Date.now = originalNow;
      }
    });
  });
});

describe("shared/atomic-write", () => {
  describe("atomicWriteJson", () => {
    it("writes valid JSON that can be parsed back", () => {
      const filePath = join(tmpDir, "data.json");
      const data = { name: "RepoNova", count: 2 };

      atomicWriteJson(filePath, data);

      expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual(data);
    });

    it("creates parent directories when needed", () => {
      const filePath = join(tmpDir, "nested", "deep", "data.json");

      atomicWriteJson(filePath, { ok: true });

      expect(existsSync(filePath)).toBe(true);
      expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual({ ok: true });
    });

    it("overwrites an existing file atomically", () => {
      const filePath = join(tmpDir, "replace.json");
      writeFileSync(filePath, JSON.stringify({ version: 1 }));

      atomicWriteJson(filePath, { version: 2 });

      expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual({ version: 2 });
    });
  });

  describe("atomicWriteText", () => {
    it("writes text content that can be read back", () => {
      const filePath = join(tmpDir, "note.txt");

      atomicWriteText(filePath, "hello world");

      expect(readFileSync(filePath, "utf-8")).toBe("hello world");
    });

    it("creates parent directories", () => {
      const filePath = join(tmpDir, "text", "nested", "note.txt");

      atomicWriteText(filePath, "nested text");

      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf-8")).toBe("nested text");
    });
  });

  describe("atomicWriteBuffer", () => {
    it("writes a Buffer that can be read back", () => {
      const filePath = join(tmpDir, "data.bin");
      const buffer = Buffer.from([1, 2, 3, 4]);

      atomicWriteBuffer(filePath, buffer);

      expect(readFileSync(filePath)).toEqual(buffer);
    });

    it("works with Uint8Array", () => {
      const filePath = join(tmpDir, "bytes.bin");
      const bytes = new Uint8Array([9, 8, 7]);

      atomicWriteBuffer(filePath, bytes);

      expect(readFileSync(filePath)).toEqual(Buffer.from(bytes));
    });
  });
});

describe("shared/community-labels", () => {
  describe("formatCommunityName", () => {
    it("returns algorithmic label as-is", () => {
      expect(formatCommunityName("0", "Community 0")).toBe("Community 0");
    });

    it("appends ID to LLM-generated label", () => {
      expect(formatCommunityName("0", "Auth & Session")).toBe("Auth & Session (community 0)");
    });

    it("works with numeric ID", () => {
      expect(formatCommunityName(3, "Community 3")).toBe("Community 3");
      expect(formatCommunityName(3, "Data Pipeline")).toBe("Data Pipeline (community 3)");
    });

    it("handles multi-digit IDs", () => {
      expect(formatCommunityName("12", "Community 12")).toBe("Community 12");
      expect(formatCommunityName("12", "Logging Utils")).toBe("Logging Utils (community 12)");
    });
  });

  describe("loadCommunityLabels", () => {
    it("loads labels from community_summaries.json", () => {
      const summaries = [
        { id: "0", label: "Auth & Session", summary: "Auth module" },
        { id: "1", label: "Community 1", summary: "Misc" },
      ];
      writeFileSync(join(tmpDir, "community_summaries.json"), JSON.stringify(summaries));

      const labels = loadCommunityLabels(tmpDir);
      expect(labels.get("0")).toBe("Auth & Session");
      expect(labels.get("1")).toBe("Community 1");
      expect(labels.size).toBe(2);
    });

    it("coerces numeric IDs to strings", () => {
      const summaries = [{ id: 5, label: "Numeric ID", summary: "test" }];
      writeFileSync(join(tmpDir, "community_summaries.json"), JSON.stringify(summaries));

      const labels = loadCommunityLabels(tmpDir);
      expect(labels.get("5")).toBe("Numeric ID");
    });

    it("returns empty map when file does not exist", () => {
      const labels = loadCommunityLabels(join(tmpDir, "nonexistent"));
      expect(labels.size).toBe(0);
    });

    it("returns empty map on invalid JSON", () => {
      writeFileSync(join(tmpDir, "community_summaries.json"), "{broken");
      const labels = loadCommunityLabels(tmpDir);
      expect(labels.size).toBe(0);
    });
  });
});

// ─── countTokens ─────────────────────────────────────────────────────────────

describe("countTokens", () => {
  it("uses js-tiktoken (not fallback) and returns accurate token counts", () => {
    // "hello world" is 2 tokens with gpt-4o tokenizer
    // The fallback (Math.ceil(11/4)) would return 3
    const result = countTokens("hello world");
    expect(result).toBe(2);
  });

  it("counts code tokens accurately", () => {
    const code = `function add(a, b) { return a + b; }`;
    const tokens = countTokens(code);
    // tiktoken gives a precise count; fallback would give Math.ceil(36/4) = 9
    // tiktoken for gpt-4o gives ~12 tokens for this code
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(20);
    // Key assertion: NOT the fallback value
    expect(tokens).not.toBe(Math.ceil(code.length / 4));
  });

  it("handles empty string", () => {
    expect(countTokens("")).toBe(0);
  });

  it("handles multiline code", () => {
    const code = `class Foo:\n    def bar(self):\n        return 42\n`;
    const tokens = countTokens(code);
    expect(tokens).toBeGreaterThan(0);
    // Must differ from naive estimate for this input
    expect(tokens).not.toBe(Math.ceil(code.length / 4));
  });
});
