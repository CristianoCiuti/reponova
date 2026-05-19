import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CacheContract } from "../contract.js";
import { allFilesExist, dirExistsAndNonEmpty, hashFile, hashObject, readHashFile, writeHashFile } from "../utils.js";

const INPUT_FILE = "detected-files.json";
const OUTPUT_DIR = "outlines";
const INPUT_HASH_FILE = "outlines-input-hash.txt";
const CONFIG_HASH_FILE = "outlines-config-hash.txt";

export const outlinesContract: CacheContract = {
  phaseId: "outlines",
  check(ctx) {
    const inputPath = join(ctx.outputDir, INPUT_FILE);
    const outputPath = join(ctx.outputDir, OUTPUT_DIR);
    const inputHashPath = join(ctx.cacheDir, INPUT_HASH_FILE);
    const configHashPath = join(ctx.cacheDir, CONFIG_HASH_FILE);

    if (!existsSync(inputPath)) {
      return { fresh: false, reason: "input file missing" };
    }

    if (!dirExistsAndNonEmpty(outputPath) || !allFilesExist([inputHashPath, configHashPath])) {
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

function getConfigHash(config: { outlines: { enabled: boolean } }): string {
  return hashObject({ enabled: config.outlines.enabled });
}

function removeIfExists(filePath: string): void {
  if (existsSync(filePath)) unlinkSync(filePath);
}
