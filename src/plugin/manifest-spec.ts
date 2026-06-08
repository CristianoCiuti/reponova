/**
 * Canonical spec for a reponova language plugin's npm manifest.
 *
 * This file is the SINGLE SOURCE OF TRUTH for the strings used to identify,
 * discover, and validate language plugins on npm and on disk. Every consumer
 * — `installed-check`, `discovery`, `registry-client`, tests, and the
 * `bootstrap-plugin` scaffold in `reponova-langs` — imports from here so
 * renames stay surgical.
 *
 * A package is a valid reponova language plugin when ALL of these hold:
 *
 *  1. `package.json.reponova.type === PLUGIN_TYPE_LANGUAGE`
 *  2. `package.json.reponova.extensions` is a non-empty `string[]`
 *  3. Entry point exports a `LanguagePlugin` object with `id` and `extractor`
 *
 * Additionally, to be discoverable via `reponova lang suggest`:
 *
 *  4. `package.json.keywords` includes `KEYWORD_LANGUAGE`
 *
 * Packages under `OFFICIAL_SCOPE_PREFIX` are ranked first in suggestions but
 * receive NO discovery bypass — the keyword above is required even for them.
 *
 * Note on `extensions`: this used to live BOTH on the `LanguagePlugin` runtime
 * export AND in the manifest. As of v0.5 the manifest is authoritative; the
 * runtime interface no longer carries `extensions`. This eliminates silent
 * drift between npm-visible metadata and the actual loader behavior.
 */

/** Value of `package.json.reponova.type` for language plugins. */
export const PLUGIN_TYPE_LANGUAGE = "language";

/** Official npm scope prefix. Anything under `@reponova/lang-*` is "official". */
export const OFFICIAL_SCOPE_PREFIX = "@reponova/lang-";

/**
 * Required npm keyword for a language plugin to be returned by
 * `reponova lang suggest`. Single canonical token — no aliases, no legacy.
 */
export const KEYWORD_LANGUAGE = "reponova-language";
