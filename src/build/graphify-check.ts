import { execSync } from "node:child_process";
import { log } from "../shared/utils.js";

export interface GraphifyInfo {
  version: string;
  command: string;
}

/**
 * Verify that graphify is installed and return its command and version.
 *
 * graphify does NOT have a --version flag. We check the installed package
 * version via importlib.metadata, then verify the CLI is callable.
 *
 * Resolution:
 * 1. Check package version via Python importlib.metadata
 * 2. Try `graphify merge-graphs --help` (verifies CLI is in PATH)
 * 3. Try `python -m graphify merge-graphs --help` (fallback)
 *
 * Reference: https://github.com/safishamsi/graphify
 * PyPI package: graphifyy
 */
export function checkGraphify(): GraphifyInfo | null {
  // 1. Get version from Python package metadata
  let version: string | null = null;
  try {
    const output = execSync(
      'python -c "from importlib.metadata import version; print(version(\'graphifyy\'))"',
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    version = output.trim();
    if (!version || !version.match(/^\d+\.\d+/)) {
      version = null;
    }
  } catch {
    // Package not installed
  }

  if (!version) {
    return null;
  }

  // 2. Check if `graphify` CLI is in PATH
  try {
    execSync("graphify merge-graphs --help", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    log.debug(`Found graphify (direct): v${version}`);
    return { version, command: "graphify" };
  } catch {
    // Not in PATH directly
  }

  // 3. Try python -m graphify
  try {
    execSync("python -m graphify merge-graphs --help", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    log.debug(`Found graphify (python -m): v${version}`);
    return { version, command: "python -m graphify" };
  } catch {
    // Not available via python -m either
  }

  log.warn(`graphifyy v${version} is installed but CLI is not accessible.`);
  log.warn("Try: uv tool install graphifyy   (or: pipx install graphifyy)");
  return null;
}
