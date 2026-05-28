/**
 * OpenAI-compatible LLM provider.
 *
 * Uses undici fetch with custom dispatcher to avoid Node.js default 300s
 * headersTimeout (which silently kills long-running LLM requests).
 * No retry on any error — returns null and lets the generator fall back
 * to algorithmic per-item.
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

  async generate(options: LlmCompletionOptions): Promise<string | null> {
    if (!this.available) return null;

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
        log.warn(`OpenAI LLM: HTTP ${response.status} from ${url}`);
        return null;
      }

      const json = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const content = json.choices?.[0]?.message?.content;
      return content?.trim() ?? null;
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.includes("abort")) {
        log.warn(`OpenAI LLM: request timed out after ${this.options.timeout}s`);
      } else {
        log.warn(`OpenAI LLM: request failed: ${msg}`);
      }
      return null;
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
