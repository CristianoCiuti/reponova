/**
 * OpenAI-compatible LLM provider.
 *
 * Uses undici fetch with custom dispatcher to avoid Node.js default 300s
 * headersTimeout (which silently kills long-running LLM requests).
 * Throws on any error with a descriptive message — callers handle retry.
 */
import { fetch, Agent } from "undici";
import { log, errorMessage } from "../shared/utils.js";
import type { LlmProvider, LlmCompletionOptions } from "./llm-provider.js";

export interface OpenAiLlmProviderOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeout: number;
}

export class OpenAiLlmProvider implements LlmProvider {
  private options: OpenAiLlmProviderOptions;
  private resolvedApiKey: string | undefined;
  private available = false;
  private dispatcher: Agent;

  constructor(options: OpenAiLlmProviderOptions) {
    this.options = options;
    this.dispatcher = new Agent({
      headersTimeout: options.timeout * 1000,
      bodyTimeout: options.timeout * 1000,
      connectTimeout: 30_000,
    });
  }

  async initialize(): Promise<boolean> {
    this.resolvedApiKey = resolveApiKey(this.options.apiKey);

    // Validate that we have what we need (no network call)
    if (this.options.apiKey && !this.resolvedApiKey) {
      const envMatch = this.options.apiKey.match(/^env:(.+)$/);
      if (envMatch) {
        log.warn(`OpenAI LLM provider: env var ${envMatch[1]} is not set — provider unavailable`);
      }
      return false;
    }

    this.available = true;
    log.info(`OpenAI LLM provider initialized (model=${this.options.model}, endpoint=${this.options.baseUrl})`);
    return true;
  }

  async generate(options: LlmCompletionOptions): Promise<string> {
    if (!this.available) {
      throw new Error("Provider not available (not initialized or initialization failed)");
    }

    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.resolvedApiKey) {
      headers["Authorization"] = `Bearer ${this.resolvedApiKey}`;
    }

    const body = JSON.stringify({
      model: this.options.model,
      messages: [
        { role: "system", content: options.systemPrompt },
        { role: "user", content: options.userPrompt },
      ],
      max_tokens: options.maxTokens ?? 200,
      temperature: options.temperature ?? 0.7,
    });

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.options.timeout * 1000);

      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        dispatcher: this.dispatcher,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${url}`);
      }

      const json = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const content = json.choices?.[0]?.message?.content?.trim();
      if (!content) {
        throw new Error("Empty response from LLM (no content in choices)");
      }
      return content;
    } catch (err) {
      // Re-throw our own errors (HTTP status, empty response)
      if (err instanceof Error && (err.message.startsWith("HTTP ") || err.message.startsWith("Empty response"))) {
        throw err;
      }
      // Wrap network/abort errors with context
      const msg = errorMessage(err);
      if (msg.includes("abort")) {
        throw new Error(`Request timed out after ${this.options.timeout}s`);
      }
      throw new Error(`Request failed: ${msg}`);
    }
  }

  async dispose(): Promise<void> {
    this.available = false;
    await this.dispatcher.close();
  }

  get isAvailable(): boolean {
    return this.available;
  }
}

/**
 * Resolve API key from config value.
 * - "env:VAR_NAME" → reads process.env.VAR_NAME
 * - literal string → as-is
 * - undefined → undefined (no auth header)
 */
export function resolveApiKey(raw?: string): string | undefined {
  if (!raw) return undefined;
  const envMatch = raw.match(/^env:(.+)$/);
  if (envMatch) {
    return process.env[envMatch[1]!] ?? undefined;
  }
  return raw;
}
