/**
 * Tests for `src/plugin/installed-check.ts`.
 *
 * Builds tiny fake `node_modules/<pkg>/` layouts so we can exercise
 * every branch of the "is the plugin actually usable?" decision.
 *
 * We import the plugin entry via `pathToFileURL` so the test files
 * need to be valid ESM that Node can `import()`. We use `.mjs` to
 * avoid TypeScript transform issues on inline-written files.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkPluginStatus,
  describeNotInstalled,
  isPluginInstalled,
} from "../src/plugin/installed-check.js";

function writePackage(
  nmDir: string,
  packageName: string,
  pkgJson: Record<string, unknown>,
  entry?: { file: string; contents: string },
): void {
  const pkgDir = join(nmDir, ...packageName.split("/"));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkgJson), "utf-8");
  if (entry) {
    const entryPath = join(pkgDir, entry.file);
    mkdirSync(join(entryPath, ".."), { recursive: true });
    writeFileSync(entryPath, entry.contents, "utf-8");
  }
}

describe("checkPluginStatus", () => {
  let tmp: string;
  let nm: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rn-check-"));
    nm = join(tmp, "node_modules");
    mkdirSync(nm, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reports `missing` when the package isn't in node_modules", async () => {
    const status = await checkPluginStatus("@scope/not-installed", nm);
    expect(status.kind).toBe("not-installed");
    if (status.kind === "not-installed") {
      expect(status.reason).toBe("missing");
    }
  });

  it("reports `not-a-language-plugin` when reponova.type !== 'language'", async () => {
    writePackage(nm, "@scope/random-pkg", {
      name: "@scope/random-pkg",
      version: "1.0.0",
      reponova: { type: "something-else", extensions: [".x"] },
    });
    const status = await checkPluginStatus("@scope/random-pkg", nm);
    expect(status.kind).toBe("not-installed");
    if (status.kind === "not-installed") {
      expect(status.reason).toBe("not-a-language-plugin");
    }
  });

  it("reports `missing-extensions` when reponova.type is language but extensions are absent/empty", async () => {
    writePackage(nm, "@scope/no-ext", {
      name: "@scope/no-ext",
      version: "1.0.0",
      reponova: { type: "language" },
    });
    const status = await checkPluginStatus("@scope/no-ext", nm);
    expect(status.kind).toBe("not-installed");
    if (status.kind === "not-installed") {
      expect(status.reason).toBe("missing-extensions");
    }

    writePackage(nm, "@scope/empty-ext", {
      name: "@scope/empty-ext",
      version: "1.0.0",
      reponova: { type: "language", extensions: [] },
    });
    const status2 = await checkPluginStatus("@scope/empty-ext", nm);
    expect(status2.kind).toBe("not-installed");
    if (status2.kind === "not-installed") {
      expect(status2.reason).toBe("missing-extensions");
    }
  });

  it("reports `invalid-export` when the module loads but isn't a LanguagePlugin", async () => {
    writePackage(
      nm,
      "@scope/bad-plugin",
      {
        name: "@scope/bad-plugin",
        version: "0.1.0",
        type: "module",
        reponova: { type: "language", extensions: [".bp"] },
        exports: { ".": "./dist/index.mjs" },
      },
      { file: "dist/index.mjs", contents: "export const plugin = { id: null };\n" },
    );
    const status = await checkPluginStatus("@scope/bad-plugin", nm);
    expect(status.kind).toBe("not-installed");
    if (status.kind === "not-installed") {
      expect(status.reason).toBe("invalid-export");
    }
  });

  it("reports `loaded` with version, plugin, and extensions (from manifest)", async () => {
    writePackage(
      nm,
      "@scope/good-plugin",
      {
        name: "@scope/good-plugin",
        version: "1.2.3",
        type: "module",
        reponova: { type: "language", extensions: [".gd", ".gdx"] },
        exports: { ".": "./dist/index.mjs" },
      },
      {
        file: "dist/index.mjs",
        contents:
          "export const plugin = { id: 'good', extractor: { extract: () => ({}) } };\n",
      },
    );
    const status = await checkPluginStatus("@scope/good-plugin", nm);
    expect(status.kind).toBe("loaded");
    if (status.kind === "loaded") {
      expect(status.version).toBe("1.2.3");
      expect(status.plugin.id).toBe("good");
      // Extensions come from the manifest, never from the imported module.
      expect(status.extensions).toEqual([".gd", ".gdx"]);
    }
  });

  it("normalizes extensions in the manifest (lowercase + leading dot)", async () => {
    writePackage(
      nm,
      "@scope/upper-no-dot",
      {
        name: "@scope/upper-no-dot",
        version: "0.0.1",
        type: "module",
        reponova: { type: "language", extensions: ["PY", ".Pyw"] },
        exports: { ".": "./dist/index.mjs" },
      },
      {
        file: "dist/index.mjs",
        contents:
          "export const plugin = { id: 'pyish', extractor: { extract: () => ({}) } };\n",
      },
    );
    const status = await checkPluginStatus("@scope/upper-no-dot", nm);
    expect(status.kind).toBe("loaded");
    if (status.kind === "loaded") {
      expect(status.extensions).toEqual([".py", ".pyw"]);
    }
  });

  it("reports `import-failed` when the entry file throws", async () => {
    writePackage(
      nm,
      "@scope/broken-plugin",
      {
        name: "@scope/broken-plugin",
        version: "0.0.1",
        type: "module",
        reponova: { type: "language", extensions: [".bk"] },
        exports: { ".": "./dist/index.mjs" },
      },
      { file: "dist/index.mjs", contents: "throw new Error('boom');\n" },
    );
    const status = await checkPluginStatus("@scope/broken-plugin", nm);
    expect(status.kind).toBe("not-installed");
    if (status.kind === "not-installed") {
      expect(status.reason).toBe("import-failed");
    }
  });
});

describe("isPluginInstalled", () => {
  let tmp: string;
  let nm: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rn-check-"));
    nm = join(tmp, "node_modules");
    mkdirSync(nm, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns false for missing packages", async () => {
    expect(await isPluginInstalled("@x/missing", nm)).toBe(false);
  });

  it("returns true for valid plugins", async () => {
    writePackage(
      nm,
      "@x/yes",
      {
        name: "@x/yes",
        version: "0.0.1",
        type: "module",
        reponova: { type: "language", extensions: [".y"] },
        exports: { ".": "./dist/index.mjs" },
      },
      {
        file: "dist/index.mjs",
        contents: "export const plugin = { id: 'yes', extractor: { extract: () => ({}) } };\n",
      },
    );
    expect(await isPluginInstalled("@x/yes", nm)).toBe(true);
  });
});

describe("describeNotInstalled", () => {
  it("renders human-readable hints for each reason", () => {
    expect(describeNotInstalled("missing", "@a/b")).toContain("reponova lang add @a/b");
    expect(describeNotInstalled("not-a-language-plugin", "@a/b")).toContain("reponova.type");
    expect(describeNotInstalled("missing-extensions", "@a/b")).toContain("reponova.extensions");
    expect(describeNotInstalled("import-failed", "@a/b")).toContain("reponova lang add @a/b");
    expect(describeNotInstalled("invalid-export", "@a/b")).toContain("LanguagePlugin");
  });
});
