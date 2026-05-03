import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runOutlineGeneration, loadOutlineHashes } from "../src/build/outlines.js";
import type { Config } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("FIX-011v2: outline incremental hashing", () => {
  it("skips outline regeneration when file hash is unchanged", async () => {
    const { config, configDir, outputDir, sourceFile, outlinePath } = setupProject();

    const firstCount = await runOutlineGeneration(config, configDir, outputDir, { force: false });
    const firstMtime = statSync(outlinePath).mtimeMs;

    await delay(20);

    const secondCount = await runOutlineGeneration(config, configDir, outputDir, { force: false });
    const secondMtime = statSync(outlinePath).mtimeMs;

    expect(firstCount).toBe(1);
    expect(secondCount).toBe(0);
    expect(secondMtime).toBe(firstMtime);
    expect(loadOutlineHashes(outputDir).get("src/example.py")).toBeDefined();
    expect(existsSync(join(outputDir, ".cache", "outline-hashes.json"))).toBe(true);
    expect(readFileSync(sourceFile, "utf-8")).toContain("hello");
  });

  it("regenerates outline when file content hash changes", async () => {
    const { config, configDir, outputDir, sourceFile, outlinePath } = setupProject();

    await runOutlineGeneration(config, configDir, outputDir, { force: false });
    const firstMtime = statSync(outlinePath).mtimeMs;
    const firstHash = loadOutlineHashes(outputDir).get("src/example.py");

    await delay(20);
    writeFileSync(sourceFile, 'def hello(name: str) -> str:\n    """Return greeting"""\n    return f"hi {name}"\n');

    const regeneratedCount = await runOutlineGeneration(config, configDir, outputDir, { force: false });
    const secondMtime = statSync(outlinePath).mtimeMs;
    const secondHash = loadOutlineHashes(outputDir).get("src/example.py");
    const outlineJson = JSON.parse(readFileSync(outlinePath, "utf-8")) as {
      functions: Array<{ signature: string }>;
    };

    expect(regeneratedCount).toBe(1);
    expect(secondMtime).toBeGreaterThan(firstMtime);
    expect(secondHash).toBeDefined();
    expect(secondHash).not.toBe(firstHash);
    expect(outlineJson.functions[0]?.signature).toContain("name: str");
  });
});

function setupProject(): {
  config: Config;
  configDir: string;
  outputDir: string;
  sourceFile: string;
  outlinePath: string;
} {
  const root = join(tmpdir(), `rn-test-fix011v2-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(root);

  const configDir = join(root, "config");
  const repoDir = join(root, "repo");
  const outputDir = join(root, "out");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const sourceFile = join(repoDir, "src", "example.py");
  writeFileSync(sourceFile, 'def hello() -> str:\n    """Return greeting"""\n    return "hi"\n');

  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
  config.repos = [{ name: "repo", path: "../repo" }];
  config.outlines.enabled = true;
  config.outlines.patterns = ["src/**/*.py"];
  config.outlines.exclude = [];

  return {
    config,
    configDir,
    outputDir,
    sourceFile,
    outlinePath: join(outputDir, "outlines", "src", "example.py.outline.json"),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
