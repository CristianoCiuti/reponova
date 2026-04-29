import type { CommandModule } from "yargs";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveGraphPath, resolveSearchDb, resolveGraphJson } from "../core/graph-resolver.js";
import { checkGraphify, checkPython } from "../shared/system-checks.js";

export const checkCommand: CommandModule = {
  command: "check",
  describe: "Verify graphify installation and graph status",
  builder: (yargs) =>
    yargs.option("graph", {
      type: "string",
      describe: "Path to graphify-out/ directory",
    }),
  handler: async (argv) => {
    const checks: Array<{ label: string; status: string; ok: boolean }> = [];

    // Check Graphify
    const graphifyVersion = checkGraphify();
    checks.push({
      label: "Graphify",
      status: graphifyVersion ? `v${graphifyVersion} \u2713` : "NOT FOUND \u2717",
      ok: !!graphifyVersion,
    });

    // Check Python
    const pythonVersion = checkPython();
    checks.push({
      label: "Python",
      status: pythonVersion ? `${pythonVersion} \u2713` : "NOT FOUND \u2717",
      ok: !!pythonVersion,
    });

    // Check Graph
    const graphDir = resolveGraphPath(argv.graph as string | undefined);
    if (graphDir) {
      const graphJsonPath = resolveGraphJson(graphDir);
      if (graphJsonPath) {
        const stats = statSync(graphJsonPath);
        const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);
        const date = stats.mtime.toISOString().split("T")[0];
        checks.push({
          label: "Graph",
          status: `${graphJsonPath} (${sizeMb}MB, ${date}) \u2713`,
          ok: true,
        });
      } else {
        checks.push({ label: "Graph", status: "graph.json not found \u2717", ok: false });
      }

      // Check Search index
      const dbPath = resolveSearchDb(graphDir);
      if (dbPath) {
        const stats = statSync(dbPath);
        const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);
        checks.push({
          label: "Search index",
          status: `graph_search.db (${sizeMb}MB) \u2713`,
          ok: true,
        });
      } else {
        checks.push({ label: "Search index", status: "not found \u2717", ok: false });
      }

      // Check Outlines
      const outlinesDir = join(graphDir, "outlines");
      if (existsSync(outlinesDir)) {
        checks.push({ label: "Outlines", status: "directory exists \u2713", ok: true });
      } else {
        checks.push({ label: "Outlines", status: "not pre-computed", ok: true });
      }
    } else {
      checks.push({ label: "Graph", status: "graphify-out/ not found \u2717", ok: false });
    }

    // Check tree-sitter
    try {
      await import("web-tree-sitter");
      checks.push({ label: "tree-sitter", status: "WASM available \u2713", ok: true });
    } catch {
      checks.push({ label: "tree-sitter", status: "not available \u2717", ok: false });
    }

    // Print results
    const maxLabel = Math.max(...checks.map((c) => c.label.length));
    for (const check of checks) {
      const padding = " ".repeat(maxLabel - check.label.length + 2);
      console.log(`${check.label}:${padding}${check.status}`);
    }

    // Exit code
    const allOk = checks.every((c) => c.ok);
    if (!allOk) {
      console.log("");
      if (!graphifyVersion) {
        console.log("graphify (PyPI: graphifyy) is required for building the knowledge graph.");
        console.log("Install: uv tool install graphifyy   (or: pip install graphifyy)");
        console.log("Docs: https://github.com/safishamsi/graphify");
      }
      process.exit(1);
    }
  },
};
