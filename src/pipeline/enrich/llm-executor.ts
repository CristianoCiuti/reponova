/**
 * LLM executor — parallel batch execution with concurrency limit and retry.
 *
 * Adapts the LlmProvider.generate() interface to batch-oriented execution.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { LlmProvider } from "../../intelligence/llm-provider.js";
import { errorMessage, log } from "../../shared/utils.js";

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
 * Throws on failure — error message describes the reason.
 */
async function callLlm(config: ExecutorConfig, options: LlmCallOptions): Promise<string> {
  return config.provider.generate({
    systemPrompt: options.system,
    userPrompt: options.user,
    maxTokens: options.maxTokens,
    temperature: 0,
  });
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
  /** Number of items in this batch (for progress tracking). */
  itemCount?: number;
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

  const totalBatches = jobs.length;
  const totalItems = jobs.reduce((sum, j) => sum + (j.itemCount ?? 0), 0);
  let completedBatches = 0;
  let failed = 0;
  let itemsProcessed = 0;

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
            completedBatches++;
            itemsProcessed += job.itemCount ?? 0;
            if (totalItems > 0) {
              log.info(`    Batch ${completedBatches}/${totalBatches} completed — ${itemsProcessed}/${totalItems} items`);
            } else {
              log.info(`    Batch ${completedBatches}/${totalBatches} completed`);
            }
            return;
          } catch (err) {
            attempts++;
            const reason = errorMessage(err);
            if (attempts > config.maxRetryDepth) {
              log.warn(`    Batch ${job.batchId} failed after ${attempts} attempts: ${reason}`);
              failed++;
              return;
            }
            log.info(`    Batch ${job.batchId} retry ${attempts}/${config.maxRetryDepth} — ${reason}`);
          }
        }
      })().finally(() => {
        running--;
      }),
    );
  }

  await Promise.all(results);
  return { completed: completedBatches, failed };
}

/**
 * Execute a single LLM call (for non-batched steps like restructure detection).
 */
export async function executeSingle(config: ExecutorConfig, prompt: LlmCallOptions): Promise<string> {
  return callLlm(config, prompt);
}
