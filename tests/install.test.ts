import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../src/cli/install.js";

const {
  resolveJsonConfigPath,
  readJsoncText,
  setJsoncProperty,
  withTrailingNewline,
} = _testing;

// ─── setJsoncProperty ────────────────────────────────────────────────────────

describe("setJsoncProperty", () => {
  it("sets a top-level property on an empty object", () => {
    const result = setJsoncProperty("{}", ["foo"], "bar");
    expect(JSON.parse(result)).toEqual({ foo: "bar" });
  });

  it("sets a nested property, creating intermediates", () => {
    const result = setJsoncProperty("{}", ["mcp", "reponova"], { type: "local" });
    expect(JSON.parse(result)).toEqual({ mcp: { reponova: { type: "local" } } });
  });

  it("preserves existing keys when adding a new nested key", () => {
    const input = JSON.stringify({ mcp: { other: true }, version: 1 }, null, 2);
    const result = setJsoncProperty(input, ["mcp", "reponova"], { added: true });
    const parsed = JSON.parse(result);
    expect(parsed.mcp.other).toBe(true);
    expect(parsed.mcp.reponova).toEqual({ added: true });
    expect(parsed.version).toBe(1);
  });

  it("preserves single-line comments in JSONC", () => {
    const input = [
      "{",
      '  // This is my important comment',
      '  "existing": true',
      "}",
    ].join("\n");
    const result = setJsoncProperty(input, ["added"], "value");
    expect(result).toContain("// This is my important comment");
    expect(result).toContain('"existing": true');
    expect(result).toContain('"added": "value"');
  });

  it("preserves block comments in JSONC", () => {
    const input = [
      "{",
      "  /* block comment */",
      '  "key": 1',
      "}",
    ].join("\n");
    const result = setJsoncProperty(input, ["key2"], 2);
    expect(result).toContain("/* block comment */");
    expect(result).toContain('"key": 1');
  });

  it("preserves inline comments on existing properties", () => {
    const input = [
      "{",
      '  "host": "localhost", // development server',
      '  "port": 3000',
      "}",
    ].join("\n");
    const result = setJsoncProperty(input, ["debug"], true);
    expect(result).toContain("// development server");
    expect(result).toContain('"host": "localhost"');
  });

  it("overwrites an existing property value", () => {
    const input = JSON.stringify({ mcp: { reponova: { old: true } } }, null, 2);
    const result = setJsoncProperty(input, ["mcp", "reponova"], { new: true });
    const parsed = JSON.parse(result);
    expect(parsed.mcp.reponova).toEqual({ new: true });
  });

  it("sets an array value", () => {
    const result = setJsoncProperty("{}", ["plugins"], ["a.js", "b.js"]);
    expect(JSON.parse(result)).toEqual({ plugins: ["a.js", "b.js"] });
  });
});

// ─── withTrailingNewline ─────────────────────────────────────────────────────

describe("withTrailingNewline", () => {
  it("adds newline when missing", () => {
    expect(withTrailingNewline("{}")).toBe("{}\n");
  });

  it("does not double newline", () => {
    expect(withTrailingNewline("{}\n")).toBe("{}\n");
  });

  it("handles empty string", () => {
    expect(withTrailingNewline("")).toBe("\n");
  });
});

// ─── resolveJsonConfigPath ───────────────────────────────────────────────────

describe("resolveJsonConfigPath", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = join(tmpdir(), `reponova-test-resolve-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(sandbox, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("returns .json path when neither file exists", () => {
    const result = resolveJsonConfigPath(sandbox, "config");
    expect(result).toBe(join(sandbox, "config.json"));
  });

  it("returns .json path when only .json exists", () => {
    writeFileSync(join(sandbox, "config.json"), "{}");
    const result = resolveJsonConfigPath(sandbox, "config");
    expect(result).toBe(join(sandbox, "config.json"));
  });

  it("returns .jsonc path when only .jsonc exists", () => {
    writeFileSync(join(sandbox, "config.jsonc"), "{}");
    const result = resolveJsonConfigPath(sandbox, "config");
    expect(result).toBe(join(sandbox, "config.jsonc"));
  });

  it("prefers .jsonc when both exist", () => {
    writeFileSync(join(sandbox, "config.json"), "{}");
    writeFileSync(join(sandbox, "config.jsonc"), "{}");
    const result = resolveJsonConfigPath(sandbox, "config");
    expect(result).toBe(join(sandbox, "config.jsonc"));
  });
});

// ─── readJsoncText ───────────────────────────────────────────────────────────

describe("readJsoncText", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = join(tmpdir(), `reponova-test-read-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(sandbox, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("returns '{}' for non-existent file", () => {
    expect(readJsoncText(join(sandbox, "nope.json"))).toBe("{}");
  });

  it("reads .json file content", () => {
    const content = '{"hello": "world"}';
    writeFileSync(join(sandbox, "test.json"), content);
    expect(readJsoncText(join(sandbox, "test.json"))).toBe(content);
  });

  it("reads .jsonc file content with comments intact", () => {
    const content = '{\n  // comment\n  "key": 1\n}';
    writeFileSync(join(sandbox, "test.jsonc"), content);
    expect(readJsoncText(join(sandbox, "test.jsonc"))).toBe(content);
  });
});
