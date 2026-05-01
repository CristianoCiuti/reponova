import type { CommandModule } from "yargs";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveGraphPath, resolveSearchDb, resolveGraphJson } from "../core/graph-resolver.js";

export const checkCommand: CommandModule = {
  command: "check",
  describe: "Verify graph status and system capabilities",
  builder: (yargs) =>
    yargs.option("graph", {
      type: "string",
      describe: "Path to reponova-out/ directory",
    }),
  handler: async (argv) => {
    const checks: Array<{ label: string; status: string; ok: boolean }> = [];

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
          status: `${graphJsonPath} (${sizeMb}MB, ${date}) ✓`,
          ok: true,
        });
      } else {
        checks.push({ label: "Graph", status: "graph.json not found ✗", ok: false });
      }

      // Check Search index
      const dbPath = resolveSearchDb(graphDir);
      if (dbPath) {
        const stats = statSync(dbPath);
        const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);
        checks.push({
          label: "Search index",
          status: `graph_search.db (${sizeMb}MB) ✓`,
          ok: true,
        });
      } else {
        checks.push({ label: "Search index", status: "not found ✗", ok: false });
      }

      // Check Outlines
      const outlinesDir = join(graphDir, "outlines");
      if (existsSync(outlinesDir)) {
        checks.push({ label: "Outlines", status: "directory exists ✓", ok: true });
      } else {
        checks.push({ label: "Outlines", status: "not pre-computed", ok: true });
      }
    } else {
      checks.push({ label: "Graph", status: "reponova-out/ not found ✗", ok: false });
    }

    // Check tree-sitter
    try {
      await import("web-tree-sitter");
      checks.push({ label: "tree-sitter", status: "WASM available ✓", ok: true });
    } catch {
      checks.push({ label: "tree-sitter", status: "not available ✗", ok: false });
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
      console.log("Run `reponova build` to generate the knowledge graph.");
      process.exit(1);
    }
  },
};
