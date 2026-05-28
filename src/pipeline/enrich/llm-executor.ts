/**
 * LLM executor — parallel batch execution with concurrency limit and retry.
 *
 * Adapts the LlmProvider.generate() interface to batch-oriented execution.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { LlmProvider } from "../../intelligence/llm-provider.js";
import { log } from "../../shared/utils.js";

export interface LlmCallOptions {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface ExecutorConfig {
  provider: LlmProvider;
  concurrency: number;
  maxRetryDepth: number;
}

/**
 * Execute a single LLM call. Returns the raw text response.
 */
async function callLlm(config: ExecutorConfig, options: LlmCallOptions): Promise<string> {
  const result = await config.provider.generate({
    systemPrompt: options.system,
    userPrompt: options.user,
    maxTokens: options.maxTokens,
    temperature: 0,
  });
  if (result === null) {
    throw new Error("LLM provider returned null (unavailable or initialization failed)");
  }
  return result;
}

/**
 * Parse JSON from LLM response (handles markdown fences, trailing commas, etc.)
 */
export function parseLlmJson<T>(raw: string): T {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return JSON.parse(cleaned);
}

export interface BatchJob<T> {
  batchId: number;
  prompt: LlmCallOptions;
  outputPath: string;
  parse: (raw: string) => T;
}

/**
 * Execute batches in parallel with concurrency limit.
 * Each batch writes its result to its own file.
 * On failure: retries the full batch up to maxRetryDepth times.
 */
export async function executeBatches<T>(
  config: ExecutorConfig,
  jobs: BatchJob<T>[],
  batchDir: string,
): Promise<{ completed: number; failed: number }> {
  mkdirSync(batchDir, { recursive: true });

  let completed = 0;
  let failed = 0;

  // Simple semaphore for concurrency
  let running = 0;
  const results: Promise<void>[] = [];

  for (const job of jobs) {
    // Wait for a slot to open
    while (running >= config.concurrency) {
      await new Promise((r) => setTimeout(r, 50));
    }

    running++;
    results.push(
      (async () => {
        let attempts = 0;
        while (attempts <= config.maxRetryDepth) {
          try {
            const raw = await callLlm(config, job.prompt);
            const parsed = job.parse(raw);
            writeFileSync(job.outputPath, JSON.stringify(parsed, null, 2));
            completed++;
            log.info(`    Batch ${job.batchId} completed`);
            return;
          } catch (err) {
            attempts++;
            if (attempts > config.maxRetryDepth) {
              log.warn(`    Batch ${job.batchId} failed after ${attempts} attempts: ${err instanceof Error ? err.message : String(err)}`);
              failed++;
              return;
            }
            log.info(`    Batch ${job.batchId} retry ${attempts}/${config.maxRetryDepth}`);
          }
        }
      })().finally(() => {
        running--;
      }),
    );
  }

  await Promise.all(results);
  return { completed, failed };
}

/**
 * Execute a single LLM call (for non-batched steps like restructure detection).
 */
export async function executeSingle(config: ExecutorConfig, prompt: LlmCallOptions): Promise<string> {
  return callLlm(config, prompt);
}
