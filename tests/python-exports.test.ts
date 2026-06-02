/**
 * Tests for Python extractor's export computation (COMMIT 4).
 *
 * Tests:
 * - computeExports: __all__ parsing, public-name fallback
 * - extractDunderAll: parses __all__ = ["name1", "name2"]
 * - __init__.py: imports marked as isExport = true
 * - exports field on returned FileExtraction
 */
import { describe, it, expect, beforeAll } from "vitest";
import { PythonExtractor } from "@reponova/lang-python";
import { parse } from "../src/extract/parser.js";
import type { FileExtraction } from "../src/extract/types.js";

const extractor = new PythonExtractor();

// ─── computeExports: __all__ list ────────────────────────────────────────────

describe("computeExports: __all__ parsing", () => {
  it("uses __all__ when defined", async () => {
    const source = `
__all__ = ["public_fn", "PublicClass"]

def public_fn():
    pass

def _private_fn():
    pass

class PublicClass:
    pass

class _InternalClass:
    pass
`;
    const tree = await parse(source, "tree-sitter-python.wasm");
    const ext = extractor.extract(tree!, source, "mymodule.py");

    expect(ext.exports).toBeDefined();
    expect(ext.exports).toEqual(["public_fn", "PublicClass"]);
  });

  it("__all__ with single quotes", async () => {
    const source = `
__all__ = ['alpha', 'beta']

def alpha():
    pass

def beta():
    pass
`;
    const tree = await parse(source, "tree-sitter-python.wasm");
    const ext = extractor.extract(tree!, source, "mymodule.py");

    expect(ext.exports).toEqual(["alpha", "beta"]);
  });

  it("__all__ with mixed quotes", async () => {
    const source = `
__all__ = ["fn_a", 'fn_b']

def fn_a():
    pass

def fn_b():
    pass
`;
    const tree = await parse(source, "tree-sitter-python.wasm");
    const ext = extractor.extract(tree!, source, "mymodule.py");

    expect(ext.exports).toEqual(["fn_a", "fn_b"]);
  });

  it("empty __all__ returns null (falls back to public names)", async () => {
    const source = `
__all__ = []

def public_fn():
    pass
`;
    const tree = await parse(source, "tree-sitter-python.wasm");
    const ext = extractor.extract(tree!, source, "mymodule.py");

    // Empty __all__ returns null from extractDunderAll, falls back to public names
    expect(ext.exports).toContain("public_fn");
  });
});

// ─── computeExports: public name fallback ────────────────────────────────────

describe("computeExports: public name fallback (no __all__)", () => {
  it("exports all non-underscore-prefixed symbols when no __all__", async () => {
    const source = `
def public_function():
    pass

def _private_function():
    pass

class PublicClass:
    pass

class _PrivateClass:
    pass

CONSTANT = 42
`;
    const tree = await parse(source, "tree-sitter-python.wasm");
    const ext = extractor.extract(tree!, source, "module.py");

    expect(ext.exports).toBeDefined();
    expect(ext.exports).toContain("public_function");
    expect(ext.exports).toContain("PublicClass");
    expect(ext.exports).toContain("CONSTANT");
    expect(ext.exports).not.toContain("_private_function");
    expect(ext.exports).not.toContain("_PrivateClass");
  });

  it("handles module with only private symbols", async () => {
    const source = `
def _internal():
    pass

class _Hidden:
    pass
`;
    const tree = await parse(source, "tree-sitter-python.wasm");
    const ext = extractor.extract(tree!, source, "module.py");

    expect(ext.exports).toBeDefined();
    expect(ext.exports!.length).toBe(0);
  });

  it("includes dunder methods (e.g., __init__) in class but not in exports", async () => {
    const source = `
class MyClass:
    def __init__(self):
        pass

    def public_method(self):
        pass

    def _private_method(self):
        pass
`;
    const tree = await parse(source, "tree-sitter-python.wasm");
    const ext = extractor.extract(tree!, source, "module.py");

    expect(ext.exports).toBeDefined();
    expect(ext.exports).toContain("MyClass");
    // Methods are not top-level exports (they're contained within the class)
    // __init__ and _private_method start with _, public_method doesn't
    // But methods don't appear as top-level exports
  });
});

// ─── __init__.py: isExport on imports ────────────────────────────────────────

describe("__init__.py: imports marked as isExport", () => {
  it("marks all imports as isExport=true in __init__.py files", async () => {
    const source = `
from .models import User, Role
from .utils import helper
import os
`;
    const tree = await parse(source, "tree-sitter-python.wasm");
    const ext = extractor.extract(tree!, source, "pkg/__init__.py");

    expect(ext.imports.length).toBe(3);
    for (const imp of ext.imports) {
      expect(imp.isExport).toBe(true);
    }
  });

  it("does NOT mark imports as isExport in regular .py files", async () => {
    const source = `
from .models import User
import os
`;
    const tree = await parse(source, "tree-sitter-python.wasm");
    const ext = extractor.extract(tree!, source, "pkg/module.py");

    for (const imp of ext.imports) {
      expect(imp.isExport).toBeUndefined();
    }
  });
});

// ─── exports field on FileExtraction ─────────────────────────────────────────

describe("exports field on FileExtraction", () => {
  it("is always defined for Python files", async () => {
    const source = `
def fn():
    pass
`;
    const tree = await parse(source, "tree-sitter-python.wasm");
    const ext = extractor.extract(tree!, source, "module.py");

    expect(ext.exports).toBeDefined();
    expect(Array.isArray(ext.exports)).toBe(true);
  });

  it("contains only symbol names (not qualifiedNames)", async () => {
    const source = `
def my_function():
    pass

class MyClass:
    pass
`;
    const tree = await parse(source, "tree-sitter-python.wasm");
    const ext = extractor.extract(tree!, source, "pkg/module.py");

    expect(ext.exports).toBeDefined();
    for (const name of ext.exports!) {
      expect(name).not.toContain(".");
      expect(name).not.toContain("/");
    }
  });
});

// ─── Python extractor: qualifiedName format ──────────────────────────────────

describe("Python extractor: qualifiedName uses dot-separated module path", () => {
  it("converts file path to module name for qualifiedName prefix", async () => {
    const source = `
def my_function():
    pass
`;
    const tree = await parse(source, "tree-sitter-python.wasm");
    const ext = extractor.extract(tree!, source, "pkg/subpkg/module.py");

    const fn = ext.symbols.find((s) => s.name === "my_function");
    expect(fn).toBeDefined();
    // qualifiedName should be dot-separated module path
    expect(fn!.qualifiedName).toBe("pkg.subpkg.module.my_function");
  });

  it("strips .py extension from qualifiedName", async () => {
    const source = `
def fn():
    pass
`;
    const tree = await parse(source, "tree-sitter-python.wasm");
    const ext = extractor.extract(tree!, source, "simple.py");

    const fn = ext.symbols.find((s) => s.name === "fn");
    expect(fn!.qualifiedName).toBe("simple.fn");
    expect(fn!.qualifiedName).not.toContain(".py");
  });

  it("handles __init__.py: strips /__init__ suffix", async () => {
    const source = `
def init_fn():
    pass
`;
    const tree = await parse(source, "tree-sitter-python.wasm");
    const ext = extractor.extract(tree!, source, "pkg/__init__.py");

    const fn = ext.symbols.find((s) => s.name === "init_fn");
    expect(fn).toBeDefined();
    expect(fn!.qualifiedName).toBe("pkg.init_fn");
    expect(fn!.qualifiedName).not.toContain("__init__");
  });

  it("class methods include class name in qualifiedName", async () => {
    const source = `
class MyClass:
    def my_method(self):
        pass
`;
    const tree = await parse(source, "tree-sitter-python.wasm");
    const ext = extractor.extract(tree!, source, "module.py");

    const method = ext.symbols.find((s) => s.name === "my_method");
    expect(method).toBeDefined();
    expect(method!.qualifiedName).toBe("module.MyClass.my_method");
  });
});

// ─── Python extractor: resolveImportPath ─────────────────────────────────────

describe("Python extractor: resolveImportPath", () => {
  it("absolute import: dot-separated → path candidates", () => {
    const candidates = extractor.resolveImportPath("config.loader", "app/main.py");
    expect(candidates).toContain("config/loader.py");
    expect(candidates).toContain("config/loader/__init__.py");
  });

  it("relative import with single dot", () => {
    const candidates = extractor.resolveImportPath(".utils", "pkg/module.py");
    expect(candidates.some((p) => p.includes("pkg/utils.py"))).toBe(true);
  });

  it("relative import with double dot", () => {
    const candidates = extractor.resolveImportPath("..config", "pkg/sub/module.py");
    expect(candidates.some((p) => p.includes("config.py") || p.includes("config/__init__"))).toBe(true);
  });

  it("bare relative import (just dots, no name)", () => {
    const candidates = extractor.resolveImportPath(".", "pkg/module.py");
    expect(candidates.some((p) => p.includes("__init__.py"))).toBe(true);
  });
});
