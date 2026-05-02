import { describe, it, expect } from "vitest";
import { COMMON_SKIP_DIRS, buildSkipDirs, matchGlob, matchAny, createMatcher } from "../src/shared/glob.js";

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

  describe("matchGlob", () => {
    it("matches critical root-level and nested directory patterns", () => {
      expect(matchGlob("**/venv/**", "venv/lib/foo.py")).toBe(true);
      expect(matchGlob("**/venv/**", "src/venv/lib/foo.py")).toBe(true);
      expect(matchGlob("**/node_modules/**", "node_modules/x.js")).toBe(true);
      expect(matchGlob("**/node_modules/**", "a/node_modules/x.js")).toBe(true);
      expect(matchGlob("**/.git/**", ".git/config")).toBe(true);
      expect(matchGlob("**/dist/**", "dist/index.js")).toBe(true);
      expect(matchGlob("**/__pycache__/**", "__pycache__/foo.pyc")).toBe(true);
    });

    it("matches critical file patterns with correct root semantics", () => {
      expect(matchGlob("**/*.py", "venv/lib/foo.py")).toBe(true);
      expect(matchGlob("**/*.py", "foo.py")).toBe(true);
      expect(matchGlob("src/**/*.py", "src/main.py")).toBe(true);
      expect(matchGlob("src/**/*.py", "main.py")).toBe(false);
      expect(matchGlob("**/CHANGELOG.md", "CHANGELOG.md")).toBe(true);
      expect(matchGlob("**/CHANGELOG.md", "docs/CHANGELOG.md")).toBe(true);
    });
  });

  describe("matchAny", () => {
    it("returns false for an empty pattern list", () => {
      expect(matchAny([], "foo.py")).toBe(false);
      expect(matchAny([], "src/main.ts")).toBe(false);
    });

    it("returns true when any pattern matches", () => {
      expect(matchAny(["**/*.py", "**/*.ts"], "foo.py")).toBe(true);
      expect(matchAny(["**/*.py", "**/*.ts"], "src/app.ts")).toBe(true);
      expect(matchAny(["**/*.py", "**/*.ts"], "foo.js")).toBe(false);
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
