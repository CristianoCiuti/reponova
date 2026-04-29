import { execSync } from "node:child_process";

/**
 * Detect installed graphify version.
 * The PyPI package is "graphifyy" (two y's). There is no --version flag.
 * Uses importlib.metadata to check the installed package version.
 */
export function checkGraphify(): string | null {
  const script = "from importlib.metadata import version; print(version('graphifyy'))";

  for (const bin of ["python3", "python"]) {
    try {
      const output = execSync(`${bin} -c "${script}"`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const trimmed = output.trim();
      if (trimmed && /^\d+\.\d+/.test(trimmed)) {
        return trimmed;
      }
    } catch {
      // try next binary
    }
  }

  return null;
}

/**
 * Detect installed Python version.
 * Tries `python3 --version` first, then `python --version`.
 * Returns version string (e.g. "3.11.4") or null if not found.
 */
export function checkPython(): string | null {
  for (const bin of ["python3", "python"]) {
    try {
      const output = execSync(`${bin} --version`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return output.trim().replace("Python ", "");
    } catch {
      // try next binary
    }
  }
  return null;
}
