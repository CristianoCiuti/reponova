import { execSync, spawnSync } from "node:child_process";
import { log } from "../shared/utils.js";

export interface GraphifyInfo {
  version: string;
  command: string;
}

/**
 * Verify that graphify is installed and return its command and version.
 *
 * Resolution chain:
 * 1. graphify --version (in PATH via uv/pipx/pip)
 * 2. python -m graphify --version
 * 3. pip show graphifyy (installed but not in PATH)
 * 4. Not found
 *
 * Reference: https://github.com/safishamsi/graphify
 * PyPI package: graphifyy
 */
export function checkGraphify(): GraphifyInfo | null {
  // 1. Try graphify directly
  try {
    const output = execSync("graphify --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const version = extractVersion(output);
    if (version) {
      log.debug(`Found graphify (direct): v${version}`);
      return { version, command: "graphify" };
    }
  } catch {
    // Not in PATH
  }

  // 2. Try python -m graphify
  try {
    const output = execSync("python -m graphify --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const version = extractVersion(output);
    if (version) {
      log.debug(`Found graphify (python -m): v${version}`);
      return { version, command: "python -m graphify" };
    }
  } catch {
    // Not available via python -m
  }

  // 3. Check if pip package exists
  try {
    const output = execSync("pip show graphifyy", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    if (output.includes("Name: graphifyy")) {
      const version = extractVersion(output.split("\n").find((l) => l.startsWith("Version:")) ?? "");
      log.warn("graphifyy is installed but not in PATH. Try: python -m graphify");
      return null;
    }
  } catch {
    // pip show failed
  }

  return null;
}

/**
 * Attempt to install graphify.
 */
export function installGraphify(): boolean {
  log.info("Installing graphifyy...");

  // Try uv first (recommended by Graphify docs)
  const uvResult = spawnSync("uv", ["tool", "install", "graphifyy"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (uvResult.status === 0) {
    log.info("Installed graphifyy via uv");
    return true;
  }

  // Try pipx (isolated install)
  const pipxResult = spawnSync("pipx", ["install", "graphifyy"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (pipxResult.status === 0) {
    log.info("Installed graphifyy via pipx");
    return true;
  }

  // Fall back to pip
  const pipResult = spawnSync("pip", ["install", "graphifyy"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (pipResult.status === 0) {
    log.info("Installed graphifyy via pip");
    return true;
  }

  log.error("Failed to install graphifyy. Please install manually:");
  log.error("  uv tool install graphifyy   (recommended)");
  log.error("  pipx install graphifyy");
  log.error("  pip install graphifyy");
  return false;
}

function extractVersion(text: string): string | null {
  const match = text.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1]! : null;
}
