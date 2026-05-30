/**
 * E2E tests for CLI startup performance.
 *
 * Verifies that the lazy-import refactor keeps CLI startup fast
 * by measuring the time to execute trivial commands.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const CLI_PATH = resolve(__dirname, "../dist/cli/index.js");

function measureMs(command: string, allowFailure = false): number {
  const start = performance.now();
  try {
    execSync(command, { stdio: "pipe" });
  } catch {
    if (!allowFailure) throw new Error(`Command failed: ${command}`);
  }
  return performance.now() - start;
}

describe("CLI startup performance", () => {
  it("--version responds in under 1000ms", () => {
    // Warm run first (JIT, filesystem cache)
    measureMs(`node "${CLI_PATH}" --version`);
    // Measured run — threshold is generous to avoid flakiness under CI/parallel load
    const ms = measureMs(`node "${CLI_PATH}" --version`);
    expect(ms).toBeLessThan(1000);
  });

  it("--help responds in under 1000ms", () => {
    measureMs(`node "${CLI_PATH}" --help`);
    const ms = measureMs(`node "${CLI_PATH}" --help`);
    expect(ms).toBeLessThan(1000);
  });

  it("check responds in under 1000ms", () => {
    measureMs(`node "${CLI_PATH}" check`, true);
    // check loads a few more modules (graph-resolver, build-config-metadata)
    // exits non-zero when no graph found — that's fine, we measure startup time
    const ms = measureMs(`node "${CLI_PATH}" check`, true);
    expect(ms).toBeLessThan(1000);
  });

  it("--version does not load heavy dependencies (bundle size check)", () => {
    // The CLI entry point should be small (< 20KB) — heavy deps are in chunks
    const { statSync } = require("node:fs");
    const stats = statSync(CLI_PATH);
    expect(stats.size).toBeLessThan(20 * 1024); // < 20KB
  });
});
