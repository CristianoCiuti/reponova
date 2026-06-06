/**
 * Tests for the install-context detection logic.
 *
 * We build small filesystem fixtures and pass them via the
 * `reponovaDirHint` parameter, so we can exercise every branch of
 * `detectInstallContext` without actually installing anything.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, sep, dirname } from "node:path";
import { tmpdir, platform } from "node:os";
import {
  detectInstallContext,
  detectPackageManager,
  buildInstallCommand,
  buildUninstallCommand,
} from "../src/plugin/install-context.js";

/** Create a fake reponova package layout: <root>/<relPath>/reponova/package.json */
function makeReponovaTree(root: string, relPath: string[]): string {
  const full = join(root, ...relPath, "reponova");
  mkdirSync(full, { recursive: true });
  writeFileSync(
    join(full, "package.json"),
    JSON.stringify({ name: "reponova", version: "0.0.0-test" }),
    "utf-8",
  );
  return full;
}

function writeProjectPackage(
  dir: string,
  content: Record<string, unknown>,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(content), "utf-8");
}

describe("detectInstallContext", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rn-ctx-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("aborts when reponova lives inside an _npx cache", () => {
    const dir = makeReponovaTree(tmp, ["_npx", "abc123", "node_modules"]);
    const ctx = detectInstallContext(dir);
    expect(ctx.kind).toBe("abort");
    if (ctx.kind === "abort") {
      expect(ctx.reason).toMatch(/npx/i);
      expect(ctx.hint).toMatch(/lang add/);
    }
  });

  it("returns linked for a non-installed dev tree", () => {
    // reponova/package.json at root, no node_modules ancestor
    const dir = makeReponovaTree(tmp, []);
    const ctx = detectInstallContext(dir);
    expect(ctx.kind).toBe("linked");
  });

  it("returns local + pnpm for a project with pnpm-lock.yaml", () => {
    writeProjectPackage(join(tmp, "my-app"), {
      name: "my-app",
      dependencies: { reponova: "*" },
    });
    writeFileSync(join(tmp, "my-app", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf-8");

    const dir = makeReponovaTree(tmp, ["my-app", "node_modules"]);
    const ctx = detectInstallContext(dir);
    expect(ctx.kind).toBe("local");
    if (ctx.kind === "local") {
      expect(ctx.packageManager).toBe("pnpm");
      expect(ctx.projectRoot.endsWith(`${sep}my-app`)).toBe(true);
    }
  });

  it("returns local + yarn for a project with yarn.lock", () => {
    writeProjectPackage(join(tmp, "my-app"), {
      name: "my-app",
      devDependencies: { reponova: "*" },
    });
    writeFileSync(join(tmp, "my-app", "yarn.lock"), "# yarn lockfile v1\n", "utf-8");

    const dir = makeReponovaTree(tmp, ["my-app", "node_modules"]);
    const ctx = detectInstallContext(dir);
    expect(ctx.kind).toBe("local");
    if (ctx.kind === "local") {
      expect(ctx.packageManager).toBe("yarn");
    }
  });

  it("returns local + bun for a project with bun.lockb", () => {
    writeProjectPackage(join(tmp, "my-app"), {
      name: "my-app",
      dependencies: { reponova: "*" },
    });
    writeFileSync(join(tmp, "my-app", "bun.lockb"), "", "utf-8");

    const dir = makeReponovaTree(tmp, ["my-app", "node_modules"]);
    const ctx = detectInstallContext(dir);
    expect(ctx.kind).toBe("local");
    if (ctx.kind === "local") {
      expect(ctx.packageManager).toBe("bun");
    }
  });

  it("defaults to npm when no lockfile is present", () => {
    writeProjectPackage(join(tmp, "my-app"), {
      name: "my-app",
      dependencies: { reponova: "*" },
    });

    const dir = makeReponovaTree(tmp, ["my-app", "node_modules"]);
    const ctx = detectInstallContext(dir);
    expect(ctx.kind).toBe("local");
    if (ctx.kind === "local") {
      expect(ctx.packageManager).toBe("npm");
    }
  });

  it("prefers `packageManager` field over a conflicting lockfile", () => {
    // The presence of bun.lockb would normally win, but `packageManager` field
    // is the official source of truth (Corepack contract) and must take
    // precedence.
    writeProjectPackage(join(tmp, "my-app"), {
      name: "my-app",
      dependencies: { reponova: "*" },
      packageManager: "pnpm@9.0.0",
    });
    writeFileSync(join(tmp, "my-app", "bun.lockb"), "", "utf-8");

    const dir = makeReponovaTree(tmp, ["my-app", "node_modules"]);
    const ctx = detectInstallContext(dir);
    expect(ctx.kind).toBe("local");
    if (ctx.kind === "local") {
      expect(ctx.packageManager).toBe("pnpm");
    }
  });

  it("ignores empty package.json (no deps / no workspaces / no lockfile)", () => {
    // A bare `{}` package.json near the node_modules ancestor isn't a real
    // consumer project (e.g. a stray file in a temp dir). Detection should
    // fall through to `linked` rather than confidently calling it `local`.
    writeProjectPackage(join(tmp, "stub"), { name: "stub" });
    const dir = makeReponovaTree(tmp, ["stub", "node_modules"]);

    const ctx = detectInstallContext(dir);
    expect(ctx.kind).toBe("linked");
  });

  /**
   * Regression: version managers (fnm, nvm-windows, Volta, asdf, …) install
   * global packages right next to `node.exe`, NOT in `%APPDATA%\npm` /
   * `/usr/local/lib/node_modules`. `global-directory@4` doesn't know these
   * layouts on Windows, so we fall back to a `process.execPath`-derived
   * candidate. This test makes sure the fallback fires.
   */
  it("detects global install when reponova lives next to process.execPath (fnm / Volta / system Node)", () => {
    // Build a layout that matches the platform's `<execPath dir>` convention:
    //   Windows: <install>/node.exe   + <install>/node_modules/reponova
    //   POSIX:   <prefix>/bin/node    + <prefix>/lib/node_modules/reponova
    const isWindows = platform() === "win32";
    const installRoot = join(tmp, "fake-version-manager");
    const fakeNode = isWindows
      ? join(installRoot, "node.exe")
      : join(installRoot, "bin", "node");
    mkdirSync(dirname(fakeNode), { recursive: true });
    writeFileSync(fakeNode, "", "utf-8");

    const reponovaDir = isWindows
      ? makeReponovaTree(installRoot, ["node_modules"])
      : makeReponovaTree(installRoot, ["lib", "node_modules"]);

    const originalDescriptor = Object.getOwnPropertyDescriptor(process, "execPath")!;
    Object.defineProperty(process, "execPath", { value: fakeNode, configurable: true, writable: true });
    try {
      const ctx = detectInstallContext(reponovaDir);
      expect(ctx.kind).toBe("global");
      if (ctx.kind === "global") {
        expect(ctx.packageManager).toBe("npm");
      }
    } finally {
      Object.defineProperty(process, "execPath", originalDescriptor);
    }
  });
});

describe("detectPackageManager", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rn-pm-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("parses packageManager field with version suffix", () => {
    writeProjectPackage(tmp, { name: "x", packageManager: "yarn@3.6.4" });
    expect(detectPackageManager(tmp)).toBe("yarn");
  });

  it("rejects unknown packageManager values and falls back to lockfile", () => {
    writeProjectPackage(tmp, { name: "x", packageManager: "unknown@1.0.0" });
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf-8");
    expect(detectPackageManager(tmp)).toBe("pnpm");
  });

  it("returns npm as last-resort default", () => {
    writeProjectPackage(tmp, { name: "x" });
    expect(detectPackageManager(tmp)).toBe("npm");
  });
});

describe("buildInstallCommand / buildUninstallCommand", () => {
  it("emits PM-correct argv for global installs", () => {
    const cases: Array<{ pm: "npm" | "pnpm" | "yarn" | "bun"; expected: string[] }> = [
      { pm: "npm",  expected: ["npm", "install", "-g", "@reponova/lang-python"] },
      { pm: "pnpm", expected: ["pnpm", "add", "-g", "@reponova/lang-python"] },
      { pm: "yarn", expected: ["yarn", "global", "add", "@reponova/lang-python"] },
      { pm: "bun",  expected: ["bun", "add", "-g", "@reponova/lang-python"] },
    ];

    for (const { pm, expected } of cases) {
      const cmd = buildInstallCommand("@reponova/lang-python", {
        kind: "global",
        packageManager: pm,
        viaDir: "/fake",
      });
      expect(cmd?.argv).toEqual(expected);
      expect(cmd?.cwd).toBeUndefined();
    }
  });

  it("emits PM-correct argv for local installs with cwd = projectRoot", () => {
    const root = "/path/to/project";
    const cases: Array<{ pm: "npm" | "pnpm" | "yarn" | "bun"; expected: string[] }> = [
      { pm: "npm",  expected: ["npm", "install", "@reponova/lang-python"] },
      { pm: "pnpm", expected: ["pnpm", "add", "@reponova/lang-python"] },
      { pm: "yarn", expected: ["yarn", "add", "@reponova/lang-python"] },
      { pm: "bun",  expected: ["bun", "add", "@reponova/lang-python"] },
    ];

    for (const { pm, expected } of cases) {
      const cmd = buildInstallCommand("@reponova/lang-python", {
        kind: "local",
        projectRoot: root,
        packageManager: pm,
      });
      expect(cmd?.argv).toEqual(expected);
      expect(cmd?.cwd).toBe(root);
    }
  });

  it("returns null for linked and abort kinds", () => {
    expect(
      buildInstallCommand("foo", { kind: "linked", reponovaDir: "/dev" }),
    ).toBeNull();
    expect(
      buildInstallCommand("foo", { kind: "abort", reason: "x", hint: "y" }),
    ).toBeNull();
    expect(
      buildUninstallCommand("foo", { kind: "linked", reponovaDir: "/dev" }),
    ).toBeNull();
  });

  it("emits the correct remove argv per PM", () => {
    expect(
      buildUninstallCommand("foo", { kind: "global", packageManager: "pnpm", viaDir: "/fake" })?.argv,
    ).toEqual(["pnpm", "remove", "-g", "foo"]);
    expect(
      buildUninstallCommand("foo", { kind: "local", projectRoot: "/p", packageManager: "yarn" })?.argv,
    ).toEqual(["yarn", "remove", "foo"]);
    expect(
      buildUninstallCommand("foo", { kind: "global", packageManager: "yarn", viaDir: "/fake" })?.argv,
    ).toEqual(["yarn", "global", "remove", "foo"]);
  });
});
