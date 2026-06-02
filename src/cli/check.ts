import type { CommandModule } from "yargs";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveGraphPath, resolveSearchDb, resolveGraphJson } from "../shared/graph-resolver.js";
import { loadBuildConfigFingerprint, getMissingBuildConfigErrorMessage } from "../pipeline/build-config-metadata.js";

export interface CheckItem {
  label: string;
  status: string;
  ok: boolean;
}

export function verifyGraphArtifacts(graphDir: string, graphJsonPath: string): CheckItem[] {
  const checks: CheckItem[] = [];
  const buildConfig = loadBuildConfigFingerprint(graphJsonPath);

  if (!buildConfig) {
    checks.push({ label: "Build metadata", status: `${getMissingBuildConfigErrorMessage()} ✗`, ok: false });
    return checks;
  }

  checks.push({ label: "Build metadata", status: "build_config present ✓", ok: true });

  const tfidfIdfPath = join(graphDir, "tfidf_idf.json");
  const vectorsDir = join(graphDir, "vectors");

  if (buildConfig.embeddings.enabled && !buildConfig.embeddings.provider && !existsSync(tfidfIdfPath)) {
    checks.push({ label: "Embeddings artifacts", status: "ERROR: TF-IDF build missing tfidf_idf.json ✗", ok: false });
  }

  if (buildConfig.embeddings.enabled && buildConfig.embeddings.provider && !existsSync(vectorsDir)) {
    checks.push({ label: "Embeddings artifacts", status: `ERROR: provider build missing vectors/ for provider ${buildConfig.embeddings.provider} ✗`, ok: false });
  }

  if (buildConfig.embeddings.enabled && buildConfig.embeddings.provider && existsSync(tfidfIdfPath)) {
    checks.push({ label: "Embeddings artifacts", status: `WARNING: tfidf_idf.json exists but build_config.embeddings.provider is ${buildConfig.embeddings.provider}`, ok: true });
  }

  return checks;
}

export async function checkHandler(argv: Record<string, unknown>): Promise<void> {
  const checks: CheckItem[] = [];

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
        checks.push(...verifyGraphArtifacts(graphDir, graphJsonPath));
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

    // Check tree-sitter grammars
    try {
      await import("web-tree-sitter");
      const { getGrammarsDir } = await import("../extract/parser.js");
      const { readdirSync } = await import("node:fs");
      const dir = getGrammarsDir();
      const wasmFiles = readdirSync(dir).filter((f: string) => f.endsWith(".wasm"));
      if (wasmFiles.length > 0) {
        const langs = wasmFiles.map((f: string) => f.replace("tree-sitter-", "").replace(".wasm", ""));
        checks.push({ label: "tree-sitter", status: `${wasmFiles.length} grammar(s): ${langs.join(", ")} ✓`, ok: true });
      } else {
        checks.push({ label: "tree-sitter", status: "no .wasm grammars found in grammars/ ✗", ok: false });
      }
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
}

/** @deprecated Use checkHandler directly */
export const checkCommand: CommandModule = {
  command: "check",
  describe: "Verify graph status and system capabilities",
  builder: (yargs) =>
    yargs.option("graph", {
      type: "string",
      describe: "Path to reponova-out/ directory",
    }),
  handler: async (argv) => {
    await checkHandler(argv as Record<string, unknown>);
  },
};
