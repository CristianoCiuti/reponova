/**
 * Tests for `src/plugin/extension-scanner.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanExtensions } from "../src/plugin/extension-scanner.js";

function touch(path: string, contents = ""): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf-8");
}

describe("scanExtensions", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rn-scan-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("tallies extensions correctly across subdirectories", () => {
    touch(join(tmp, "a.py"));
    touch(join(tmp, "b.py"));
    touch(join(tmp, "src", "c.ts"));
    touch(join(tmp, "src", "nested", "d.ts"));
    touch(join(tmp, "src", "nested", "e.tsx"));

    const res = scanExtensions({ roots: [tmp] });
    expect(res.counts.get(".py")).toBe(2);
    expect(res.counts.get(".ts")).toBe(2);
    expect(res.counts.get(".tsx")).toBe(1);
    expect(res.totalFiles).toBe(5);
    expect(res.truncated).toBe(false);
  });

  it("lowercases extensions (.PY → .py)", () => {
    touch(join(tmp, "foo.PY"));
    touch(join(tmp, "bar.Py"));
    const res = scanExtensions({ roots: [tmp] });
    expect(res.counts.get(".py")).toBe(2);
    expect(res.counts.get(".PY")).toBeUndefined();
  });

  it("skips COMMON_SKIP_DIRS by default (node_modules, .git, dist, ...)", () => {
    touch(join(tmp, "a.ts"));
    touch(join(tmp, "node_modules", "lib.ts"));
    touch(join(tmp, ".git", "stuff.ts"));
    touch(join(tmp, "dist", "out.js"));
    const res = scanExtensions({ roots: [tmp] });
    expect(res.counts.get(".ts")).toBe(1);
    expect(res.counts.get(".js")).toBeUndefined();
  });

  it("respects excludeGlobs", () => {
    touch(join(tmp, "src", "a.ts"));
    touch(join(tmp, "src", "b.ts"));
    touch(join(tmp, "test", "x.ts"));
    const res = scanExtensions({ roots: [tmp], excludeGlobs: ["test/**"] });
    expect(res.counts.get(".ts")).toBe(2);
  });

  it("ignores extension-less files and dotfiles", () => {
    touch(join(tmp, "Makefile"));
    touch(join(tmp, ".gitignore")); // dotfile (lastDot === 0)
    touch(join(tmp, "README"));
    touch(join(tmp, "real.txt"));
    const res = scanExtensions({ roots: [tmp] });
    expect(res.counts.get(".txt")).toBe(1);
    expect(res.counts.size).toBe(1);
  });

  it("records missing roots without throwing", () => {
    const ghost = join(tmp, "does-not-exist");
    const res = scanExtensions({ roots: [tmp, ghost] });
    expect(res.missingRoots).toEqual([ghost]);
    expect(res.totalFiles).toBe(0);
  });

  it("truncates when maxFiles is reached", () => {
    for (let i = 0; i < 20; i++) touch(join(tmp, `f${i}.py`));
    const res = scanExtensions({ roots: [tmp], maxFiles: 7 });
    expect(res.truncated).toBe(true);
    expect(res.totalFiles).toBe(7);
  });

  it("walks multiple roots and aggregates counts", () => {
    const a = join(tmp, "repoA");
    const b = join(tmp, "repoB");
    touch(join(a, "x.py"));
    touch(join(a, "y.py"));
    touch(join(b, "z.py"));
    touch(join(b, "w.ts"));
    const res = scanExtensions({ roots: [a, b] });
    expect(res.counts.get(".py")).toBe(3);
    expect(res.counts.get(".ts")).toBe(1);
  });
});
