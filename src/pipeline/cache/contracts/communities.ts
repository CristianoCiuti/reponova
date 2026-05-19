import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CacheContract } from "../contract.js";
import { allFilesExist, hashFile, readHashFile, writeHashFile } from "../utils.js";

const INPUT_FILE = "graph-nodes.json";
const OUTPUT_FILE = "graph.json";
const INPUT_HASH_FILE = "communities-input-hash.txt";
const LEGACY_HASH_FILE = "graph-nodes-hash.txt";

export const communitiesContract: CacheContract = {
  phaseId: "communities",
  check(ctx) {
    const inputPath = join(ctx.outputDir, INPUT_FILE);
    const outputPath = join(ctx.outputDir, OUTPUT_FILE);
    const inputHashPath = join(ctx.cacheDir, INPUT_HASH_FILE);

    if (!existsSync(inputPath)) {
      return { fresh: false, reason: "input file missing" };
    }

    if (!allFilesExist([outputPath, inputHashPath])) {
      return { fresh: false, reason: "outputs missing" };
    }

    if (readHashFile(inputHashPath) !== hashFile(inputPath)) {
      return { fresh: false, reason: "input hash mismatch" };
    }

    return { fresh: true, reason: "inputs unchanged" };
  },
  seal(ctx) {
    const inputPath = join(ctx.outputDir, INPUT_FILE);
    if (!existsSync(inputPath)) return;
    removeIfExists(join(ctx.cacheDir, LEGACY_HASH_FILE));
    writeHashFile(join(ctx.cacheDir, INPUT_HASH_FILE), hashFile(inputPath));
  },
  invalidate(ctx) {
    removeIfExists(join(ctx.cacheDir, INPUT_HASH_FILE));
  },
};

function removeIfExists(filePath: string): void {
  if (existsSync(filePath)) unlinkSync(filePath);
}
