import { execSync } from "node:child_process";

/**
 * Detect installed graphify version.
 * Tries `graphify --version` first, then `python -m graphify --version`.
 * Returns semver string or null if not found.
 */
export function checkGraphify(): string | null {
  try {
    const output = execSync("graphify --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1]! : output.trim();
  } catch {
    try {
      const output = execSync("python -m graphify --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      const match = output.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1]! : output.trim();
    } catch {
      return null;
    }
  }
}

/**
 * Detect installed Python version.
 * Tries `python --version` first, then `python3 --version`.
 * Returns version string (e.g. "3.11.4") or null if not found.
 */
export function checkPython(): string | null {
  try {
    const output = execSync("python --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return output.trim().replace("Python ", "");
  } catch {
    try {
      const output = execSync("python3 --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      return output.trim().replace("Python ", "");
    } catch {
      return null;
    }
  }
}
