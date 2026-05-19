import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CacheContract } from "../contract.js";
import { allFilesExist, hashFile, hashObject, readHashFile, writeHashFile } from "../utils.js";

const INPUT_FILE = "graph-enriched.json";
const OUTPUT_FILES = ["graph.html", "graph_communities.html"];
const INPUT_HASH_FILE = "html-input-hash.txt";
const CONFIG_HASH_FILE = "html-config-hash.txt";

export const htmlContract: CacheContract = {
  phaseId: "html",
  check(ctx) {
    const inputPath = join(ctx.outputDir, INPUT_FILE);
    const outputPaths = OUTPUT_FILES.map((file) => join(ctx.outputDir, file));
    const inputHashPath = join(ctx.cacheDir, INPUT_HASH_FILE);
    const configHashPath = join(ctx.cacheDir, CONFIG_HASH_FILE);

    if (!existsSync(inputPath)) {
      return { fresh: false, reason: "input file missing" };
    }

    if (!allFilesExist([...outputPaths, inputHashPath, configHashPath])) {
      return { fresh: false, reason: "outputs missing" };
    }

    if (readHashFile(inputHashPath) !== hashFile(inputPath)) {
      return { fresh: false, reason: "input hash mismatch" };
    }

    if (readHashFile(configHashPath) !== getConfigHash(ctx.config)) {
      return { fresh: false, reason: "config hash mismatch" };
    }

    return { fresh: true, reason: "inputs unchanged" };
  },
  seal(ctx) {
    const inputPath = join(ctx.outputDir, INPUT_FILE);
    if (!existsSync(inputPath)) return;
    writeHashFile(join(ctx.cacheDir, INPUT_HASH_FILE), hashFile(inputPath));
    writeHashFile(join(ctx.cacheDir, CONFIG_HASH_FILE), getConfigHash(ctx.config));
  },
  invalidate(ctx) {
    removeIfExists(join(ctx.cacheDir, INPUT_HASH_FILE));
    removeIfExists(join(ctx.cacheDir, CONFIG_HASH_FILE));
  },
};

function getConfigHash(config: { html: boolean; html_min_degree?: number }): string {
  return hashObject({
    html: config.html,
    html_min_degree: config.html_min_degree ?? null,
  });
}

function removeIfExists(filePath: string): void {
  if (existsSync(filePath)) unlinkSync(filePath);
}
