/**
 * CLI command: models — manage downloaded AI models.
 */
import type { CommandModule } from "yargs";
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { EmbeddingEngine } from "../build/embeddings.js";
import { LlmEngine, resolveModelPath } from "../build/llm-engine.js";
import { loadConfig } from "../core/config.js";
import type { Config, ModelsConfig } from "../shared/types.js";
import { log } from "../shared/utils.js";

const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "reponova", "models");

type ModelKind = "onnx" | "llm";

interface CachedModel {
  kind: ModelKind;
  name: string;
  path: string;
  sizeBytes: number;
}

interface ConfiguredModelStatus {
  kind: ModelKind;
  displayName: string;
  downloaded: boolean;
  sizeBytes: number;
  path: string | null;
  usedBy: string;
}

interface CliContext {
  config: Config;
  configDir: string;
  cacheDir: string;
}

function resolveCacheDir(dir?: string, baseDir: string = process.cwd()): string {
  if (!dir) return DEFAULT_CACHE_DIR;
  if (dir.startsWith("~")) return join(homedir(), dir.slice(1));
  return resolve(baseDir, dir);
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

function loadCliContext(configPath?: string, cacheDirOverride?: string): CliContext {
  const { config, configDir } = loadConfig(configPath);
  const cacheDir = cacheDirOverride
    ? resolveCacheDir(cacheDirOverride)
    : resolveCacheDir(config.models.cache_dir, configDir);

  return { config, configDir, cacheDir };
}

function getCachedOnnxModels(cacheDir: string): CachedModel[] {
  if (!existsSync(cacheDir)) return [];

  const models: CachedModel[] = [];
  for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "llm") continue;

    const modelDir = join(cacheDir, entry.name);
    const modelPath = join(modelDir, "model.onnx");
    if (!existsSync(modelPath)) continue;

    models.push({
      kind: "onnx",
      name: entry.name,
      path: modelDir,
      sizeBytes: getDirSize(modelDir),
    });
  }

  return models.sort((a, b) => a.name.localeCompare(b.name));
}

function getCachedLlmModels(cacheDir: string): CachedModel[] {
  const llmDir = join(cacheDir, "llm");
  if (!existsSync(llmDir)) return [];

  return readdirSync(llmDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".gguf"))
    .map((entry) => {
      const modelPath = join(llmDir, entry.name);
      return {
        kind: "llm" as const,
        name: stripGgufExtension(entry.name),
        path: modelPath,
        sizeBytes: statSync(modelPath).size,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function stripGgufExtension(fileName: string): string {
  return fileName.endsWith(".gguf") ? fileName.slice(0, -5) : fileName;
}

function normalizeModelToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findFallbackLlmModel(modelUri: string, cacheDir: string): CachedModel | null {
  const cachedModels = getCachedLlmModels(cacheDir);
  if (cachedModels.length === 0) return null;

  if (!modelUri.startsWith("hf:")) {
    const explicitName = stripGgufExtension(modelUri.split(/[\\/]/).pop() ?? modelUri);
    return cachedModels.find((model) => model.name === explicitName) ?? null;
  }

  const uriBody = modelUri.slice(3);
  const [repoPart = "", quantPart = ""] = uriBody.split(":");
  const repoName = repoPart.split("/").pop() ?? repoPart;
  const repoWithoutSuffix = repoName.replace(/-gguf$/i, "");
  const repoToken = normalizeModelToken(repoWithoutSuffix);
  const quantToken = normalizeModelToken(quantPart);

  const exactMatches = cachedModels.filter((model) => {
    const normalizedName = normalizeModelToken(model.name);
    if (!normalizedName.includes(repoToken)) return false;
    if (quantToken && !normalizedName.includes(quantToken)) return false;
    return true;
  });

  if (exactMatches.length === 1) return exactMatches[0] ?? null;

  const looseMatches = cachedModels.filter((model) => {
    const normalizedName = normalizeModelToken(model.name);
    return repoToken ? normalizedName.includes(repoToken) : false;
  });

  return looseMatches.length === 1 ? looseMatches[0] ?? null : null;
}

async function getConfiguredLlmStatus(modelUri: string, cacheDir: string, usedBy: string): Promise<ConfiguredModelStatus> {
  const resolvedPath = await resolveModelPath(modelUri, cacheDir);
  if (resolvedPath && existsSync(resolvedPath)) {
    return {
      kind: "llm",
      displayName: modelUri,
      downloaded: true,
      sizeBytes: statSync(resolvedPath).size,
      path: resolvedPath,
      usedBy,
    };
  }

  const fallbackModel = findFallbackLlmModel(modelUri, cacheDir);
  if (fallbackModel) {
    return {
      kind: "llm",
      displayName: modelUri,
      downloaded: true,
      sizeBytes: fallbackModel.sizeBytes,
      path: fallbackModel.path,
      usedBy,
    };
  }

  return {
    kind: "llm",
    displayName: modelUri,
    downloaded: false,
    sizeBytes: 0,
    path: null,
    usedBy,
  };
}

async function getConfiguredModels(config: Config, cacheDir: string): Promise<{
  models: ConfiguredModelStatus[];
  sharedNodeDescriptionsModel: string | null;
}> {
  const models: ConfiguredModelStatus[] = [];
  const embeddings = config.build.embeddings;
  const communitySummaries = config.build.community_summaries;
  const nodeDescriptions = config.build.node_descriptions;

  if (embeddings.enabled && embeddings.method === "onnx") {
    const modelDir = join(cacheDir, embeddings.model);
    const modelPath = join(modelDir, "model.onnx");
    models.push({
      kind: "onnx",
      displayName: embeddings.model,
      downloaded: existsSync(modelPath),
      sizeBytes: existsSync(modelPath) ? getDirSize(modelDir) : 0,
      path: existsSync(modelPath) ? modelDir : null,
      usedBy: "build.embeddings.model",
    });
  }

  const communityModel = communitySummaries.enabled ? (communitySummaries.model ?? null) : null;
  const nodeModel = nodeDescriptions.enabled ? (nodeDescriptions.model ?? null) : null;

  if (communityModel) {
    models.push(await getConfiguredLlmStatus(communityModel, cacheDir, "build.community_summaries.model"));
  }

  const sharedNodeDescriptionsModel = communityModel && nodeModel && communityModel === nodeModel ? nodeModel : null;

  if (nodeModel && nodeModel !== communityModel) {
    models.push(await getConfiguredLlmStatus(nodeModel, cacheDir, "build.node_descriptions.model"));
  }

  return { models, sharedNodeDescriptionsModel };
}

function printSection(title: string): void {
  console.log(`── ${title} ──────────────────────────────────────`);
}

function printConfiguredModel(model: ConfiguredModelStatus): void {
  const status = model.downloaded ? "✅ Downloaded" : "❌ Not downloaded";
  const size = model.downloaded && model.sizeBytes > 0 ? `   ${formatSize(model.sizeBytes)}` : "";
  console.log(`  [${model.kind}] ${model.displayName}  ${status}${size}`);
  console.log(`         Used by: ${model.usedBy}`);
  if (model.path) {
    console.log(`         Path: ${model.path}`);
  }
  console.log("");
}

function printCachedModel(model: CachedModel): void {
  console.log(`  [${model.kind}] ${model.name}   ${formatSize(model.sizeBytes)}`);
  console.log(`         Path: ${model.path}`);
  console.log("");
}

async function statusAction(context: CliContext): Promise<void> {
  const { config, cacheDir } = context;
  const { models, sharedNodeDescriptionsModel } = await getConfiguredModels(config, cacheDir);
  const configuredOnnxNames = new Set(models.filter((model) => model.kind === "onnx").map((model) => model.displayName));
  const configuredLlmPaths = new Set(
    models
      .filter((model) => model.kind === "llm" && model.path)
      .map((model) => model.path)
      .filter((path): path is string => path !== null),
  );

  console.log(`Model cache: ${cacheDir}`);
  console.log("");

  printSection("Configured Models");
  if (models.length === 0) {
    console.log("  No models required by current configuration.");
    console.log("");
  } else {
    for (const model of models) {
      printConfiguredModel(model);
    }
    if (sharedNodeDescriptionsModel) {
      console.log(`  build.node_descriptions.model: same model as community_summaries (${sharedNodeDescriptionsModel})`);
      console.log("");
    }
  }

  const otherCachedModels = [
    ...getCachedOnnxModels(cacheDir).filter((model) => !configuredOnnxNames.has(model.name)),
    ...getCachedLlmModels(cacheDir).filter((model) => !configuredLlmPaths.has(model.path)),
  ];

  printSection("Other Cached Models");
  if (otherCachedModels.length === 0) {
    console.log("  (none)");
    console.log("");
  } else {
    for (const model of otherCachedModels) {
      printCachedModel(model);
    }
  }

  console.log(`── Total: ${formatSize(getDirSize(cacheDir))} ─────────────────────────────────────────`);
}

async function downloadEmbeddingModel(config: Config, cacheDir: string): Promise<void> {
  const engine = new EmbeddingEngine(config.build.embeddings, cacheDir, true);
  try {
    log.info(`Downloading embedding model: ${config.build.embeddings.model}`);
    const ready = await engine.initialize();
    if (ready) {
      log.info("  ✓ Embedding model ready");
      return;
    }
    log.warn("  ✗ Failed to download/initialize embedding model");
  } finally {
    await engine.dispose();
  }
}

async function downloadLlmModel(modelUri: string, contextSize: number, cacheDir: string, modelsConfig: ModelsConfig): Promise<void> {
  const engine = new LlmEngine({
    modelUri,
    cacheDir,
    gpu: modelsConfig.gpu,
    threads: modelsConfig.threads,
    contextSize,
    downloadOnFirstUse: true,
  });

  try {
    log.info(`Downloading LLM model: ${modelUri}`);
    const ready = await engine.initialize();
    if (ready) {
      log.info("  ✓ LLM model ready");
      return;
    }
    log.warn("  ✗ Failed to download/initialize LLM model");
  } finally {
    await engine.dispose();
  }
}

async function downloadAction(context: CliContext): Promise<void> {
  const { config, cacheDir } = context;
  const embeddings = config.build.embeddings;
  const communitySummaries = config.build.community_summaries;
  const nodeDescriptions = config.build.node_descriptions;
  let requiredModels = 0;

  log.info(`Downloading configured models to: ${cacheDir}`);

  if (embeddings.enabled && embeddings.method === "onnx") {
    requiredModels += 1;
    await downloadEmbeddingModel(config, cacheDir);
  }

  const communityModel = communitySummaries.enabled ? (communitySummaries.model ?? null) : null;
  const nodeModel = nodeDescriptions.enabled ? (nodeDescriptions.model ?? null) : null;

  if (communityModel) {
    requiredModels += 1;
    await downloadLlmModel(communityModel, communitySummaries.context_size, cacheDir, config.models);
  }

  if (nodeModel && nodeModel !== communityModel) {
    requiredModels += 1;
    await downloadLlmModel(nodeModel, nodeDescriptions.context_size, cacheDir, config.models);
  } else if (nodeModel && communityModel && nodeModel === communityModel) {
    log.info("Skipping node descriptions model download — same model as community_summaries");
  }

  if (requiredModels === 0) {
    log.info("No models required by current configuration.");
  }
}

function removeAction(cacheDir: string, name: string): void {
  // Safety: reject path traversal
  if (name.includes("/") || name.includes("\\") || name.includes("..") || name.startsWith(".")) {
    throw new Error(`Invalid model name: "${name}". Use the model name as shown by 'reponova models status'.`);
  }

  const onnxDir = join(cacheDir, name);
  const onnxModelPath = join(onnxDir, "model.onnx");
  if (existsSync(onnxModelPath)) {
    const freedBytes = getDirSize(onnxDir);
    rmSync(onnxDir, { recursive: true, force: true });
    console.log(`✓ Removed model "${name}" (${formatSize(freedBytes)} freed).`);
    return;
  }

  const llmModel = getCachedLlmModels(cacheDir).find((model) => model.name === name);
  if (llmModel) {
    rmSync(llmModel.path, { force: true });
    console.log(`✓ Removed model "${name}" (${formatSize(llmModel.sizeBytes)} freed).`);
    return;
  }

  throw new Error(`Model "${name}" not found. Run 'reponova models status' to see cached models.`);
}

function clearAction(cacheDir: string): void {
  if (!existsSync(cacheDir)) {
    console.log("No model cache found. Nothing to clear.");
    return;
  }

  const totalSize = getDirSize(cacheDir);
  console.log(`Removing model cache (${formatSize(totalSize)})...`);
  rmSync(cacheDir, { recursive: true, force: true });
  console.log(`✓ Model cache cleared (${formatSize(totalSize)} freed).`);
}

export const modelsCommand: CommandModule = {
  command: "models <action> [name]",
  describe: "Manage downloaded AI models",
  builder: (yargs) =>
    yargs
      .positional("action", {
        type: "string",
        choices: ["status", "download", "remove", "clear"] as const,
        describe: "Action: status, download, remove, or clear",
      })
      .positional("name", {
        type: "string",
        describe: "Model name (required for remove)",
      })
      .option("config", {
        type: "string",
        describe: "Path to reponova.yml",
      })
      .option("cache-dir", {
        type: "string",
        describe: "Override model cache directory",
      }),
  handler: async (argv) => {
    const action = argv.action as string;
    const name = argv.name as string | undefined;
    const configPath = argv.config as string | undefined;
    const cacheDirOverride = argv["cache-dir"] as string | undefined;

    try {
      const context = loadCliContext(configPath, cacheDirOverride);

      switch (action) {
        case "status":
          await statusAction(context);
          break;
        case "download":
          await downloadAction(context);
          break;
        case "remove":
          if (!name) throw new Error("Model name is required for 'remove'.");
          removeAction(context.cacheDir, name);
          break;
        case "clear":
          clearAction(context.cacheDir);
          break;
        default:
          throw new Error(`Unknown action: ${action}. Use: status, download, remove, or clear`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    }
  },
};
