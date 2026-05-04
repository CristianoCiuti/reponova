import { describe, it, expect } from "vitest";
import { COMMON_SKIP_DIRS, buildSkipDirs, createMatcher } from "../src/shared/glob.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type ExpectedCommonSkipDirs = readonly [
  "node_modules",
  "__pycache__",
  ".git",
  ".svn",
  ".hg",
  "venv",
  ".venv",
  "env",
  ".env",
  ".tox",
  "site-packages",
  "dist",
  "build",
  ".eggs",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "target",
  "bin",
  "obj",
];

type _CommonSkipDirsTypeIsReadonly = Expect<Equal<typeof COMMON_SKIP_DIRS, ExpectedCommonSkipDirs>>;
type _CommonSkipDirsLength = Expect<Equal<typeof COMMON_SKIP_DIRS["length"], 20>>;

describe("shared/glob", () => {
  describe("COMMON_SKIP_DIRS", () => {
    it("contains the expected common skip directories", () => {
      expect(COMMON_SKIP_DIRS).toEqual([
        "node_modules",
        "__pycache__",
        ".git",
        ".svn",
        ".hg",
        "venv",
        ".venv",
        "env",
        ".env",
        ".tox",
        "site-packages",
        "dist",
        "build",
        ".eggs",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        "target",
        "bin",
        "obj",
      ]);
      expect(COMMON_SKIP_DIRS).toHaveLength(20);
    });
  });

  describe("buildSkipDirs", () => {
    it("returns all common skip directories when excludeCommon=true", () => {
      const skipDirs = buildSkipDirs(true);

      expect(skipDirs.size).toBe(COMMON_SKIP_DIRS.length);
      for (const dir of COMMON_SKIP_DIRS) {
        expect(skipDirs.has(dir)).toBe(true);
      }
    });

    it("returns an empty set when excludeCommon=false", () => {
      const skipDirs = buildSkipDirs(false);

      expect(skipDirs).toBeInstanceOf(Set);
      expect(skipDirs.size).toBe(0);
    });
  });

  describe("createMatcher", () => {
    it("returns a matcher that always returns false for an empty pattern list", () => {
      const matcher = createMatcher([]);

      expect(matcher("foo.py")).toBe(false);
      expect(matcher("src/main.ts")).toBe(false);
    });

    it("returns a reusable matcher across multiple calls", () => {
      const matcher = createMatcher(["**/*.py", "**/CHANGELOG.md"]);

      expect(matcher("src/main.py")).toBe(true);
      expect(matcher("docs/CHANGELOG.md")).toBe(true);
      expect(matcher("src/main.ts")).toBe(false);
      expect(matcher("README.md")).toBe(false);
      expect(matcher("foo.py")).toBe(true);
    });

    it("works correctly when created once and called many times", () => {
      const matcher = createMatcher(["**/*.py", "src/**/*.ts", "**/venv/**"]);
      const paths = [
        "foo.py",
        "bar.js",
        "src/app.ts",
        "src/app.js",
        "venv/lib/pkg.py",
        "nested/venv/bin/python",
      ];

      const results = Array.from({ length: 50 }, () => paths.map((path) => matcher(path)).join(","));

      expect(new Set(results)).toEqual(new Set(["true,false,true,false,true,true"]));
    });
  });
});
