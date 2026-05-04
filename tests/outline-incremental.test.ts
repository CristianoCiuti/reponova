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

describe("multi-repo outline pattern matching", () => {
  it("matches workspace-relative patterns (repoName/path/**) in multi-repo mode", async () => {
    const { config, configDir, outputDir } = setupMultiRepo();
    // Pattern: "backend/lib/**" — should match files in backend repo only
    config.outlines.patterns = ["backend/lib/**"];

    const count = await runOutlineGeneration(config, configDir, outputDir, { force: false });
    const hashes = loadOutlineHashes(outputDir);

    expect(count).toBe(1);
    expect(hashes.has("backend/lib/core.py")).toBe(true);
    expect(hashes.has("frontend/src/app.py")).toBe(false);
    expect(existsSync(join(outputDir, "outlines", "backend", "lib", "core.py.outline.json"))).toBe(true);
    expect(existsSync(join(outputDir, "outlines", "frontend", "src", "app.py.outline.json"))).toBe(false);
  });

  it("matches repo-relative patterns (no prefix) across all repos in multi-repo mode", async () => {
    const { config, configDir, outputDir } = setupMultiRepo();
    // Pattern: "src/**/*.py" — should match in both repos
    config.outlines.patterns = ["src/**/*.py"];

    const count = await runOutlineGeneration(config, configDir, outputDir, { force: false });
    const hashes = loadOutlineHashes(outputDir);

    expect(count).toBe(1); // only frontend has src/
    expect(hashes.has("frontend/src/app.py")).toBe(true);
    expect(hashes.has("backend/lib/core.py")).toBe(false); // lib/ not src/
  });

  it("matches both workspace-relative and repo-relative in same pattern list", async () => {
    const { config, configDir, outputDir } = setupMultiRepo();
    // Mixed: one workspace-relative, one repo-relative
    config.outlines.patterns = ["backend/lib/**", "src/**/*.py"];

    const count = await runOutlineGeneration(config, configDir, outputDir, { force: false });
    const hashes = loadOutlineHashes(outputDir);

    expect(count).toBe(2);
    expect(hashes.has("backend/lib/core.py")).toBe(true);
    expect(hashes.has("frontend/src/app.py")).toBe(true);
  });

  it("workspace-relative exclude works in multi-repo mode", async () => {
    const { config, configDir, outputDir } = setupMultiRepo();
    config.outlines.patterns = ["**/*.py"];
    config.outlines.exclude = ["backend/**"]; // exclude entire backend repo

    const count = await runOutlineGeneration(config, configDir, outputDir, { force: false });
    const hashes = loadOutlineHashes(outputDir);

    expect(hashes.has("backend/lib/core.py")).toBe(false);
    expect(hashes.has("frontend/src/app.py")).toBe(true);
    expect(count).toBe(1);
  });
});

describe("stale outline cleanup", () => {
  it("removes outlines for files that no longer match patterns", async () => {
    const { config, configDir, outputDir } = setupMultiRepo();

    // First run: outline everything
    config.outlines.patterns = ["**/*.py"];
    await runOutlineGeneration(config, configDir, outputDir, { force: false });
    expect(existsSync(join(outputDir, "outlines", "backend", "lib", "core.py.outline.json"))).toBe(true);
    expect(existsSync(join(outputDir, "outlines", "frontend", "src", "app.py.outline.json"))).toBe(true);

    // Second run: narrow patterns — backend files should be cleaned up
    config.outlines.patterns = ["frontend/**"];
    const count = await runOutlineGeneration(config, configDir, outputDir, { force: false });

    expect(existsSync(join(outputDir, "outlines", "backend", "lib", "core.py.outline.json"))).toBe(false);
    expect(existsSync(join(outputDir, "outlines", "frontend", "src", "app.py.outline.json"))).toBe(true);
    // count is 0 because frontend/src/app.py hash didn't change
    expect(count).toBe(0);
  });

  it("removes outlines when patterns change to match nothing", async () => {
    const { config, configDir, outputDir } = setupProject();

    await runOutlineGeneration(config, configDir, outputDir, { force: false });
    expect(existsSync(join(outputDir, "outlines", "src", "example.py.outline.json"))).toBe(true);

    // Change patterns to match nothing — stale outline should be cleaned up
    config.outlines.patterns = ["nonexistent/**"];
    await runOutlineGeneration(config, configDir, outputDir, { force: false });

    expect(existsSync(join(outputDir, "outlines", "src", "example.py.outline.json"))).toBe(false);
    expect(loadOutlineHashes(outputDir).size).toBe(0);
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

function setupMultiRepo(): {
  config: Config;
  configDir: string;
  outputDir: string;
} {
  const root = join(tmpdir(), `rn-test-multi-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(root);

  const configDir = join(root, "config");
  const backendDir = join(root, "backend");
  const frontendDir = join(root, "frontend");
  const outputDir = join(root, "out");

  mkdirSync(join(backendDir, "lib"), { recursive: true });
  mkdirSync(join(frontendDir, "src"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  writeFileSync(
    join(backendDir, "lib", "core.py"),
    'def process() -> None:\n    """Process data"""\n    pass\n',
  );
  writeFileSync(
    join(frontendDir, "src", "app.py"),
    'def render() -> str:\n    """Render app"""\n    return "ok"\n',
  );

  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
  config.repos = [
    { name: "backend", path: "../backend" },
    { name: "frontend", path: "../frontend" },
  ];
  config.outlines.enabled = true;
  config.outlines.patterns = ["**/*.py"];
  config.outlines.exclude = [];

  return { config, configDir, outputDir };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
