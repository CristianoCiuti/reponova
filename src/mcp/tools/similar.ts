/**
 * graph_similar MCP tool — semantic similarity search via vector embeddings.
 */
import { VectorStore } from "../../query/vector-store.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TfidfEmbeddingEngine } from "../../intelligence/tfidf-embeddings.js";
import type { EmbeddingsConfig } from "../../shared/types.js";
import type { PathResolver } from "../../shared/path-resolver.js";

let vectorStore: VectorStore | null = null;
let tfidfEngine: TfidfEmbeddingEngine | null = null;
let _initPromise: Promise<boolean> | null = null;

/**
 * Initialize the similarity search backend.
 * Called once when the MCP server starts. Stores the promise so that
 * handleSimilar can await readiness before checking state.
 */
export function initSimilaritySearch(graphDir: string, embeddingsConfig: EmbeddingsConfig, cacheDir: string): Promise<boolean> {
  _initPromise = _doInitSimilaritySearch(graphDir, embeddingsConfig, cacheDir);
  return _initPromise;
}

async function _doInitSimilaritySearch(graphDir: string, embeddingsConfig: EmbeddingsConfig, _cacheDir: string): Promise<boolean> {
  vectorStore = new VectorStore(graphDir);
  await vectorStore.initialize();
  const hasData = await vectorStore.loadExisting();

  if (!hasData) {
    vectorStore = null;
    return false;
  }

  const tfidfIdfPath = join(graphDir, "tfidf_idf.json");

  if (!embeddingsConfig.provider && existsSync(tfidfIdfPath)) {
    // Load pre-built IDF table for query-time embedding
    const engine = new TfidfEmbeddingEngine();
    const loaded = engine.loadVocabulary(graphDir);
    if (!loaded) {
      vectorStore = null;
      return false;
    }
    tfidfEngine = engine;
    return true;
  }

  return embeddingsConfig.provider ? true : false;
}

/**
 * Handle the graph_similar tool call.
 */
export async function handleSimilar(
  _db: unknown,
  args: Record<string, unknown>,
  resolvePaths?: PathResolver | null,
) {
  // Wait for initialization to complete before checking state
  if (_initPromise) {
    await _initPromise;
  }

  const query = args.query as string;
  if (!query) {
    return { content: [{ type: "text" as const, text: "Error: 'query' is required" }], isError: true };
  }

  if (!vectorStore || !tfidfEngine) {
    return {
      content: [{
        type: "text" as const,
        text: "Semantic search not available. Run `reponova build` with embeddings enabled to generate vectors.",
      }],
      isError: true,
    };
  }

  const topK = (args.top_k as number) ?? 10;
  const typeFilter = args.type as string | undefined;
  const repoFilter = args.repo as string | undefined;

  // Embed the query using whatever method was configured
  const queryVector = tfidfEngine.embedQuery(query);

  // Search
  const results = await vectorStore.query(queryVector, {
    top_k: topK,
    type_filter: typeFilter,
    repo_filter: repoFilter,
  });

  if (results.length === 0) {
    return { content: [{ type: "text" as const, text: `No similar nodes found for "${query}"` }] };
  }

  // Format output
  const lines = [`## Similar to "${query}" (${results.length} results)`, ""];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const scoreStr = (r.score * 100).toFixed(1);
    lines.push(`${i + 1}. [${r.type}] ${r.label} — ${scoreStr}% similarity`);
    if (r.source_file) {
      lines.push(`   File: ${r.source_file}`);
      if (resolvePaths) {
        const paths = resolvePaths(r.source_file);
        if (paths.graph_rel_path) lines.push(`   Graph path: ${paths.graph_rel_path}`);
        if (paths.absolute_path) lines.push(`   Absolute path: ${paths.absolute_path}`);
      }
    }
    if (r.repo) lines.push(`   Repo: ${r.repo}`);
    if (r.community) lines.push(`   Community: ${r.community}`);
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

/**
 * Cleanup resources.
 */
export async function disposeSimilaritySearch(): Promise<void> {
  if (vectorStore) await vectorStore.dispose();
  if (tfidfEngine) tfidfEngine.dispose();
  vectorStore = null;
  tfidfEngine = null;
}
