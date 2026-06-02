# Language Plugin Architecture

## Obiettivo

Estrarre il supporto Python e PlantUML da reponova core in pacchetti npm separati. Reponova diventa un motore con solo markdown built-in; i pacchetti `@reponova/lang-*` forniscono tutto il necessario per ogni altro linguaggio.

## Repository

| Progetto | Path | Pacchetto npm |
|----------|------|---------------|
| Reponova core | `C:\Users\coii\git-personal\reponova` | `reponova` |
| Python plugin | `C:\Users\coii\git-personal\reponova-lang-python` | `@reponova/lang-python` |
| PlantUML plugin | `C:\Users\coii\git-personal\reponova-lang-plantuml` | `@reponova/lang-plantuml` |
| SVG plugin | `C:\Users\coii\git-personal\reponova-lang-svg` | `@reponova/lang-svg` |

---

## User Experience

```bash
# Installazione globale
npm install -g reponova
reponova lang add python
reponova lang add plantuml
reponova lang add svg
reponova build

# Gestione linguaggi
reponova lang list              # mostra linguaggi installati
reponova lang remove svg        # disinstalla un linguaggio

# Installazione locale (progetto)
npm install reponova
npx reponova lang add python
npx reponova build
```

`reponova lang add <name>` installa `@reponova/lang-<name>` nel `node_modules` interno di reponova (sibling del pacchetto stesso). Funziona identicamente sia in installazione globale che locale.

---

## CLI: `reponova lang`

| Comando | Descrizione |
|---------|-------------|
| `reponova lang add <name>` | Installa `@reponova/lang-<name>` nel node_modules di reponova |
| `reponova lang remove <name>` | Disinstalla `@reponova/lang-<name>` |
| `reponova lang list` | Elenca linguaggi installati con versione e extensions |

### `reponova lang add <name>`

1. Risolve il path del proprio `node_modules` (risalendo da `import.meta.url` fino al `package.json` di reponova, poi `../` per arrivare al `node_modules` che contiene reponova)
2. Esegue `npm install @reponova/lang-<name>` in quel `node_modules`
3. Verifica che il plugin sia importabile e abbia la struttura corretta
4. Stampa: `✓ Installed @reponova/lang-python (extensions: .py, .pyw)`

### `reponova lang remove <name>`

1. Stesso path resolution
2. Esegue `npm uninstall @reponova/lang-<name>`
3. Stampa: `✓ Removed @reponova/lang-python`

### `reponova lang list`

```
Installed languages:
  python     .py, .pyw           @reponova/lang-python@1.2.0      tree-sitter ✓
  plantuml   .puml, .plantuml    @reponova/lang-plantuml@1.0.0    regex
  svg        .svg                @reponova/lang-svg@1.0.0         regex

Built-in:
  markdown   .md
```

---

## Stato attuale

### File coinvolti per Python

| File | Ruolo |
|------|-------|
| `src/extract/languages/python.ts` | `LanguageExtractor` — AST parsing, symbol extraction, import resolution |
| `src/outline/languages/python.ts` | `LanguageSupport` — outline generation (tree-sitter + regex fallback) |
| `grammars/tree-sitter-python.wasm` | Grammar WASM binary (~4.2 MB) |
| `src/extract/languages/registry.ts` | Registrazione statica `registerExtractor(new PythonExtractor())` |
| `src/outline/languages/registry.ts` | Registrazione statica `registerOutlineLanguage("python", ["py", "pyw"], python)` |

### Interfacce già esportate da reponova

```typescript
// Da src/extract/types.ts
export interface LanguageExtractor {
  readonly languageId: string;
  readonly extensions: string[];
  readonly wasmFile?: string;
  extract(tree: SyntaxTree | null, sourceCode: string, filePath: string): FileExtraction;
  resolveImportPath(importModule: string, currentFilePath: string): string[];
}

// Da src/outline/languages/types.ts
export interface LanguageSupport {
  readonly wasmFile: string;
  treeSitterExtract(rootNode: SyntaxNode, filePath: string, lineCount: number): FileOutline;
  regexExtract(filePath: string, source: string, lineCount: number): FileOutline;
}

// Già in src/index.ts:
export { registerExtractor } from "./extract/languages/registry.js";
export { registerOutlineLanguage } from "./outline/languages/registry.js";
export type { LanguageExtractor } from "./extract/types.js";
export type { LanguageSupport } from "./outline/languages/types.js";
```

### Meccanismo di registrazione attuale

Statico, a import-time nei registry:
```typescript
// extract/languages/registry.ts
import { PythonExtractor } from "./python.js";
registerExtractor(new PythonExtractor());

// outline/languages/registry.ts
import { python } from "./python.js";
registerOutlineLanguage("python", ["py", "pyw"], python);
```

---

## Struttura del pacchetto `@reponova/lang-python`

```
@reponova/lang-python/
├── package.json
├── src/
│   ├── index.ts          # Entry point — esporta LanguagePlugin
│   ├── extractor.ts      # Copia di src/extract/languages/python.ts
│   └── outline.ts        # Copia di src/outline/languages/python.ts
├── grammars/
│   └── tree-sitter-python.wasm
└── tsconfig.json
```

### `package.json`

```json
{
  "name": "@reponova/lang-python",
  "version": "1.0.0",
  "description": "Python language support for RepoNova",
  "type": "module",
  "exports": {
    ".": "./dist/index.js"
  },
  "files": ["dist", "grammars"],
  "peerDependencies": {
    "reponova": "^0.x"
  },
  "reponova": {
    "type": "language",
    "id": "python",
    "extensions": [".py", ".pyw"],
    "grammar": "./grammars/tree-sitter-python.wasm"
  }
}
```

### `src/index.ts`

```typescript
import type { LanguagePlugin } from "reponova";
import { PythonExtractor } from "./extractor.js";
import { python as pythonOutline } from "./outline.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const grammarPath = resolve(fileURLToPath(new URL(".", import.meta.url)), "../grammars/tree-sitter-python.wasm");

export const plugin: LanguagePlugin = {
  id: "python",
  extensions: [".py", ".pyw"],
  grammarPath,
  extractor: new PythonExtractor(),
  outline: pythonOutline,
};
```

---

## Modifiche a reponova core

### 1. Nuova interfaccia `LanguagePlugin`

```typescript
// src/plugin/types.ts (nuovo)
import type { LanguageExtractor } from "../extract/types.js";
import type { LanguageSupport } from "../outline/languages/types.js";

export interface LanguagePlugin {
  readonly id: string;
  readonly extensions: string[];
  readonly grammarPath?: string;          // undefined per plugin senza tree-sitter (regex-only)
  readonly extractor: LanguageExtractor;
  readonly outline?: LanguageSupport;     // undefined se il plugin non supporta outline
}
```

Esportata da `src/index.ts`.

### 2. Discovery automatica al boot

```typescript
// src/plugin/discovery.ts (nuovo)
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { registerExtractor } from "../extract/languages/registry.js";
import { registerOutlineLanguage } from "../outline/languages/registry.js";
import { registerGrammarPath } from "./grammar-registry.js";
import type { LanguagePlugin } from "./types.js";

/**
 * Discover and register @reponova/lang-* plugins from node_modules.
 *
 * Scans the node_modules directory that contains reponova itself
 * (works for both global and local installs).
 */
export async function discoverLanguagePlugins(): Promise<void> {
  const nodeModulesDir = resolveNodeModulesDir();
  const scopeDir = join(nodeModulesDir, "@reponova");

  if (!existsSync(scopeDir)) return;

  let entries: string[];
  try {
    entries = readdirSync(scopeDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith("lang-")) continue;

    const pkgJsonPath = join(scopeDir, entry, "package.json");
    if (!existsSync(pkgJsonPath)) continue;

    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    if (pkgJson.reponova?.type !== "language") continue;

    // Dynamic import of plugin entry point
    const entryPath = pkgJson.exports?.["."] ?? "./dist/index.js";
    const mod = await import(join(scopeDir, entry, entryPath));
    const plugin: LanguagePlugin = mod.plugin;

    // Register extractor
    registerExtractor(plugin.extractor);

    // Register outline (extensions without dot)
    const extsNoDot = plugin.extensions.map((e) => e.replace(/^\./, ""));
    registerOutlineLanguage(plugin.id, extsNoDot, plugin.outline);

    // Register grammar path
    if (plugin.grammarPath) {
      const wasmFile = plugin.extractor.wasmFile ?? `tree-sitter-${plugin.id}.wasm`;
      registerGrammarPath(wasmFile, plugin.grammarPath);
    }
  }
}

function resolveNodeModulesDir(): string {
  // Walk up from reponova's own location to find the parent node_modules
  // import.meta.url → .../node_modules/reponova/dist/... → go up to node_modules/
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "package.json"))) {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      if (pkg.name === "reponova") {
        // dir is reponova's root → parent is node_modules
        return resolve(dir, "..");
      }
    }
    dir = resolve(dir, "..");
  }
  throw new Error("Could not resolve node_modules directory");
}
```

### 3. Grammar path registry

```typescript
// src/plugin/grammar-registry.ts (nuovo)
import { join } from "node:path";

const grammarPaths = new Map<string, string>();

export function registerGrammarPath(wasmFile: string, absolutePath: string): void {
  grammarPaths.set(wasmFile, absolutePath);
}

export function resolveGrammarPath(wasmFile: string, fallbackDir: string): string {
  return grammarPaths.get(wasmFile) ?? join(fallbackDir, wasmFile);
}
```

Modifica in `src/extract/parser.ts`: sostituire `resolve(grammarsDir, wasmFile)` con `resolveGrammarPath(wasmFile, grammarsDir)`.

### 4. CLI `reponova lang` (nuovo comando)

```typescript
// src/cli/lang.ts (nuovo)
import { execSync } from "node:child_process";
import { resolveNodeModulesDir } from "../plugin/discovery.js";

export async function langHandler(argv: Record<string, unknown>): Promise<void> {
  const [action, name] = argv._ as string[];
  const nodeModulesDir = resolveNodeModulesDir();
  const pkg = `@reponova/lang-${name}`;

  switch (action) {
    case "add":
      console.log(`Installing ${pkg}...`);
      execSync(`npm install ${pkg}`, { cwd: nodeModulesDir, stdio: "inherit" });
      console.log(`✓ Installed ${pkg}`);
      break;

    case "remove":
      console.log(`Removing ${pkg}...`);
      execSync(`npm uninstall ${pkg}`, { cwd: nodeModulesDir, stdio: "inherit" });
      console.log(`✓ Removed ${pkg}`);
      break;

    case "list":
      // Scan @reponova/lang-* in node_modules, print table
      await listLanguages(nodeModulesDir);
      break;
  }
}
```

### 5. Rimozione registrazioni statiche di Python

```diff
- // extract/languages/registry.ts
- import { PythonExtractor } from "./python.js";
- registerExtractor(new PythonExtractor());

- // outline/languages/registry.ts
- import { python } from "./python.js";
- registerOutlineLanguage("python", ["py", "pyw"], python);
```

I file `python.ts` (extract + outline) e `grammars/tree-sitter-python.wasm` vengono eliminati da reponova core.

### 6. Hook di inizializzazione

`await discoverLanguagePlugins()` viene chiamata:
- In `src/cli/index.ts` — nel bootstrap globale prima di parsare i comandi
- In `runBuild()` — per l'API programmatica

### 7. `reponova check` aggiornamento

```
Languages:
  python     .py, .pyw           @reponova/lang-python@1.2.0      tree-sitter ✓
  plantuml   .puml, .plantuml    @reponova/lang-plantuml@1.0.0    regex
  svg        .svg                @reponova/lang-svg@1.0.0         regex

Built-in:
  markdown   .md
```

---

## Dipendenze tra tipi

Il pacchetto lang importa tipi da `reponova` (peer dependency):

```typescript
import type { LanguageExtractor, LanguageSupport, LanguagePlugin, SyntaxTree, SyntaxNode, FileExtraction, FileOutline } from "reponova";
```

Tipi da aggiungere all'export di reponova:
- `LanguagePlugin` (nuovo)
- `FileExtraction` (da `src/extract/types.ts`)
- `SyntaxTree` (da `src/extract/types.ts`)
- `SyntaxNode` (da `src/extract/types.ts`)

---

## Markdown e Diagrams

Markdown resta in core — è first-class nel knowledge graph e non richiede asset esterni.

Il vecchio `DiagramExtractor` (PlantUML + SVG + immagini) viene spezzato in due plugin:
- `@reponova/lang-plantuml` — PlantUML (`.puml`, `.plantuml`)
- `@reponova/lang-svg` — SVG (`.svg`)

Le immagini raster (`.png`, `.jpg`, `.gif`) vengono eliminate: erano solo nodi metadata senza alcuna estrazione reale.

---

## Pacchetto `@reponova/lang-plantuml`

### Struttura

```
@reponova/lang-plantuml/
├── package.json
├── src/
│   ├── index.ts          # Entry point — esporta LanguagePlugin
│   └── extractor.ts      # extractPlantUml() da diagrams.ts
└── tsconfig.json
```

### `package.json`

```json
{
  "name": "@reponova/lang-plantuml",
  "version": "0.1.0",
  "description": "PlantUML diagram support for RepoNova",
  "type": "module",
  "exports": {
    ".": "./dist/index.js"
  },
  "files": ["dist"],
  "peerDependencies": {
    "reponova": "^0.x"
  },
  "reponova": {
    "type": "language",
    "id": "plantuml",
    "extensions": [".puml", ".plantuml"]
  }
}
```

### `src/index.ts`

```typescript
import type { LanguagePlugin } from "reponova";
import { PlantUmlExtractor } from "./extractor.js";

export const plugin: LanguagePlugin = {
  id: "plantuml",
  extensions: [".puml", ".plantuml"],
  extractor: new PlantUmlExtractor(),
};
```

---

## Pacchetto `@reponova/lang-svg`

### Struttura

```
@reponova/lang-svg/
├── package.json
├── src/
│   ├── index.ts          # Entry point — esporta LanguagePlugin
│   └── extractor.ts      # extractSvg() da diagrams.ts
└── tsconfig.json
```

### `package.json`

```json
{
  "name": "@reponova/lang-svg",
  "version": "0.1.0",
  "description": "SVG diagram support for RepoNova",
  "type": "module",
  "exports": {
    ".": "./dist/index.js"
  },
  "files": ["dist"],
  "peerDependencies": {
    "reponova": "^0.x"
  },
  "reponova": {
    "type": "language",
    "id": "svg",
    "extensions": [".svg"]
  }
}
```

### `src/index.ts`

```typescript
import type { LanguagePlugin } from "reponova";
import { SvgExtractor } from "./extractor.js";

export const plugin: LanguagePlugin = {
  id: "svg",
  extensions: [".svg"],
  extractor: new SvgExtractor(),
};
```

### Differenze tra i tre plugin

| | `lang-python` | `lang-plantuml` | `lang-svg` |
|---|---|---|---|
| Grammar WASM | `tree-sitter-python.wasm` (~4.2 MB) | Nessuno | Nessuno |
| `grammarPath` | Path al `.wasm` | `undefined` | `undefined` |
| `outline` | `LanguageSupport` implementation | `undefined` | `undefined` |
| Parsing | tree-sitter AST | Regex | Regex |
| Package size | ~4.5 MB | <50 KB | <50 KB |
| Origine in core | `python.ts` | `diagrams.ts` (extractPlantUml) | `diagrams.ts` (extractSvg) |

---

## Sequenza di migrazione (diretta, un colpo solo)

### Fase A: Infrastruttura plugin in reponova core

1. Creare `src/plugin/types.ts` con `LanguagePlugin` interface (`grammarPath?`, `outline?` opzionali)
2. Creare `src/plugin/grammar-registry.ts`
3. Creare `src/plugin/discovery.ts` — scansiona `@reponova/lang-*` nel `node_modules` di reponova
4. Creare `src/cli/lang.ts` con comandi `add`, `remove`, `list`
5. Registrare comando `reponova lang` in `src/cli/index.ts`
6. Esportare `LanguagePlugin`, `FileExtraction`, `SyntaxTree`, `SyntaxNode` da `src/index.ts`
7. Aggiungere `await discoverLanguagePlugins()` nel bootstrap CLI e nell'API programmatica
8. Modificare `src/extract/parser.ts`: usare `resolveGrammarPath()` invece di path hardcoded a `grammars/`

### Fase B: Implementare `@reponova/lang-python` (`reponova-lang-python/`)

1. Copiare `reponova/src/extract/languages/python.ts` → `reponova-lang-python/src/extractor.ts`
2. Copiare `reponova/src/outline/languages/python.ts` → `reponova-lang-python/src/outline.ts`
3. Spostare `reponova/grammars/tree-sitter-python.wasm` → `reponova-lang-python/grammars/`
4. Implementare `src/index.ts` entry point (esporta `plugin: LanguagePlugin`)
5. Adattare import paths (da relativi interni a `import type { ... } from "reponova"`)
6. Build + test

### Fase C: Implementare `@reponova/lang-plantuml` e `@reponova/lang-svg`

**`reponova-lang-plantuml/`:**
1. Estrarre `extractPlantUml()` da `reponova/src/extract/languages/diagrams.ts` → `src/extractor.ts`
2. Implementare `src/index.ts` entry point (esporta `plugin: LanguagePlugin`, no grammar, no outline)
3. Adattare import paths
4. Build + test

**`reponova-lang-svg/`:**
1. Estrarre `extractSvg()` da `reponova/src/extract/languages/diagrams.ts` → `src/extractor.ts`
2. Implementare `src/index.ts` entry point (esporta `plugin: LanguagePlugin`, no grammar, no outline)
3. Adattare import paths
4. Build + test

### Fase D: Rimozione da reponova core

1. Eliminare `src/extract/languages/python.ts`
2. Eliminare `src/outline/languages/python.ts`
3. Eliminare `src/extract/languages/diagrams.ts`
4. Eliminare `grammars/tree-sitter-python.wasm`
5. Eliminare `grammars/` directory (vuota)
6. Rimuovere da `src/extract/languages/registry.ts`: import e registrazione di `PythonExtractor` e `DiagramExtractor`
7. Rimuovere da `src/outline/languages/registry.ts`: import e registrazione di `python`
8. Aggiornare `reponova check` per mostrare plugin scoperti (già fatto parzialmente)
9. Aggiungere errore chiaro quando un file non ha extractor: `No language support for .py files. Run: reponova lang add python`
10. Aggiornare README, contributing guide

### Fase E: Verifica

1. `reponova lang add python` → installa `@reponova/lang-python`
2. `reponova lang add plantuml` → installa `@reponova/lang-plantuml`
3. `reponova lang add svg` → installa `@reponova/lang-svg`
4. `reponova build` su progetto Python → identico output a prima della migrazione
5. `reponova lang list` → mostra python + plantuml + svg
6. `reponova lang remove python` → disinstalla
7. `reponova build` senza plugin python → errore chiaro
8. Full test suite verde (con plugin come devDependency)

---

## Rischi e note

- **`import.meta.url` nei plugin**: ogni plugin risolve il proprio `grammarPath` con `import.meta.url` — funziona perché il plugin è un pacchetto separato con il suo entry point, non un chunk di reponova.
- **Dimensione**: il `.wasm` Python è ~4.2 MB. Spostarlo in `@reponova/lang-python` riduce reponova core da ~5 MB a <1 MB.
- **Test in dev**: i test di reponova che usano Python avranno `@reponova/lang-python` come `devDependency` (symlink locale a `../reponova-lang-python`).
- **npx**: `npx reponova lang add python` funziona perché npx installa reponova in una cache locale, e `lang add` installa il plugin accanto. Build successive con `npx reponova build` trovano il plugin nella stessa cache.
- **Errore senza linguaggi**: se nessun plugin è installato e il progetto ha file `.py`, reponova stampa: `No language support for .py files. Run: reponova lang add python`.
- **Breaking change**: questa migrazione rompe tutti gli utenti esistenti che non installeranno i plugin. La prossima release sarà major version con istruzioni di upgrade nel changelog.
