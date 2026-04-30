import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../shared/types.js";
import { checkGraphify } from "./graphify-check.js";
import { runIndexer } from "./indexer.js";
import { postProcess } from "./post-process.js";
import { log } from "../shared/utils.js";

/** Env vars for all Python subprocesses (Windows cp1252 fails on graphify Unicode output) */
const PYTHON_ENV = { ...process.env, PYTHONIOENCODING: "utf-8" };

export interface BuildOptions {
  force: boolean;
}

/**
 * Python script template for initial graph build via graphify library API.
 * Uses: detect → extract → build_from_json → cluster → to_json
 * This is AST-only (deterministic, no LLM cost).
 *
 * Key design decisions:
 * - Uses detect() instead of collect_files() because detect() applies
 *   _SKIP_DIRS filtering (venv/, node_modules/, site-packages/, etc.)
 *   while collect_files() does not, causing RecursionError on repos
 *   with virtualenvs containing deeply-nested C files.
 * - Uses forward slashes for paths (Python's Path handles both on Windows).
 * - Monkey-patches _SKIP_DIRS with user-configured exclusions before detect().
 */
function buildPythonScript(repoPath: string, outPath: string, excludeDirs: string[]): string {
  // Use forward slashes — Python Path handles them correctly on all platforms.
  // Backslash escaping through shell layers is error-prone on Windows.
  const pyRepoPath = repoPath.replace(/\\/g, "/");
  const pyOutPath = outPath.replace(/\\/g, "/");

  const excludeBlock = excludeDirs.length > 0
    ? `\nfrom graphify.detect import _SKIP_DIRS\nfor d in ${JSON.stringify(excludeDirs)}:\n    _SKIP_DIRS.add(d)\n`
    : "";

  return `
import sys, json
from pathlib import Path

try:
    from graphify.detect import detect
    from graphify.extract import extract
    from graphify.build import build_from_json
    from graphify.cluster import cluster
    from graphify.export import to_json
except ImportError:
    print("ERROR: graphify not importable", file=sys.stderr)
    sys.exit(1)
${excludeBlock}
path = Path("${pyRepoPath}")
out = Path("${pyOutPath}")
out.mkdir(parents=True, exist_ok=True)

# Use detect() for proper filtering (skips venv/, node_modules/, site-packages/, etc.)
result = detect(path)
code_files = [Path(f) for f in result.get("files", {}).get("code", [])]

if not code_files:
    (out / "graph.json").write_text(json.dumps({"nodes": [], "links": []}))
    print("0 nodes, 0 edges (no code files found)")
    sys.exit(0)

extraction = extract(code_files, cache_root=path)
G = build_from_json(extraction)
communities = cluster(G)
to_json(G, communities, str(out / "graph.json"))
print(f"{G.number_of_nodes()} nodes, {G.number_of_edges()} edges, {len(communities)} communities")
`.trim();
}

/**
 * Run the full build pipeline:
 * 1. Verify graphify installed (PyPI: graphifyy)
 * 2. For each repo: run Python API build (or `graphify update` for incremental)
 * 3. Merge graphs via `graphify merge-graphs`
 * 4. Post-process paths
 * 5. Generate search index
 */
export async function runBuild(config: Config, configDir: string, options: BuildOptions): Promise<void> {
  // 1. Verify graphify
  const graphifyInfo = checkGraphify();
  if (!graphifyInfo) {
    log.error("graphify (PyPI: graphifyy) is required for building the knowledge graph.");
    log.error("Install: pip install graphifyy   (or: uv tool install graphifyy)");
    process.exit(1);
  }

  log.info(`Using graphify: v${graphifyInfo.version}`);

  if (config.repos.length === 0) {
    log.error("No repos configured. Add repos to graphify-tools.config.yml");
    process.exit(1);
  }

  // Create output directory
  const outputDir = resolve(configDir, config.output);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Create temp directory for individual repo graphs
  const tmpDir = join(tmpdir(), `graphify-build-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // 2. Build each repo
    const repoGraphs: string[] = [];
    for (const repo of config.repos) {
      const repoPath = resolve(configDir, repo.path);
      if (!existsSync(repoPath)) {
        log.warn(`Repo not found, skipping: ${repoPath}`);
        continue;
      }

      const repoOutDir = join(tmpDir, repo.name);
      mkdirSync(repoOutDir, { recursive: true });

      log.info(`Building graph for ${repo.name}...`);

      // Check if repo has existing graph (use `graphify update` for incremental)
      const existingGraph = join(repoPath, "graphify-out", "graph.json");
      const useUpdate = !options.force && existsSync(existingGraph);

      try {
        if (useUpdate) {
          // Incremental: use `graphify update <path>` (re-extracts code, no LLM)
          const updateCmd = `${graphifyInfo.command} update "${repoPath}"`;
          log.debug(`  Incremental: ${updateCmd}`);
          execSync(updateCmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 600_000, env: PYTHON_ENV });
          // Copy the updated graph to our temp dir
          copyFileSync(existingGraph, join(repoOutDir, "graph.json"));
        } else {
          // Initial build: write Python script to temp file and execute.
          // This avoids quoting/escaping issues with `python -c "..."` on Windows.
          const script = buildPythonScript(repoPath, repoOutDir, config.build.exclude);
          const scriptPath = join(tmpDir, `${repo.name}_build.py`);
          writeFileSync(scriptPath, script);
          log.debug(`  Initial build via Python API (${scriptPath})`);
          const output = execSync(`python "${scriptPath}"`, {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 600_000,
            cwd: repoPath,
            env: PYTHON_ENV,
          });
          if (output.trim()) log.info(`  ${output.trim()}`);
        }

        const graphJson = join(repoOutDir, "graph.json");
        if (existsSync(graphJson)) {
          repoGraphs.push(graphJson);
          log.info(`  \u2713 ${repo.name}`);
        } else {
          log.error(`  \u2717 ${repo.name}: graph.json not produced`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`  \u2717 ${repo.name}: ${msg}`);
      }
    }

    if (repoGraphs.length === 0) {
      log.error("No graphs were generated. Check repo paths and graphify installation.");
      process.exit(1);
    }

    // 3. Merge graphs via `graphify merge-graphs`
    const mergedPath = join(outputDir, "graph.json");
    if (repoGraphs.length > 1) {
      const filesArg = repoGraphs.map((f) => `"${f}"`).join(" ");
      const mergeCmd = `${graphifyInfo.command} merge-graphs ${filesArg} --out "${mergedPath}"`;
      log.info("Merging graphs...");
      execSync(mergeCmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env: PYTHON_ENV });
    } else {
      // Single repo - just copy
      copyFileSync(repoGraphs[0]!, mergedPath);
    }
    log.info(`\u2713 Merged graph: ${mergedPath}`);

    // 4. Post-process
    const basePaths = config.repos.map((r) => resolve(configDir, r.path));
    postProcess(mergedPath, basePaths);

    // 5. Post-build analysis (report + HTML visualization)
    runPostBuildAnalysis(mergedPath, outputDir, config, tmpDir);

    // 6. Generate search index
    await runIndexer(mergedPath, outputDir);

    log.info("");
    log.info("Build complete!");
    log.info(`  Output: ${outputDir}`);
    log.info(`  Repos: ${config.repos.length}`);
  } finally {
    // Cleanup temp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Post-build analysis: generate GRAPH_REPORT.md and optionally graph.html.
 *
 * Writes a Python script that:
 * 1. Loads graph.json into networkx
 * 2. Runs cluster + score_all + god_nodes + surprising_connections + suggest_questions
 * 3. Generates GRAPH_REPORT.md via report.generate()
 * 4. If html enabled: generates graph.html via to_html() (filtered for large graphs)
 */
function runPostBuildAnalysis(mergedPath: string, outputDir: string, config: Config, tmpDir: string): void {
  const pyMergedPath = mergedPath.replace(/\\/g, "/");
  const pyOutputDir = outputDir.replace(/\\/g, "/");
  const htmlEnabled = config.build.html;
  const htmlMinDegree = config.build.html_min_degree;

  const htmlBlock = htmlEnabled
    ? `
# HTML visualization
from graphify.export import to_html

threshold = ${htmlMinDegree}
subgraph_nodes = [n for n in G.nodes() if G.degree(n) >= threshold]
H = G.subgraph(subgraph_nodes).copy()
# Retain only community members present in subgraph
sub_communities = {}
node_set = set(H.nodes())
for cid, members in communities.items():
    filtered = [m for m in members if m in node_set]
    if filtered:
        sub_communities[cid] = filtered
to_html(H, sub_communities, str(out / "graph.html"))
print(f"  graph.html written ({H.number_of_nodes()} nodes, degree >= {threshold})")
`
    : "";

  const script = `
import sys, json
from pathlib import Path

try:
    from graphify.cluster import cluster
    from graphify.analyze import score_all, god_nodes, surprising_connections, suggest_questions
    from graphify.report import generate as generate_report
    from graphify.build import build_from_json
    import networkx as nx
except ImportError as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)

graph_path = Path("${pyMergedPath}")
out = Path("${pyOutputDir}")

# Load graph.json into networkx
with open(graph_path) as f:
    data = json.load(f)

G = nx.DiGraph()
for node in data.get("nodes", []):
    G.add_node(node["id"], **{k: v for k, v in node.items() if k != "id"})
for edge in data.get("edges", data.get("links", [])):
    G.add_edge(edge["source"], edge["target"], **{k: v for k, v in edge.items() if k not in ("source", "target")})

# Cluster and analyze
communities = cluster(G)
scores = score_all(G, communities)
gods = god_nodes(G)
surprises = surprising_connections(G, communities)
labels = {cid: f"Community {cid}" for cid in communities}
questions = suggest_questions(G, communities, labels)

# Generate report (always)
generate_report(
    G, communities, scores, gods, surprises, questions, labels,
    output_path=str(out / "GRAPH_REPORT.md")
)
print(f"  GRAPH_REPORT.md written")
${htmlBlock}
`.trim();

  const scriptPath = join(tmpDir, "post_build_analysis.py");
  writeFileSync(scriptPath, script);

  log.info("Running post-build analysis...");
  try {
    const output = execSync(`python "${scriptPath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 300_000,
      env: PYTHON_ENV,
    });
    if (output.trim()) {
      for (const line of output.trim().split("\n")) {
        log.info(line);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`Post-build analysis failed (non-fatal): ${msg}`);
  }
}
