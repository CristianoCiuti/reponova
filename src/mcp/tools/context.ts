/**
 * graph_context MCP tool — smart context builder with token budget.
 *
 * Returns token-budgeted, relevance-ranked context for any query.
 * Combines text search, vector similarity, graph expansion, and community summaries.
 */
import type { Database } from "../../core/db.js";
import { ContextBuilder } from "../../core/context-builder.js";
import type { EmbeddingsConfig } from "../../shared/types.js";

let contextBuilder: ContextBuilder | null = null;
let _initPromise: Promise<void> | null = null;

async function _doInit(
  db: Database,
  graphDir: string,
  embeddingsConfig?: EmbeddingsConfig,
  cacheDir?: string,
): Promise<void> {
  try {
    contextBuilder = new ContextBuilder(db, graphDir);
    await contextBuilder.initialize(embeddingsConfig, cacheDir);
  } catch {
    contextBuilder = null;
  }
}

/**
 * Initialize the context builder. Called once at MCP server start.
 */
export async function initContextBuilder(
  db: Database,
  graphDir: string,
  embeddingsConfig?: EmbeddingsConfig,
  cacheDir?: string,
): Promise<void> {
  _initPromise = _doInit(db, graphDir, embeddingsConfig, cacheDir);
  return _initPromise;
}

/**
 * Handle the graph_context tool call.
 */
export async function handleContext(db: Database, graphDir: string, args: Record<string, unknown>) {
  const query = args.query as string;
  if (!query) {
    return { content: [{ type: "text" as const, text: "Error: 'query' parameter is required" }], isError: true };
  }

  if (_initPromise) {
    await _initPromise;
  }

  // Lazy init if not already done
  if (!contextBuilder) {
    contextBuilder = new ContextBuilder(db, graphDir);
    await contextBuilder.initialize();
  }

  const maxTokens = (args.max_tokens as number) ?? 4096;
  const scope = args.scope as string | undefined;
  const includeSource = (args.include_source as boolean) ?? false;
  const format = (args.format as "structured" | "narrative") ?? "narrative";

  const result = await contextBuilder.buildContext({
    query,
    max_tokens: maxTokens,
    scope,
    include_source: includeSource,
    format,
  });

  if (format === "structured" && result.structured) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(result.structured, null, 2),
      }],
    };
  }

  return {
    content: [{
      type: "text" as const,
      text: contextBuilder.formatAsText(result),
    }],
  };
}

/**
 * Dispose context builder resources.
 */
export async function disposeContextBuilder(): Promise<void> {
  if (contextBuilder) {
    await contextBuilder.dispose();
    contextBuilder = null;
  }
  _initPromise = null;
}
