/**
 * End-to-end tests for the per-plugin config threading introduced in v0.7.
 *
 * Covers three layers:
 *
 *   1. `mergePluginConfig` (pure function) — defaults + user overrides,
 *      reserved fields stripped.
 *   2. `setPluginConfig` / `getPluginConfig` / `clearPluginConfigs` —
 *      the registry round-trip.
 *   3. Pipeline propagation — `extractAll` forwards the registered
 *      config to `LanguageExtractor.extract()`, and `generateOutline`
 *      forwards it to `LanguageSupport.treeSitterExtract()` and
 *      `regexExtract()`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EMPTY_PLUGIN_CONFIG,
  clearPluginConfigs,
  getAllPluginConfigs,
  getPluginConfig,
  mergePluginConfig,
  registerExtractor,
  registerOutlineLanguage,
  setPluginConfig,
  type FileExtraction,
  type LanguageExtractor,
  type LanguageSupport,
  type SyntaxNode,
} from "../src/index.js";
import { extractAll } from "../src/extract/index.js";
import { generateOutline } from "../src/outline/index.js";

afterEach(() => {
  clearPluginConfigs();
});

describe("mergePluginConfig", () => {
  it("returns an empty frozen object when both inputs are undefined", () => {
    const out = mergePluginConfig(undefined, undefined);
    expect(out).toEqual({});
    expect(Object.isFrozen(out)).toBe(true);
  });

  it("returns just the defaults when the user config is undefined", () => {
    const out = mergePluginConfig({ maxKeys: 200, dialect: "pg" }, undefined);
    expect(out).toEqual({ maxKeys: 200, dialect: "pg" });
  });

  it("returns just the user config when defaults are undefined", () => {
    const out = mergePluginConfig(undefined, { maxKeys: 50 });
    expect(out).toEqual({ maxKeys: 50 });
  });

  it("overlays user overrides on top of defaults (user wins per-key)", () => {
    const out = mergePluginConfig(
      { maxKeys: 200, dialect: "pg", strict: false },
      { maxKeys: 50, strict: true },
    );
    expect(out).toEqual({ maxKeys: 50, dialect: "pg", strict: true });
  });

  it("strips the four loader-reserved fields from the merged result", () => {
    const out = mergePluginConfig(
      { maxKeys: 200, package: "should-be-stripped" },
      {
        package: "@reponova/lang-foo",
        enabled: true,
        patterns: ["**/*.foo"],
        exclude: ["dist/**"],
        maxKeys: 500,
        customKey: "kept",
      },
    );
    expect(out).toEqual({ maxKeys: 500, customKey: "kept" });
    expect(out).not.toHaveProperty("package");
    expect(out).not.toHaveProperty("enabled");
    expect(out).not.toHaveProperty("patterns");
    expect(out).not.toHaveProperty("exclude");
  });

  it("freezes the result so callers cannot accidentally mutate registry state", () => {
    const out = mergePluginConfig({ a: 1 }, { b: 2 });
    expect(() => {
      (out as Record<string, unknown>).c = 3;
    }).toThrow();
  });
});

describe("plugin-config registry round-trip", () => {
  it("returns undefined for unknown keys", () => {
    expect(getPluginConfig("nope")).toBeUndefined();
  });

  it("registers the same config under multiple lookup keys", () => {
    const cfg = mergePluginConfig({ maxKeys: 200 }, { maxKeys: 50 });
    setPluginConfig(["sql", "sql-extractor"], cfg);
    expect(getPluginConfig("sql")).toEqual({ maxKeys: 50 });
    expect(getPluginConfig("sql-extractor")).toEqual({ maxKeys: 50 });
    expect(getPluginConfig("sql")).toBe(getPluginConfig("sql-extractor"));
  });

  it("skips empty / falsy keys silently", () => {
    setPluginConfig(["", "json"], mergePluginConfig(undefined, { foo: "bar" }));
    expect(getPluginConfig("")).toBeUndefined();
    expect(getPluginConfig("json")).toEqual({ foo: "bar" });
  });

  it("last write wins for duplicate keys", () => {
    setPluginConfig(["plantuml"], mergePluginConfig({ a: 1 }, undefined));
    setPluginConfig(["plantuml"], mergePluginConfig({ b: 2 }, undefined));
    expect(getPluginConfig("plantuml")).toEqual({ b: 2 });
  });

  it("clearPluginConfigs wipes every registered key", () => {
    setPluginConfig(["a", "b"], mergePluginConfig({ x: 1 }, undefined));
    clearPluginConfigs();
    expect(getPluginConfig("a")).toBeUndefined();
    expect(getPluginConfig("b")).toBeUndefined();
    expect(getAllPluginConfigs().size).toBe(0);
  });

  it("getAllPluginConfigs exposes a defensive copy", () => {
    setPluginConfig(["a"], mergePluginConfig({ x: 1 }, undefined));
    const snapshot = getAllPluginConfigs();
    expect(snapshot.size).toBe(1);
    // Mutating the snapshot must not affect the registry
    (snapshot as Map<string, Readonly<Record<string, unknown>>>).clear();
    expect(getPluginConfig("a")).toEqual({ x: 1 });
  });

  it("EMPTY_PLUGIN_CONFIG is a frozen empty object", () => {
    expect(EMPTY_PLUGIN_CONFIG).toEqual({});
    expect(Object.isFrozen(EMPTY_PLUGIN_CONFIG)).toBe(true);
  });
});

describe("extract pipeline forwards pluginConfig to LanguageExtractor.extract()", () => {
  it("invokes extract() with the registered config (4th arg) for matching files", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "reponova-plugin-cfg-"));
    try {
      const filePath = "fake/sample.fakelang";
      mkdirSync(join(tmpRoot, "fake"), { recursive: true });
      writeFileSync(join(tmpRoot, "fake", "sample.fakelang"), "noop");

      const seen: Array<{ filePath: string; config: unknown }> = [];

      const fakeExtractor: LanguageExtractor = {
        languageId: "fakelang-extract",
        extract(_tree, _src, fp, pluginConfig) {
          seen.push({ filePath: fp, config: pluginConfig });
          return {
            filePath: fp,
            language: "fakelang",
            fileNode: { kind: "module" },
            symbols: [],
            imports: [],
            references: [],
          } satisfies FileExtraction;
        },
        resolveImportPath: () => [],
      };

      registerExtractor(fakeExtractor, [".fakelang"]);
      setPluginConfig(
        ["fakelang", fakeExtractor.languageId],
        mergePluginConfig({ aggressiveness: 7, mode: "strict" }, { mode: "lax" }),
      );

      const out = await extractAll(tmpRoot, [filePath]);
      expect(out).toHaveLength(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBeDefined();
      expect(seen[0]!.filePath).toBe(filePath);
      expect(seen[0]!.config).toEqual({ aggressiveness: 7, mode: "lax" });
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("passes `undefined` as the 4th arg when no config is registered for the language", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "reponova-plugin-cfg-"));
    try {
      const filePath = "fake/sample.nocfg";
      mkdirSync(join(tmpRoot, "fake"), { recursive: true });
      writeFileSync(join(tmpRoot, "fake", "sample.nocfg"), "noop");

      const seen: unknown[] = [];

      const fakeExtractor: LanguageExtractor = {
        languageId: "fakelang-no-config",
        extract(_tree, _src, fp, pluginConfig) {
          seen.push(pluginConfig);
          return {
            filePath: fp,
            language: "fakelang",
            fileNode: { kind: "module" },
            symbols: [],
            imports: [],
            references: [],
          } satisfies FileExtraction;
        },
        resolveImportPath: () => [],
      };

      registerExtractor(fakeExtractor, [".nocfg"]);
      // no setPluginConfig call → registry has no entry for this language

      await extractAll(tmpRoot, [filePath]);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBeUndefined();
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("outline pipeline forwards pluginConfig to LanguageSupport", () => {
  it("forwards the registered config to regexExtract() when no tree-sitter grammar is available", async () => {
    const seen: Array<{ method: string; config: unknown }> = [];

    const fakeSupport: LanguageSupport = {
      wasmFile: "", // empty → forces regex fallback
      treeSitterExtract(_root: SyntaxNode, _fp: string, _lc: number, cfg) {
        seen.push({ method: "treeSitter", config: cfg });
        return { filePath: "", language: "fakeoutline", lineCount: 0, symbols: [] };
      },
      regexExtract(_fp: string, _src: string, _lc: number, cfg) {
        seen.push({ method: "regex", config: cfg });
        return { filePath: _fp, language: "fakeoutline", lineCount: _lc, symbols: [] };
      },
    };

    registerOutlineLanguage("fakeoutline", ["fakeoutline"], fakeSupport);
    setPluginConfig(["fakeoutline"], mergePluginConfig({ flag: true }, undefined));

    const out = await generateOutline("nested/dir/sample.fakeoutline", "anything");
    expect(out).not.toBeNull();
    expect(seen).toEqual([{ method: "regex", config: { flag: true } }]);
  });

  it("returns null (without invoking the plugin) when the file extension is unknown", async () => {
    const out = await generateOutline("file.unknown-ext-zzz", "anything");
    expect(out).toBeNull();
  });

  it("forwards `undefined` when no config is registered for the outline language", async () => {
    const seen: unknown[] = [];
    const fakeSupport: LanguageSupport = {
      wasmFile: "",
      treeSitterExtract: () => ({ filePath: "", language: "x", lineCount: 0, symbols: [] }),
      regexExtract(_fp, _src, _lc, cfg) {
        seen.push(cfg);
        return { filePath: _fp, language: "fakeoutline-nocfg", lineCount: _lc, symbols: [] };
      },
    };

    registerOutlineLanguage("fakeoutline-nocfg", ["fakeoutline-nocfg"], fakeSupport);
    // no setPluginConfig

    await generateOutline("any.fakeoutline-nocfg", "anything");
    expect(seen).toEqual([undefined]);
  });
});

describe("backward compatibility — extractors written against the 3-arg signature still work", () => {
  it("ignoring the optional 4th param is a valid LanguageExtractor.extract implementation", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "reponova-plugin-cfg-"));
    try {
      mkdirSync(join(tmpRoot), { recursive: true });
      writeFileSync(join(tmpRoot, "legacy.legacyext"), "noop");

      const legacyExtractor: LanguageExtractor = {
        languageId: "legacy-extractor",
        // Exactly 3 args — older plugin shape; structural subtyping must accept it.
        extract(_tree, _src, fp) {
          return {
            filePath: fp,
            language: "legacy",
            fileNode: { kind: "module" },
            symbols: [],
            imports: [],
            references: [],
          } satisfies FileExtraction;
        },
        resolveImportPath: () => [],
      };

      registerExtractor(legacyExtractor, [".legacyext"]);
      setPluginConfig(["legacy-extractor"], mergePluginConfig({ irrelevant: true }, undefined));

      const out = await extractAll(tmpRoot, ["legacy.legacyext"]);
      expect(out).toHaveLength(1);
      expect(out[0]!.language).toBe("legacy");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
