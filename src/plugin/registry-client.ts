/**
 * Discover language plugins from the public npm registry.
 *
 * Strategy:
 *   1. SEARCH the registry for plugin candidates via two parallel queries:
 *        a. scope: `@reponova/lang-*` (official plugins)
 *        b. keyword: `reponova-language` (community plugins)
 *      Results are merged and de-duplicated by package name, with
 *      official packages taking precedence.
 *
 *   2. For each candidate, FETCH the latest manifest
 *      (`/<name>/latest`) to read the `reponova.extensions[]` field —
 *      the search API doesn't include it.
 *
 * The whole operation is best-effort: any network error degrades to an
 * empty result with a warning logged via `log.warn`, never throws.
 *
 * No caching: this command is invoked at most once or twice per project
 * and freshness is more valuable than the ~1-2s saved.
 */
import { log } from "../shared/utils.js";

/** Public npm registry. Configurable via env for tests / corporate mirrors. */
const REGISTRY = process.env.REPONOVA_NPM_REGISTRY ?? "https://registry.npmjs.org";
/**
 * Keywords searched on the registry. Both are accepted to cover existing
 * community usage (`reponova-plugin`) and the documented convention
 * (`reponova-language`). False positives are filtered later by checking
 * `manifest.reponova.type === "language"`.
 */
const PLUGIN_KEYWORDS = ["reponova-plugin", "reponova-language"] as const;
const OFFICIAL_SCOPE_PREFIX = "@reponova/lang-";
const REQUEST_TIMEOUT_MS = 8000;
const SEARCH_PAGE_SIZE = 100;

/** A plugin discovered on the registry. */
export interface PluginCandidate {
  /** Full package name, e.g. `@reponova/lang-python`. */
  name: string;
  /** Latest published version. */
  version: string;
  /** Short description from package.json. */
  description: string;
  /** File extensions the plugin claims to cover (e.g. `[".py", ".pyw"]`). */
  extensions: string[];
  /** True iff the package lives under the `@reponova/lang-*` scope. */
  isOfficial: boolean;
}

/** Raw shape of an entry in `/-/v1/search` results. We only read a subset. */
interface SearchHit {
  package: {
    name: string;
    version?: string;
    description?: string;
    keywords?: string[];
  };
}

interface SearchResponse {
  objects?: SearchHit[];
}

/** Raw shape of `/<name>/latest`. Only the fields we care about. */
interface ManifestResponse {
  name?: string;
  version?: string;
  description?: string;
  reponova?: {
    type?: string;
    extensions?: string[];
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Discover language plugins on npm. Returns a deduplicated list with
 * official plugins first, then community plugins sorted by name.
 *
 * Always resolves — never throws. Network failures produce a warning and
 * an empty array.
 */
export async function discoverPluginsOnRegistry(): Promise<PluginCandidate[]> {
  const [official, ...communityBatches] = await Promise.all([
    searchOfficial(),
    ...PLUGIN_KEYWORDS.map((kw) => searchByKeyword(kw)),
  ]);

  // Dedupe by name; official entries (encountered first) win over community.
  const byName = new Map<string, { name: string; isOfficial: boolean }>();
  for (const hit of official) byName.set(hit.package.name, { name: hit.package.name, isOfficial: true });
  for (const batch of communityBatches) {
    for (const hit of batch) {
      if (!byName.has(hit.package.name)) {
        byName.set(hit.package.name, { name: hit.package.name, isOfficial: false });
      }
    }
  }

  // Resolve manifests in parallel to populate `extensions[]`.
  const candidates = await Promise.all(
    [...byName.values()].map(async (entry): Promise<PluginCandidate | null> => {
      const manifest = await fetchManifest(entry.name);
      if (!manifest) return null;
      if (manifest.reponova?.type !== "language") return null;
      const exts = Array.isArray(manifest.reponova.extensions)
        ? manifest.reponova.extensions.filter((e): e is string => typeof e === "string")
        : [];
      if (exts.length === 0) return null; // useless for suggestion: skip
      return {
        name: entry.name,
        version: manifest.version ?? "?",
        description: manifest.description ?? "",
        extensions: exts.map(normalizeExtension),
        isOfficial: entry.isOfficial,
      };
    }),
  );

  return candidates
    .filter((c): c is PluginCandidate => c !== null)
    .sort((a, b) => {
      if (a.isOfficial !== b.isOfficial) return a.isOfficial ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Invert a list of candidates into a lookup `extension -> candidate`.
 * When two candidates claim the same extension, the official one wins;
 * ties between two officials (or two community) keep the first encountered.
 */
export function indexByExtension(
  candidates: PluginCandidate[],
): Map<string, PluginCandidate> {
  const map = new Map<string, PluginCandidate>();
  for (const cand of candidates) {
    for (const ext of cand.extensions) {
      const existing = map.get(ext);
      if (!existing) {
        map.set(ext, cand);
      } else if (!existing.isOfficial && cand.isOfficial) {
        map.set(ext, cand);
      }
    }
  }
  return map;
}

// ─── Network primitives ──────────────────────────────────────────────────────

async function searchOfficial(): Promise<SearchHit[]> {
  // The npm registry's `text:` qualifier treats input as a free-form
  // substring against package names. Using the bare `@reponova` scope
  // anchors results to that namespace (~8 results today); we then
  // narrow client-side to the `@reponova/lang-*` prefix to filter out
  // sibling packages like `reponova` itself.
  const hits = await runSearch("@reponova");
  return hits.filter((h) => h.package.name.startsWith(OFFICIAL_SCOPE_PREFIX));
}

async function searchByKeyword(keyword: string): Promise<SearchHit[]> {
  return runSearch(`keywords:${keyword}`);
}

async function runSearch(query: string): Promise<SearchHit[]> {
  const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=${SEARCH_PAGE_SIZE}`;
  const data = await fetchJson<SearchResponse>(url);
  return data?.objects ?? [];
}

async function fetchManifest(packageName: string): Promise<ManifestResponse | null> {
  // npm registry conventionally exposes `<name>/latest` (URL-encoded for scoped names).
  const safeName = packageName
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const url = `${REGISTRY}/${safeName}/latest`;
  return fetchJson<ManifestResponse>(url);
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      log.warn(`Registry request ${url} → HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Registry request ${url} failed: ${msg}`);
    return null;
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Lowercase + leading dot. Tolerates `.py`, `py`, `PY`. */
function normalizeExtension(ext: string): string {
  const lower = ext.trim().toLowerCase();
  return lower.startsWith(".") ? lower : `.${lower}`;
}
