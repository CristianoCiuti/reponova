/**
 * Abstract provider contracts for LLM and embedding providers.
 *
 * Both local (node-llama-cpp, ONNX) and remote (OpenAI-compatible)
 * providers implement these interfaces.
 */
import type { EmbeddingResult } from "./embeddings.js";

export interface LlmCompletionOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Abstract LLM provider contract.
 * Both local (node-llama-cpp) and remote (OpenAI-compatible) implement this.
 */
export interface LlmProvider {
  readonly isAvailable: boolean;
  initialize(): Promise<boolean>;
  generate(options: LlmCompletionOptions): Promise<string | null>;
  dispose(): Promise<void>;
}

/**
 * Abstract embedding provider contract.
 * Both local (ONNX) and remote (OpenAI-compatible) implement this.
 */
export interface EmbeddingProvider {
  readonly isAvailable: boolean;
  initialize(): Promise<boolean>;
  embedBatch(items: Array<{ id: string; text: string }>): Promise<EmbeddingResult[]>;
  dispose(): Promise<void>;
}
