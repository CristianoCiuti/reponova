/**
 * OpenAI-compatible embedding provider.
 *
 * Uses native fetch() (Node 18+). Retries on HTTP 429 only (3 attempts,
 * exponential backoff 1s → 2s → 4s). Fails immediately on other errors.
 */
import { log, errorMessage } from "../shared/utils.js";
import type { EmbeddingProvider } from "./llm-provider.js";
import type { EmbeddingResult } from "./embeddings.js";
import { resolveApiKey } from "./openai-provider.js";

export interface OpenAiEmbeddingProviderOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeout: number;
  batchSize: number;
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  private options: OpenAiEmbeddingProviderOptions;
  private resolvedApiKey: string | undefined;
  private available = false;

  constructor(options: OpenAiEmbeddingProviderOptions) {
    this.options = options;
  }

  async initialize(): Promise<boolean> {
    this.resolvedApiKey = resolveApiKey(this.options.apiKey);

    if (this.options.apiKey && !this.resolvedApiKey) {
      const envMatch = this.options.apiKey.match(/^env:(.+)$/);
      if (envMatch) {
        log.warn(`OpenAI embedding provider: env var ${envMatch[1]} is not set — provider unavailable`);
      }
      return false;
    }

    this.available = true;
    log.info(`OpenAI embedding provider initialized (model=${this.options.model}, endpoint=${this.options.baseUrl})`);
    return true;
  }

  async embedBatch(items: Array<{ id: string; text: string }>): Promise<EmbeddingResult[]> {
    if (!this.available || items.length === 0) return [];

    const results: EmbeddingResult[] = [];
    const batchSize = this.options.batchSize;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await this.embedSingleBatch(batch);
      results.push(...batchResults);

      if (i + batchSize < items.length && results.length > 0) {
        log.info(`  OpenAI embeddings: ${results.length}/${items.length} embedded`);
      }
    }

    return results;
  }

  private async embedSingleBatch(
    items: Array<{ id: string; text: string }>,
  ): Promise<EmbeddingResult[]> {
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/embeddings`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.resolvedApiKey) {
      headers["Authorization"] = `Bearer ${this.resolvedApiKey}`;
    }

    const body = JSON.stringify({
      model: this.options.model,
      input: items.map((item) => item.text),
    });

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.options.timeout * 1000);

        const response = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.status === 429 && attempt < MAX_RETRIES) {
          const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          log.warn(`OpenAI embeddings: rate limited (429), retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await sleep(backoff);
          continue;
        }

        if (!response.ok) {
          log.warn(`OpenAI embeddings: HTTP ${response.status} from ${url}`);
          return [];
        }

        const json = await response.json() as {
          data?: Array<{ embedding?: number[]; index?: number }>;
        };

        if (!json.data || !Array.isArray(json.data)) {
          log.warn("OpenAI embeddings: malformed response — missing data array");
          return [];
        }

        // Sort by index to match input order
        const sorted = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

        return sorted.map((entry, idx) => {
          const item = items[idx]!;
          const vector = entry.embedding ?? [];
          return {
            id: item.id,
            text: item.text,
            vector: new Float32Array(vector),
          };
        });
      } catch (err) {
        const msg = errorMessage(err);
        if (msg.includes("abort")) {
          log.warn(`OpenAI embeddings: request timed out after ${this.options.timeout}s`);
        } else {
          log.warn(`OpenAI embeddings: request failed: ${msg}`);
        }
        return [];
      }
    }

    log.warn("OpenAI embeddings: all retries exhausted");
    return [];
  }

  async dispose(): Promise<void> {
    this.available = false;
  }

  get isAvailable(): boolean {
    return this.available;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
