/**
 * Tests for `src/plugin/registry-client.ts`.
 *
 * We stub `globalThis.fetch` to return canned npm-registry responses,
 * exercising the search → manifest → extension-index pipeline without
 * making real network calls. Tests are deterministic and offline-safe.
 *
 * Discovery model (post-v0.5): one keyword (`reponova-language`) is the
 * single source of truth for what's a language plugin on npm. The
 * `@reponova/lang-*` scope is just a ranking signal — packages under it
 * still need the keyword to be discovered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  discoverPluginsOnRegistry,
  indexByExtension,
  type PluginCandidate,
} from "../src/plugin/registry-client.js";

interface FetchStub {
  /** Maps URL substrings to a JSON body. The first matching substring wins. */
  routes: { match: string; body: unknown; status?: number }[];
}

function installFetchStub(stub: FetchStub): void {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const rawUrl = typeof input === "string" ? input : (input as URL).toString();
    // Decode so test matchers can use readable substrings like
    // "@reponova/lang-python/latest" even though the real URL has `%40`.
    const url = decodeURIComponent(rawUrl);
    const hit = stub.routes.find((r) => url.includes(r.match));
    if (!hit) {
      return new Response(JSON.stringify({}), { status: 404 });
    }
    return new Response(JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", mock);
}

describe("discoverPluginsOnRegistry", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies @reponova/lang-* hits as official; everything else as community", async () => {
    installFetchStub({
      routes: [
        // Single keyword search returns both official and community plugins.
        {
          match: "text=keywords:reponova-language",
          body: {
            objects: [
              { package: { name: "@reponova/lang-python" } },
              { package: { name: "@community/lang-elixir" } },
            ],
          },
        },
        // Manifests
        {
          match: "@reponova/lang-python/latest",
          body: {
            name: "@reponova/lang-python",
            version: "0.3.0",
            description: "Python support",
            reponova: { type: "language", extensions: [".py", ".pyw"] },
          },
        },
        {
          match: "@community/lang-elixir/latest",
          body: {
            name: "@community/lang-elixir",
            version: "0.0.5",
            description: "Elixir support",
            reponova: { type: "language", extensions: [".ex", ".exs"] },
          },
        },
      ],
    });

    const result = await discoverPluginsOnRegistry();
    expect(result).toHaveLength(2);
    // Official ranked first
    expect(result[0]?.name).toBe("@reponova/lang-python");
    expect(result[0]?.isOfficial).toBe(true);
    expect(result[0]?.extensions).toEqual([".py", ".pyw"]);
    // Community second
    expect(result[1]?.name).toBe("@community/lang-elixir");
    expect(result[1]?.isOfficial).toBe(false);
  });

  it("does NOT discover packages that lack the `reponova-language` keyword", async () => {
    // No keyword hits → no candidates, even if some real plugin is published.
    installFetchStub({
      routes: [
        { match: "text=keywords:reponova-language", body: { objects: [] } },
      ],
    });

    const result = await discoverPluginsOnRegistry();
    expect(result).toEqual([]);
  });

  it("dedupes duplicate hits in the search result", async () => {
    installFetchStub({
      routes: [
        {
          match: "text=keywords:reponova-language",
          body: {
            objects: [
              { package: { name: "@reponova/lang-python" } },
              { package: { name: "@reponova/lang-python" } }, // dup
            ],
          },
        },
        {
          match: "@reponova/lang-python/latest",
          body: {
            name: "@reponova/lang-python",
            version: "0.3.0",
            reponova: { type: "language", extensions: [".py"] },
          },
        },
      ],
    });

    const result = await discoverPluginsOnRegistry();
    expect(result.map((c) => c.name)).toEqual(["@reponova/lang-python"]);
  });

  it("skips packages whose manifest is not a language plugin", async () => {
    installFetchStub({
      routes: [
        {
          match: "text=keywords:reponova-language",
          body: {
            objects: [
              { package: { name: "@reponova/lang-python" } },
              { package: { name: "@reponova/lang-noop" } },
            ],
          },
        },
        {
          match: "@reponova/lang-python/latest",
          body: {
            name: "@reponova/lang-python",
            version: "0.3.0",
            reponova: { type: "language", extensions: [".py"] },
          },
        },
        {
          match: "@reponova/lang-noop/latest",
          body: { name: "@reponova/lang-noop", version: "1.0.0" }, // no reponova metadata
        },
      ],
    });

    const result = await discoverPluginsOnRegistry();
    expect(result.map((c) => c.name)).toEqual(["@reponova/lang-python"]);
  });

  it("returns empty array when the registry is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND"); }));
    const result = await discoverPluginsOnRegistry();
    expect(result).toEqual([]);
  });

  it("skips candidates that declare no extensions", async () => {
    installFetchStub({
      routes: [
        {
          match: "text=keywords:reponova-language",
          body: { objects: [{ package: { name: "@reponova/lang-empty" } }] },
        },
        {
          match: "@reponova/lang-empty/latest",
          body: {
            name: "@reponova/lang-empty",
            version: "0.0.1",
            reponova: { type: "language", extensions: [] },
          },
        },
      ],
    });

    const result = await discoverPluginsOnRegistry();
    expect(result).toEqual([]);
  });
});

describe("indexByExtension", () => {
  const official: PluginCandidate = {
    name: "@reponova/lang-typescript",
    version: "1.0.0",
    description: "",
    extensions: [".ts", ".tsx"],
    isOfficial: true,
  };
  const community: PluginCandidate = {
    name: "@community/lang-ts-alt",
    version: "0.0.1",
    description: "",
    extensions: [".ts"],
    isOfficial: false,
  };

  it("favours official plugins over community when extensions clash", () => {
    const map = indexByExtension([community, official]);
    expect(map.get(".ts")).toEqual(official);
    expect(map.get(".tsx")).toEqual(official);
  });

  it("keeps first-encountered when both candidates have the same isOfficial flag", () => {
    const other: PluginCandidate = { ...official, name: "@reponova/lang-typescript-fork" };
    const map = indexByExtension([official, other]);
    expect(map.get(".ts")?.name).toBe(official.name);
  });
});
