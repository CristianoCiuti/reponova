/**
 * graph_similar MCP tool — semantic similarity search via vector embeddings.
 */
import { VectorStore } from "../../core/vector-store.js";
import { EmbeddingEngine, composeNodeText } from "../../build/embeddings.js";
import type { EmbeddingsConfig } from "../../shared/types.js";

let vectorStore: VectorStore | null = null;
let embeddingEngine: EmbeddingEngine | null = null;

/**
 * Initialize the similarity search backend.
 * Called once when the MCP server starts.
 */
export async function initSimilaritySearch(graphDir: string, embeddingsConfig: EmbeddingsConfig): Promise<boolean> {
  vectorStore = new VectorStore(graphDir);
  const hasData = await vectorStore.loadExisting();

  if (!hasData) {
    vectorStore = null;
    return false;
  }

  // Initialize embedding engine for query-time embedding
  embeddingEngine = new EmbeddingEngine(embeddingsConfig);
  const engineReady = await embeddingEngine.initialize();

  if (!engineReady) {
    embeddingEngine = null;
    // Vector store still usable if we get pre-computed query vectors
    // but without the engine we can't embed new queries
    return false;
  }

  return true;
}

/**
 * Handle the graph_similar tool call.
 */
export async function handleSimilar(_db: unknown, args: Record<string, unknown>) {
  const query = args.query as string;
  if (!query) {
    return { content: [{ type: "text" as const, text: "Error: 'query' is required" }], isError: true };
  }

  if (!vectorStore || !embeddingEngine) {
    return {
      content: [{
        type: "text" as const,
        text: "Semantic search not available. Run `graphify-mcp-tools build` with embeddings enabled to generate vectors.",
      }],
      isError: true,
    };
  }

  const topK = (args.top_k as number) ?? 10;
  const typeFilter = args.type as string | undefined;
  const repoFilter = args.repo as string | undefined;

  // Embed the query
  const queryResults = await embeddingEngine.embedBatch([{ id: "_query", text: query }]);
  if (queryResults.length === 0) {
    return {
      content: [{ type: "text" as const, text: "Failed to generate query embedding." }],
      isError: true,
    };
  }

  const queryVector = queryResults[0].vector;

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
    const r = results[i];
    const scoreStr = (r.score * 100).toFixed(1);
    lines.push(`${i + 1}. [${r.type}] ${r.label} — ${scoreStr}% similarity`);
    if (r.source_file) lines.push(`   File: ${r.source_file}`);
    if (r.repo) lines.push(`   Repo: ${r.repo}`);
    if (r.community) lines.push(`   Community: ${r.community}`);
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

/**
 * Cleanup resources.
 */
export async function disposeSimilaritySearch(): Promise<void> {
  if (embeddingEngine) await embeddingEngine.dispose();
  if (vectorStore) await vectorStore.dispose();
  embeddingEngine = null;
  vectorStore = null;
}
