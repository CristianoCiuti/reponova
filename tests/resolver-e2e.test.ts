/**
 * E2E tests for the resolver pipeline using temp Python projects.
 *
 * Tests the full cycle: real Python source → tree-sitter parse → extract →
 * import resolution → graph building → verify edges.
 *
 * Covers:
 * - Wildcard imports through the full pipeline
 * - Re-exports via __init__.py
 * - Cross-file named imports
 * - __all__ export filtering
 * - Class inheritance resolution via imports
 * - Multi-graph parallel edges (imports_from + calls to same target)
 * - self.method resolution
 * - ClassName.method resolution via imports
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PythonExtractor } from "../src/extract/languages/python.js";
import { parse } from "../src/extract/parser.js";
import { buildGraph } from "../src/extract/graph-builder.js";
import type { FileExtraction } from "../src/extract/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const extractor = new PythonExtractor();

async function extractFile(source: string, filePath: string): Promise<FileExtraction> {
  const tree = await parse(source, "tree-sitter-python.wasm");
  if (!tree) throw new Error(`Failed to parse ${filePath}`);
  return extractor.extract(tree, source, filePath);
}

function getEdgesByType(graph: ReturnType<typeof buildGraph>["graph"], type: string) {
  const edges: Array<{ source: string; target: string }> = [];
  graph.forEachEdge((_edge, attrs, source, target) => {
    if (attrs.relation === type) edges.push({ source, target });
  });
  return edges;
}

function getAllEdges(graph: ReturnType<typeof buildGraph>["graph"]) {
  const edges: Array<{ source: string; target: string; type: string }> = [];
  graph.forEachEdge((_edge, attrs, source, target) => {
    edges.push({ source, target, type: attrs.relation as string });
  });
  return edges;
}

function writeFile(rootDir: string, relativePath: string, content: string): void {
  const filePath = join(rootDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

// ─── E2E: Cross-file named imports ───────────────────────────────────────────

describe("Resolver E2E: cross-file named imports", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reponova-resolver-e2e-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves named imports and builds calls + imports_from edges", async () => {
    const modelsSource = `
class User:
    """User model."""
    def __init__(self, name):
        self.name = name

    def greet(self):
        return f"Hello {self.name}"

def create_user(name):
    return User(name)
`;
    const appSource = `
from models import User, create_user

def main():
    user = create_user("Alice")
    print(user.greet())
`;
    writeFile(tmpDir, "models.py", modelsSource);
    writeFile(tmpDir, "app.py", appSource);

    const modelsExt = await extractFile(modelsSource, "models.py");
    const appExt = await extractFile(appSource, "app.py");

    const { graph, stats } = buildGraph({ extractions: [modelsExt, appExt] });

    // Verify cross-file edges exist
    expect(stats.crossFileEdges).toBeGreaterThan(0);

    // app.py → models.User should have imports_from
    const importsFrom = getEdgesByType(graph, "imports_from");
    expect(importsFrom.some((e) => e.source === "app.py" && e.target === "models.User")).toBe(true);

    // app.py → models.create_user should have imports_from
    expect(importsFrom.some((e) => e.source === "app.py" && e.target === "models.create_user")).toBe(true);

    // app.main → models.create_user should have calls
    const calls = getEdgesByType(graph, "calls");
    expect(calls.some((e) => e.source === "app.main" && e.target === "models.create_user")).toBe(true);
  });
});

// ─── E2E: Wildcard imports with __all__ ──────────────────────────────────────

describe("Resolver E2E: wildcard imports with __all__", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reponova-wildcard-e2e-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wildcard import respects __all__ — private symbols excluded", async () => {
    const libSource = `
__all__ = ["public_fn", "PublicClass"]

def public_fn():
    return 42

def _private_fn():
    return "secret"

class PublicClass:
    pass

class _InternalClass:
    pass
`;
    const consumerSource = `
from lib import *

def main():
    public_fn()
    obj = PublicClass()
`;
    writeFile(tmpDir, "lib.py", libSource);
    writeFile(tmpDir, "consumer.py", consumerSource);

    const libExt = await extractFile(libSource, "lib.py");
    const consumerExt = await extractFile(consumerSource, "consumer.py");

    // Verify __all__ was parsed
    expect(libExt.exports).toEqual(["public_fn", "PublicClass"]);

    const { graph } = buildGraph({ extractions: [libExt, consumerExt] });

    // consumer.py should import from public symbols
    const importsFrom = getEdgesByType(graph, "imports_from");
    expect(importsFrom.some((e) => e.source === "consumer.py" && e.target === "lib.public_fn")).toBe(true);
    expect(importsFrom.some((e) => e.source === "consumer.py" && e.target === "lib.PublicClass")).toBe(true);
    // Should NOT import private symbols
    expect(importsFrom.some((e) => e.target === "lib._private_fn")).toBe(false);
    expect(importsFrom.some((e) => e.target === "lib._InternalClass")).toBe(false);

    // Calls should also resolve
    const calls = getEdgesByType(graph, "calls");
    expect(calls.some((e) => e.source === "consumer.main" && e.target === "lib.public_fn")).toBe(true);
  });

  it("wildcard import without __all__ exports all public symbols", async () => {
    const libSource = `
def alpha():
    pass

def beta():
    pass

def _hidden():
    pass
`;
    const consumerSource = `
from lib import *

def run():
    alpha()
    beta()
`;
    writeFile(tmpDir, "lib.py", libSource);
    writeFile(tmpDir, "consumer.py", consumerSource);

    const libExt = await extractFile(libSource, "lib.py");
    const consumerExt = await extractFile(consumerSource, "consumer.py");

    // No __all__ → exports = all non-_ symbols
    expect(libExt.exports).toContain("alpha");
    expect(libExt.exports).toContain("beta");
    expect(libExt.exports).not.toContain("_hidden");

    const { graph } = buildGraph({ extractions: [libExt, consumerExt] });

    const importsFrom = getEdgesByType(graph, "imports_from");
    expect(importsFrom.some((e) => e.source === "consumer.py" && e.target === "lib.alpha")).toBe(true);
    expect(importsFrom.some((e) => e.source === "consumer.py" && e.target === "lib.beta")).toBe(true);
    expect(importsFrom.some((e) => e.target === "lib._hidden")).toBe(false);
  });
});

// ─── E2E: Re-export via __init__.py ──────────────────────────────────────────

describe("Resolver E2E: re-export via __init__.py", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reponova-reexport-e2e-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("chases re-export through __init__.py to find the actual symbol", async () => {
    const userSource = `
class User:
    def __init__(self, name):
        self.name = name
`;
    const initSource = `
from .user import User
`;
    const appSource = `
from models import User

def main():
    u = User("Alice")
`;
    writeFile(tmpDir, "models/user.py", userSource);
    writeFile(tmpDir, "models/__init__.py", initSource);
    writeFile(tmpDir, "app.py", appSource);

    const userExt = await extractFile(userSource, "models/user.py");
    const initExt = await extractFile(initSource, "models/__init__.py");
    const appExt = await extractFile(appSource, "app.py");

    // __init__.py should have isExport=true on its imports
    for (const imp of initExt.imports) {
      expect(imp.isExport).toBe(true);
    }

    const { graph } = buildGraph({ extractions: [userExt, initExt, appExt] });

    // app.py should have imports_from edge to models.user.User (the actual definition)
    const importsFrom = getEdgesByType(graph, "imports_from");
    const userImport = importsFrom.find(
      (e) => e.source === "app.py" && e.target === "models.user.User",
    );
    expect(userImport).toBeDefined();

    // Calls should also resolve through the re-export
    const calls = getEdgesByType(graph, "calls");
    expect(calls.some((e) => e.source === "app.main" && e.target === "models.user.User")).toBe(true);
  });
});

// ─── E2E: Class inheritance via imports ──────────────────────────────────────

describe("Resolver E2E: class inheritance resolution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reponova-inheritance-e2e-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves cross-file inheritance via imports", async () => {
    const baseSource = `
class BaseModel:
    """Abstract base."""
    def save(self):
        pass
`;
    const childSource = `
from base import BaseModel

class User(BaseModel):
    """User model."""
    def __init__(self, name):
        self.name = name
`;
    writeFile(tmpDir, "base.py", baseSource);
    writeFile(tmpDir, "child.py", childSource);

    const baseExt = await extractFile(baseSource, "base.py");
    const childExt = await extractFile(childSource, "child.py");

    const { graph } = buildGraph({ extractions: [baseExt, childExt] });

    // child.User → base.BaseModel should have extends edge
    const extendsEdges = getEdgesByType(graph, "extends");
    expect(extendsEdges.some(
      (e) => e.source === "child.User" && e.target === "base.BaseModel",
    )).toBe(true);
  });

  it("resolves same-file inheritance without imports", async () => {
    const source = `
class Animal:
    def speak(self):
        pass

class Dog(Animal):
    def speak(self):
        return "Woof"
`;
    writeFile(tmpDir, "animals.py", source);

    const ext = await extractFile(source, "animals.py");
    const { graph } = buildGraph({ extractions: [ext] });

    const extendsEdges = getEdgesByType(graph, "extends");
    expect(extendsEdges.some(
      (e) => e.source === "animals.Dog" && e.target === "animals.Animal",
    )).toBe(true);
  });

  it("does NOT resolve inheritance without import (no global resolution)", async () => {
    const baseSource = `
class RemoteBase:
    pass
`;
    const childSource = `
class Child(RemoteBase):
    pass
`;
    writeFile(tmpDir, "remote.py", baseSource);
    writeFile(tmpDir, "local.py", childSource);

    const baseExt = await extractFile(baseSource, "remote.py");
    const childExt = await extractFile(childSource, "local.py");

    const { graph } = buildGraph({ extractions: [baseExt, childExt] });

    // Without import, inheritance should NOT resolve
    const extendsEdges = getEdgesByType(graph, "extends");
    expect(extendsEdges.some(
      (e) => e.source === "local.Child" && e.target === "remote.RemoteBase",
    )).toBe(false);
  });
});

// ─── E2E: self.method and ClassName.method resolution ────────────────────────

describe("Resolver E2E: attribute-based call resolution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reponova-attr-call-e2e-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves self.method calls to methods in the same class", async () => {
    const source = `
class Engine:
    def start(self):
        self.initialize()
        self.run()

    def initialize(self):
        pass

    def run(self):
        pass
`;
    writeFile(tmpDir, "engine.py", source);

    const ext = await extractFile(source, "engine.py");
    const { graph } = buildGraph({ extractions: [ext] });

    const calls = getEdgesByType(graph, "calls");
    expect(calls.some((e) => e.source === "engine.Engine.start" && e.target === "engine.Engine.initialize")).toBe(true);
    expect(calls.some((e) => e.source === "engine.Engine.start" && e.target === "engine.Engine.run")).toBe(true);
  });

  it("resolves ImportedClass.method calls via import-based resolution", async () => {
    const serviceSource = `
class Service:
    def execute(self):
        pass
`;
    const appSource = `
from service import Service

def main():
    Service.execute()
`;
    writeFile(tmpDir, "service.py", serviceSource);
    writeFile(tmpDir, "app.py", appSource);

    const serviceExt = await extractFile(serviceSource, "service.py");
    const appExt = await extractFile(appSource, "app.py");

    const { graph } = buildGraph({ extractions: [serviceExt, appExt] });

    const calls = getEdgesByType(graph, "calls");
    expect(calls.some(
      (e) => e.source === "app.main" && e.target === "service.Service.execute",
    )).toBe(true);
  });
});

// ─── E2E: Multi-graph parallel edges ─────────────────────────────────────────

describe("Resolver E2E: multi-graph parallel edges", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reponova-multigraph-e2e-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("same node pair can have imports_from + calls (different edge types)", async () => {
    const libSource = `
def helper():
    return 42
`;
    const appSource = `
from lib import helper

def main():
    helper()
`;
    writeFile(tmpDir, "lib.py", libSource);
    writeFile(tmpDir, "app.py", appSource);

    const libExt = await extractFile(libSource, "lib.py");
    const appExt = await extractFile(appSource, "app.py");

    const { graph } = buildGraph({ extractions: [libExt, appExt] });

    // app.py → lib.helper should have imports_from
    const importsFrom = getEdgesByType(graph, "imports_from");
    expect(importsFrom.some((e) => e.source === "app.py" && e.target === "lib.helper")).toBe(true);

    // app.main → lib.helper should have calls
    const calls = getEdgesByType(graph, "calls");
    expect(calls.some((e) => e.source === "app.main" && e.target === "lib.helper")).toBe(true);

    // Verify both edges exist (multi-graph)
    const allEdgesTargetingHelper = getAllEdges(graph).filter((e) => e.target === "lib.helper");
    const edgeTypes = new Set(allEdgesTargetingHelper.map((e) => e.type));
    expect(edgeTypes.has("imports_from")).toBe(true);
    expect(edgeTypes.has("calls")).toBe(true);
  });
});

// ─── E2E: Complex project with multiple modules ─────────────────────────────

describe("Resolver E2E: complex multi-module project", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reponova-complex-e2e-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("full project: imports, calls, inheritance, re-exports, wildcards", async () => {
    // models/base.py — defines BaseModel
    const baseSource = `
class BaseModel:
    def save(self):
        pass
    def validate(self):
        pass
`;
    // models/user.py — User extends BaseModel
    const userSource = `
from .base import BaseModel

class User(BaseModel):
    def __init__(self, name):
        self.name = name
        self.validate()
`;
    // models/__init__.py — re-exports
    const modelsInitSource = `
from .base import BaseModel
from .user import User
`;
    // services/user_service.py — uses User
    const serviceSource = `
from models import User

def get_user(name):
    return User(name)

def list_users():
    pass
`;
    // app.py — uses service
    const appSource = `
from services.user_service import get_user, list_users

def main():
    user = get_user("Alice")
    users = list_users()
`;

    writeFile(tmpDir, "models/base.py", baseSource);
    writeFile(tmpDir, "models/user.py", userSource);
    writeFile(tmpDir, "models/__init__.py", modelsInitSource);
    writeFile(tmpDir, "services/user_service.py", serviceSource);
    writeFile(tmpDir, "app.py", appSource);

    const baseExt = await extractFile(baseSource, "models/base.py");
    const userExt = await extractFile(userSource, "models/user.py");
    const initExt = await extractFile(modelsInitSource, "models/__init__.py");
    const serviceExt = await extractFile(serviceSource, "services/user_service.py");
    const appExt = await extractFile(appSource, "app.py");

    const { graph, stats } = buildGraph({
      extractions: [baseExt, userExt, initExt, serviceExt, appExt],
    });

    // Basic stats
    expect(stats.fileCount).toBe(5);
    expect(stats.nodeCount).toBeGreaterThan(5);
    expect(stats.crossFileEdges).toBeGreaterThan(0);

    // User extends BaseModel
    const extendsEdges = getEdgesByType(graph, "extends");
    expect(extendsEdges.some(
      (e) => e.source === "models.user.User" && e.target === "models.base.BaseModel",
    )).toBe(true);

    // self.validate() in User.__init__ → resolves to BaseModel.validate or same-file
    const calls = getEdgesByType(graph, "calls");
    // User.__init__ calls self.validate, which is in BaseModel
    // Since it's same-file call via "self.validate", it looks for "validate" method in same class
    // But User has no validate method — this tests that resolution doesn't crash

    // services/user_service.py imports User (via re-export through __init__)
    const importsFrom = getEdgesByType(graph, "imports_from");
    // The import goes through models/__init__.py re-export
    const serviceUserImport = importsFrom.find(
      (e) => e.source === "services/user_service.py" && e.target === "models.user.User",
    );
    expect(serviceUserImport).toBeDefined();

    // app.py imports get_user from services.user_service
    const appServiceImport = importsFrom.find(
      (e) => e.source === "app.py" && e.target === "services.user_service.get_user",
    );
    expect(appServiceImport).toBeDefined();

    // app.main calls get_user
    expect(calls.some(
      (e) => e.source === "app.main" && e.target === "services.user_service.get_user",
    )).toBe(true);

    // No "method" edge type anywhere
    const methodEdges = getEdgesByType(graph, "method");
    expect(methodEdges.length).toBe(0);

    // Graph is multi
    expect(graph.multi).toBe(true);

    // All edge types are valid
    const validTypes = new Set(["calls", "imports", "imports_from", "extends", "contains"]);
    getAllEdges(graph).forEach((e) => {
      expect(validTypes.has(e.type)).toBe(true);
    });
  });
});

// ─── E2E: Markdown + Python mixed project ───────────────────────────────────

describe("Resolver E2E: mixed Python + Markdown", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reponova-mixed-e2e-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Python code + Markdown docs coexist in one graph", async () => {
    const codeSource = `
def process():
    pass

class Processor:
    def run(self):
        self.process()

    def process(self):
        pass
`;

    writeFile(tmpDir, "engine.py", codeSource);
    writeFile(tmpDir, "docs/README.md", "# Engine\n\nThe engine does things.\n\n## Usage\n\nUse `process` to start.\n");

    const codeExt = await extractFile(codeSource, "engine.py");

    // Markdown extraction inline (no tree-sitter needed)
    const { MarkdownExtractor } = await import("../src/extract/languages/markdown.js");
    const mdExtractor = new MarkdownExtractor();
    const mdSource = "# Engine\n\nThe engine does things.\n\n## Usage\n\nUse `process` to start.\n";
    const mdExt = mdExtractor.extract(null, mdSource, "docs/README.md");

    const { graph, stats } = buildGraph({ extractions: [codeExt, mdExt] });

    expect(stats.fileCount).toBe(2);

    // Code file nodes
    expect(graph.hasNode("engine.py")).toBe(true);
    expect(graph.getNodeAttribute("engine.py", "type")).toBe("module");

    // Doc file nodes
    expect(graph.hasNode("docs/README.md")).toBe(true);
    expect(graph.getNodeAttribute("docs/README.md", "type")).toBe("document");

    // Both file types produce contains edges
    const contains = getEdgesByType(graph, "contains");
    expect(contains.length).toBeGreaterThan(0);
  });
});
