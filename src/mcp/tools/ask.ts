/**
 * graph_ask MCP tool — natural language question → routed answer.
 *
 * Classifies the question and routes to the appropriate graph tool strategy.
 * No LLM at query time — uses regex + keyword classification.
 */
import type { Database } from "../../core/db.js";
import { classifyQuestion } from "../../core/question-classifier.js";
import { searchNodes } from "../../core/search.js";
import { analyzeImpact, formatImpactMarkdown } from "../../core/impact.js";
import { findShortestPath, formatPathMarkdown } from "../../core/shortest-path.js";
import { getNodeDetail, formatNodeDetailMarkdown, getNodeSuggestions } from "../../core/node-detail.js";
import { fuzzyMatchNode } from "../../core/search.js";
import { handleSimilar } from "./similar.js";
import { handleContext } from "./context.js";

/**
 * Handle the graph_ask tool call.
 */
export async function handleAsk(db: Database, graphDir: string, args: Record<string, unknown>) {
  const question = args.question as string;
  if (!question) {
    return { content: [{ type: "text" as const, text: "Error: 'question' parameter is required" }], isError: true };
  }

  const maxTokens = (args.max_tokens as number) ?? 2048;
  const classification = classifyQuestion(question);

  switch (classification.strategy) {
    case "impact_downstream": {
      const entity = classification.entities[0] ?? question;
      const nodeId = resolveNodeId(db, entity);
      if (!nodeId) return notFound(entity);
      const result = analyzeImpact(db, nodeId, { direction: "downstream", max_depth: 3 });
      if (!result) return notFound(entity);
      return {
        content: [{
          type: "text" as const,
          text: `> Strategy: impact (downstream) | Entity: "${entity}"\n\n${formatImpactMarkdown(result)}`,
        }],
      };
    }

    case "impact_upstream": {
      const entity = classification.entities[0] ?? question;
      const nodeId = resolveNodeId(db, entity);
      if (!nodeId) return notFound(entity);
      const result = analyzeImpact(db, nodeId, { direction: "upstream", max_depth: 3 });
      if (!result) return notFound(entity);
      return {
        content: [{
          type: "text" as const,
          text: `> Strategy: impact (upstream) | Entity: "${entity}"\n\n${formatImpactMarkdown(result)}`,
        }],
      };
    }

    case "path": {
      const [fromEntity, toEntity] = classification.entities;
      if (!fromEntity || !toEntity) {
        return { content: [{ type: "text" as const, text: "Could not identify source and target for path query. Try: 'path from X to Y'" }], isError: true };
      }
      const fromId = resolveNodeId(db, fromEntity);
      const toId = resolveNodeId(db, toEntity);
      if (!fromId) return notFound(fromEntity);
      if (!toId) return notFound(toEntity);
      const result = findShortestPath(db, fromId, toId, { max_depth: 10 });
      return {
        content: [{
          type: "text" as const,
          text: `> Strategy: path | From: "${fromEntity}" → To: "${toEntity}"\n\n${formatPathMarkdown(result)}`,
        }],
      };
    }

    case "explain": {
      const entity = classification.entities[0] ?? question;
      const detail = getNodeDetail(db, entity);
      if (!detail) {
        // Try fuzzy match
        const nodeId = resolveNodeId(db, entity);
        if (nodeId) {
          const retryDetail = getNodeDetail(db, nodeId);
          if (retryDetail) {
            return {
              content: [{
                type: "text" as const,
                text: `> Strategy: explain | Entity: "${entity}"\n\n${formatNodeDetailMarkdown(retryDetail)}`,
              }],
            };
          }
        }
        return notFound(entity);
      }
      return {
        content: [{
          type: "text" as const,
          text: `> Strategy: explain | Entity: "${entity}"\n\n${formatNodeDetailMarkdown(detail)}`,
        }],
      };
    }

    case "search": {
      const entity = classification.entities[0] ?? question;
      const results = searchNodes(db, entity, { top_k: 10 });
      if (results.length === 0) return notFound(entity);

      const lines = [`> Strategy: search | Query: "${entity}"`, "", `## Search Results (${results.length})`, ""];
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        lines.push(`${i + 1}. [${r.type}] **${r.label}**`);
        if (r.source_file) lines.push(`   File: ${r.source_file}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    case "similar": {
      const entity = classification.entities[0] ?? question;
      return await handleSimilar(db, { query: entity, top_k: 10 });
    }

    case "architecture": {
      // Use context builder with architecture-focused query
      return await handleContext(db, graphDir, {
        query: "architecture main components modules hotspots",
        max_tokens: maxTokens,
        format: "narrative",
      });
    }

    case "context":
    default: {
      // Fallback: use smart context builder
      return await handleContext(db, graphDir, {
        query: question,
        max_tokens: maxTokens,
        format: "narrative",
      });
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a natural language entity to a node ID.
 * Tries: exact ID match → exact label match → fuzzy match.
 */
function resolveNodeId(db: Database, entity: string): string | null {
  // Try exact match first
  const matches = fuzzyMatchNode(db, entity, 1);
  if (matches.length > 0) return matches[0]!.id;
  return null;
}

function notFound(entity: string) {
  return {
    content: [{
      type: "text" as const,
      text: `No node found matching "${entity}". Try a different name or use graph_search to find available symbols.`,
    }],
    isError: true,
  };
}
