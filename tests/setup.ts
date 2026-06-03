/**
 * Vitest setup — registers language plugins before any test runs.
 *
 * This replaces the old static imports of PythonExtractor and DiagramExtractor
 * which are now provided by external plugins (@reponova/lang-*).
 */
import { discoverLanguagePlugins } from "../src/plugin/discovery.js";

await discoverLanguagePlugins();
