/**
 * CLI command: models — manage downloaded AI models.
 *
 * Subcommands:
 *   status   — show downloaded models and their sizes
 *   download — pre-download all models (embedding + LLM)
 *   clear    — remove all cached models
 */
import type { CommandModule } from "yargs";
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../shared/utils.js";

const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "reponova", "models");

function resolveCacheDir(dir?: string): string {
  if (!dir) return DEFAULT_CACHE_DIR;
  if (dir.startsWith("~")) return join(homedir(), dir.slice(1));
  return resolve(dir);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getDirSize(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  let size = 0;
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    } else {
      size += statSync(fullPath).size;
    }
  }
  return size;
}

async function statusAction(cacheDir: string): Promise<void> {
  const resolvedDir = resolveCacheDir(cacheDir);
  console.log(`Model cache: ${resolvedDir}\n`);

  if (!existsSync(resolvedDir)) {
    console.log("  No models downloaded yet.");
    console.log("  Run 'reponova models download' or build a project to auto-download.");
    return;
  }

  // Check embedding model
  const embeddingDir = join(resolvedDir, "all-MiniLM-L6-v2");
  const embeddingModel = join(embeddingDir, "model.onnx");
  const embeddingVocab = join(embeddingDir, "vocab.txt");

  console.log("┌─ Embedding Model (all-MiniLM-L6-v2)");
  if (existsSync(embeddingModel) && existsSync(embeddingVocab)) {
    const size = getDirSize(embeddingDir);
    console.log(`│  Status: ✅ Downloaded`);
    console.log(`│  Size:   ${formatSize(size)}`);
    console.log(`│  Path:   ${embeddingDir}`);
  } else {
    console.log(`│  Status: ❌ Not downloaded`);
  }
  console.log("│");

  // Check LLM model
  const llmDir = join(resolvedDir, "llm");
  console.log("├─ LLM Model (Qwen 2.5 3B Instruct Q4_K_M)");
  if (existsSync(llmDir)) {
    const size = getDirSize(llmDir);
    if (size > 0) {
      console.log(`│  Status: ✅ Downloaded`);
      console.log(`│  Size:   ${formatSize(size)}`);
      console.log(`│  Path:   ${llmDir}`);
    } else {
      console.log(`│  Status: ❌ Not downloaded`);
    }
  } else {
    console.log(`│  Status: ❌ Not downloaded`);
  }
  console.log("│");

  // Total size
  const totalSize = getDirSize(resolvedDir);
  console.log(`└─ Total: ${formatSize(totalSize)}`);
}

async function downloadAction(cacheDir: string): Promise<void> {
  const resolvedDir = resolveCacheDir(cacheDir);
  log.info(`Downloading models to: ${resolvedDir}`);

  // Download embedding model
  const { EmbeddingEngine } = await import("../build/embeddings.js");
  const embEngine = new EmbeddingEngine({
    enabled: true,
    model: "all-MiniLM-L6-v2",
    dimensions: 384,
    batch_size: 128,
    cache_dir: resolvedDir,
  });

  log.info("Downloading embedding model (all-MiniLM-L6-v2)...");
  const embReady = await embEngine.initialize();
  if (embReady) {
    log.info("  ✓ Embedding model ready");
    await embEngine.dispose();
  } else {
    log.warn("  ✗ Failed to download/initialize embedding model");
  }

  // Download LLM model
  const { LlmEngine } = await import("../build/llm-engine.js");
  const llmEngine = new LlmEngine({
    enabled: true,
    model: "qwen2.5-3b-instruct",
    quantization: "Q4_K_M",
    gpu: "auto",
    context_size: 4096,
    threads: 0,
    download_on_first_use: true,
    cache_dir: resolvedDir,
  });

  log.info("Downloading LLM model (Qwen 2.5 3B Instruct Q4_K_M)...");
  const llmReady = await llmEngine.initialize();
  if (llmReady) {
    log.info("  ✓ LLM model ready");
    await llmEngine.dispose();
  } else {
    log.warn("  ✗ Failed to download/initialize LLM model (requires node-llama-cpp)");
  }

  log.info("Done.");
}

async function clearAction(cacheDir: string): Promise<void> {
  const resolvedDir = resolveCacheDir(cacheDir);

  if (!existsSync(resolvedDir)) {
    console.log("No model cache found. Nothing to clear.");
    return;
  }

  const totalSize = getDirSize(resolvedDir);
  console.log(`Removing model cache (${formatSize(totalSize)})...`);

  rmSync(resolvedDir, { recursive: true, force: true });
  console.log("✓ Model cache cleared.");
}

export const modelsCommand: CommandModule = {
  command: "models <action>",
  describe: "Manage downloaded AI models (embedding + LLM)",
  builder: (yargs) =>
    yargs
      .positional("action", {
        type: "string",
        choices: ["status", "download", "clear"] as const,
        describe: "Action: status, download, or clear",
      })
      .option("cache-dir", {
        type: "string",
        describe: "Model cache directory (default: ~/.cache/reponova/models)",
      }),
  handler: async (argv) => {
    const action = argv.action as string;
    const cacheDir = argv["cache-dir"] as string | undefined;

    switch (action) {
      case "status":
        await statusAction(cacheDir);
        break;
      case "download":
        await downloadAction(cacheDir);
        break;
      case "clear":
        await clearAction(cacheDir);
        break;
      default:
        console.error(`Unknown action: ${action}. Use: status, download, or clear`);
        process.exit(1);
    }
  },
};
