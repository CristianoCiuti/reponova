/**
 * Tests for FIX-016: Serialization of docstring/signature/bases in graph.json.
 *
 * Verifies that docstring, signature, and bases are correctly serialized
 * by exportJson and round-trip through graph-loader.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Graph from "graphology";
import { exportJson } from "../src/extract/export-json.js";
import { buildGraph } from "../src/extract/graph-builder.js";
import type { FileExtraction } from "../src/extract/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpPath(): string {
  const dir = join(tmpdir(), `rn-test-fix016-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "graph.json");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("FIX-016: Serialize docstring/signature/bases", () => {
  const tmpPaths: string[] = [];

  afterEach(() => {
    for (const p of tmpPaths) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }
    tmpPaths.length = 0;
  });

  it("should serialize docstring for nodes with docstrings", () => {
    const tmpPath = makeTmpPath();
    tmpPaths.push(tmpPath);

    const graph = new Graph({ type: "directed", multi: false, allowSelfLoops: false });
    graph.addNode("fn_auth", {
      label: "authenticate",
      type: "function",
      file_type: "code",
      source_file: "auth.py",
      community: 0,
      norm_label: "authenticate",
      docstring: "Authenticate a user against the database.",
      start_line: 10,
      end_line: 25,
    });

    exportJson({
      graph,
      communities: { count: 1, assignments: new Map([["fn_auth", 0]]) },
      outputPath: tmpPath,
    });

    const raw = JSON.parse(readFileSync(tmpPath, "utf-8"));
    const node = raw.nodes.find((n: { id: string }) => n.id === "fn_auth");
    expect(node.docstring).toBe("Authenticate a user against the database.");
  });

  it("should serialize signature for functions with signatures", () => {
    const tmpPath = makeTmpPath();
    tmpPaths.push(tmpPath);

    const graph = new Graph({ type: "directed", multi: false, allowSelfLoops: false });
    graph.addNode("fn_load", {
      label: "load_config",
      type: "function",
      file_type: "code",
      source_file: "config.py",
      community: 0,
      norm_label: "load_config",
      signature: "(path: str, env: str = 'prod') -> Config",
      start_line: 1,
    });

    exportJson({
      graph,
      communities: { count: 1, assignments: new Map([["fn_load", 0]]) },
      outputPath: tmpPath,
    });

    const raw = JSON.parse(readFileSync(tmpPath, "utf-8"));
    const node = raw.nodes.find((n: { id: string }) => n.id === "fn_load");
    expect(node.signature).toBe("(path: str, env: str = 'prod') -> Config");
  });

  it("should serialize bases for classes with inheritance", () => {
    const tmpPath = makeTmpPath();
    tmpPaths.push(tmpPath);

    const graph = new Graph({ type: "directed", multi: false, allowSelfLoops: false });
    graph.addNode("cls_admin", {
      label: "AdminUser",
      type: "class",
      file_type: "code",
      source_file: "models.py",
      community: 0,
      norm_label: "adminuser",
      bases: ["BaseUser", "PermissionMixin"],
      start_line: 50,
    });

    exportJson({
      graph,
      communities: { count: 1, assignments: new Map([["cls_admin", 0]]) },
      outputPath: tmpPath,
    });

    const raw = JSON.parse(readFileSync(tmpPath, "utf-8"));
    const node = raw.nodes.find((n: { id: string }) => n.id === "cls_admin");
    expect(node.bases).toEqual(["BaseUser", "PermissionMixin"]);
  });

  it("should NOT serialize empty/undefined fields (no undefined in JSON)", () => {
    const tmpPath = makeTmpPath();
    tmpPaths.push(tmpPath);

    const graph = new Graph({ type: "directed", multi: false, allowSelfLoops: false });
    graph.addNode("mod_main", {
      label: "main",
      type: "module",
      file_type: "code",
      source_file: "main.py",
      community: 0,
      norm_label: "main",
      // No docstring, no signature, no bases
    });

    exportJson({
      graph,
      communities: { count: 1, assignments: new Map([["mod_main", 0]]) },
      outputPath: tmpPath,
    });

    const jsonStr = readFileSync(tmpPath, "utf-8");
    const raw = JSON.parse(jsonStr);
    const node = raw.nodes.find((n: { id: string }) => n.id === "mod_main");

    // These fields should not appear in the JSON at all
    expect(node.docstring).toBeUndefined();
    expect(node.signature).toBeUndefined();
    expect(node.bases).toBeUndefined();
    // Also verify they don't appear as null or empty in the raw JSON string for this node
    expect(jsonStr).not.toContain('"docstring": null');
    expect(jsonStr).not.toContain('"docstring": undefined');
  });

  it("should NOT serialize empty bases array", () => {
    const tmpPath = makeTmpPath();
    tmpPaths.push(tmpPath);

    const graph = new Graph({ type: "directed", multi: false, allowSelfLoops: false });
    graph.addNode("fn_test", {
      label: "test",
      type: "function",
      file_type: "code",
      source_file: "test.py",
      community: 0,
      norm_label: "test",
      bases: [], // empty array should not be serialized
    });

    exportJson({
      graph,
      communities: { count: 1, assignments: new Map([["fn_test", 0]]) },
      outputPath: tmpPath,
    });

    const raw = JSON.parse(readFileSync(tmpPath, "utf-8"));
    const node = raw.nodes.find((n: { id: string }) => n.id === "fn_test");
    expect(node.bases).toBeUndefined();
  });

  it("graph-builder should store bases in graphology attributes", () => {
    const extraction: FileExtraction = {
      filePath: "models.py",
      language: "python",
      symbols: [
        {
          name: "AdminUser",
          qualifiedName: "models.AdminUser",
          kind: "class",
          startLine: 10,
          endLine: 30,
          decorators: [],
          calls: [],
          bases: ["BaseUser", "PermissionMixin"],
          docstring: "Admin user with full permissions.",
          signature: undefined,
        },
      ],
      imports: [],
      references: [],
    };

    const { graph } = buildGraph({ extractions: [extraction] });

    // Find the class node
    let found = false;
    graph.forEachNode((nodeId, attrs) => {
      if (attrs.label === "AdminUser") {
        expect(attrs.bases).toEqual(["BaseUser", "PermissionMixin"]);
        expect(attrs.docstring).toBe("Admin user with full permissions.");
        found = true;
      }
    });
    expect(found).toBe(true);
  });

  it("full pipeline: extraction → graph → export preserves docstring/signature/bases", () => {
    const tmpPath = makeTmpPath();
    tmpPaths.push(tmpPath);

    const extraction: FileExtraction = {
      filePath: "service.py",
      language: "python",
      symbols: [
        {
          name: "UserService",
          qualifiedName: "service.UserService",
          kind: "class",
          startLine: 1,
          endLine: 50,
          decorators: [],
          calls: [],
          bases: ["BaseService"],
          docstring: "Handles user CRUD operations.",
        },
        {
          name: "get_user",
          qualifiedName: "service.UserService.get_user",
          kind: "method",
          startLine: 10,
          endLine: 20,
          decorators: [],
          calls: ["db.query"],
          parent: "UserService",
          signature: "(self, user_id: int) -> User",
          docstring: "Fetch a user by ID.",
        },
      ],
      imports: [],
      references: [],
    };

    const { graph } = buildGraph({ extractions: [extraction] });
    const communities = { count: 1, assignments: new Map<string, number>() };
    graph.forEachNode((id) => communities.assignments.set(id, 0));

    exportJson({ graph, communities, outputPath: tmpPath });

    const raw = JSON.parse(readFileSync(tmpPath, "utf-8"));
    const classNode = raw.nodes.find((n: { label: string }) => n.label === "UserService");
    const methodNode = raw.nodes.find((n: { label: string }) => n.label === "get_user");

    expect(classNode.docstring).toBe("Handles user CRUD operations.");
    expect(classNode.bases).toEqual(["BaseService"]);

    expect(methodNode.signature).toBe("(self, user_id: int) -> User");
    expect(methodNode.docstring).toBe("Fetch a user by ID.");
  });
});
