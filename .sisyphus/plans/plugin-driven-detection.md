# Plugin-Driven File Detection Refactoring

## Obiettivo

Eliminare ogni hardcoding di estensioni/tipologie file dal core. La detection diventa interamente guidata dai plugin registrati. Il core conosce SOLO il tipo `document` (markdown, txt, rst). Tutto il resto arriva dai plugin.

---

## Stato attuale (da rimuovere)

| Cosa | Dove | Problema |
|------|------|----------|
| `DIAGRAM_EXTENSIONS` set | `src/extract/index.ts:32` | Hardcoded nel core |
| `DOC_EXTENSIONS` set | `src/extract/index.ts:29` | OK ma accoppiato alla logica 3-way |
| `detectDiagramFiles()` | `src/extract/index.ts:152` | Funzione dedicata ai diagrammi |
| `detectDocFiles()` | `src/extract/index.ts:100` | Funzione dedicata ai docs |
| `detectFiles()` | `src/extract/index.ts:54` | Funzione dedicata al "code" |
| `getCodeExtensions()` | `src/extract/index.ts:35` | Sottrae doc+diagram da tutto |
| `ImagesConfig` interface | `src/shared/types.ts:140` | Config hardcoded per diagrammi |
| `ImagesConfigSchema` | `src/shared/config.ts:28` | Zod schema per images |
| `config.images` | `src/shared/types.ts:109` | Chiave config hardcoded |
| `DetectedFiles.diagrams` | `src/pipeline/phases/file-detection.ts:21` | Struttura fissa 3-way |
| `parse_puml`, `parse_svg_text` | `src/shared/types.ts:144-145` | Proprietà plugin nel core |

---

## Design nuovo

### 1. `LanguagePlugin` — aggiungere `fileType`

```typescript
export interface LanguagePlugin {
  readonly id: string;
  readonly extensions: string[];
  /** Etichetta per la categorizzazione in detected-files.json (default: plugin id) */
  readonly fileType?: string;
  readonly grammarPath?: string;
  readonly extractor: LanguageExtractor;
  readonly outline?: LanguageSupport;
  /** Schema delle proprietà custom che il plugin registra nel config */
  readonly configSchema?: Record<string, unknown>;
  /** Valori default per le proprietà config del plugin */
  readonly configDefaults?: Record<string, unknown>;
}
```

- `fileType` è l'etichetta libera usata come chiave in `detected-files.json`. Default = `plugin.id`.
- Il markdown built-in usa `fileType = "document"`.
- Plugin plantuml usa `fileType = "plantuml"` (o "diagram", come preferisce il plugin).
- Plugin python usa `fileType = "python"` (o "code", come preferisce).

### 2. Config — sezione `plugins` dinamica

Il config perde `images:` e guadagna una sezione per plugin (opzionale):

```yaml
plugins:
  plantuml:
    enabled: true
    patterns: []          # override globale per questo plugin
    exclude: []
    parse: true           # proprietà custom del plugin plantuml
  svg:
    enabled: true
    parse: true           # proprietà custom del plugin svg
  python:
    enabled: true
```

**Regole:**
- Se `plugins.<id>` non è nel config → il plugin è `enabled: true` con defaults
- `plugins.<id>.patterns` override i pattern globali SOLO per quel plugin
- `plugins.<id>.exclude` si aggiunge ai pattern exclude globali
- Proprietà custom definite dal plugin via `configSchema`/`configDefaults`

### 3. `detected-files.json` — struttura dinamica

```json
{
  "workspace": "/path/to/workspace",
  "files": {
    "document": ["README.md", "docs/guide.md"],
    "python": ["src/main.py", "src/utils.py"],
    "plantuml": ["diagrams/flow.puml"],
    "svg": ["diagrams/logo.svg"]
  }
}
```

- Le chiavi sono i `fileType` dei plugin/built-in
- Il consumer (graph phase) fa `Object.values(detected.files).flat()`

### 4. File detection — una funzione unica

Eliminare `detectFiles()`, `detectDocFiles()`, `detectDiagramFiles()`. Una sola funzione:

```typescript
export function detectAllFiles(
  workspace: string,
  config: Config,
  registeredTypes: RegisteredFileType[],
  skipDirs: Set<string>,
  repoNames?: Set<string>,
): Record<string, string[]>
```

Dove `RegisteredFileType` è:

```typescript
interface RegisteredFileType {
  id: string;           // chiave nel risultato
  extensions: Set<string>;
  enabled: boolean;
  patterns: string[];   // override per questo tipo
  exclude: string[];    // exclude aggiuntivi per questo tipo
  maxFileSizeKb?: number; // solo per docs
}
```

La funzione:
1. Fa un singolo walk del filesystem
2. Per ogni file, determina a quale tipo appartiene (by extension)
3. Applica pattern/exclude globali + quelli del tipo specifico
4. Ritorna `Record<fileType, string[]>`

### 5. Log — dinamico

```
[INFO]   164 python, 191 document, 35 plantuml, 10 svg
```

Generato iterando le chiavi di `detected.files`.

### 6. Plugin discovery — registra anche il fileType

`discoverLanguagePlugins()` oltre a registrare extractor/outline/grammar, raccoglie anche il `fileType` e le `extensions` di ogni plugin, rendendoli disponibili alla detection phase.

Nuovo export da `discovery.ts`:

```typescript
export function getRegisteredFileTypes(): RegisteredFileType[]
```

Che include sempre il built-in `document` + tutti i plugin scoperti.

### 7. Plugin config passthrough

Ogni plugin dichiara nel `package.json` (campo `reponova`):

```json
{
  "reponova": {
    "type": "language",
    "configDefaults": {
      "parse": true
    }
  }
}
```

Oppure nel plugin object stesso:

```typescript
export const plugin: LanguagePlugin = {
  id: "plantuml",
  extensions: [".puml", ".plantuml"],
  fileType: "plantuml",
  configDefaults: { parse: true },
  extractor: new PlantUmlExtractor(),
};
```

Il core legge `config.plugins[plugin.id]` e lo passa all'extractor. L'extractor può accedere alle proprie config custom.

---

## Modifiche file per file

### Core — `src/plugin/types.ts`
- Aggiungere `fileType?: string`
- Aggiungere `configDefaults?: Record<string, unknown>`

### Core — `src/shared/types.ts`
- Rimuovere `ImagesConfig` interface
- Rimuovere `images: ImagesConfig` da `Config`
- Aggiungere `plugins: Record<string, PluginConfig>` a `Config`
- Definire `PluginConfig = { enabled: boolean; patterns: string[]; exclude: string[]; [key: string]: unknown }`
- Rimuovere `parse_puml`, `parse_svg_text` da DEFAULT_CONFIG
- Aggiungere `plugins: {}` a DEFAULT_CONFIG

### Core — `src/shared/config.ts`
- Rimuovere `ImagesConfigSchema`
- Rimuovere `images:` dal `ConfigSchema`
- Aggiungere `plugins: z.record(z.string(), z.object({ enabled, patterns, exclude }).passthrough()).default({})`
- Nessuna migration

### Core — `src/extract/index.ts`
- Rimuovere `DIAGRAM_EXTENSIONS`
- Rimuovere `DOC_EXTENSIONS` (spostare in markdown extractor)
- Rimuovere `getCodeExtensions()`
- Rimuovere `detectFiles()`, `detectDocFiles()`, `detectDiagramFiles()`
- Aggiungere `detectAllFiles()` — singola funzione con singolo walk

### Core — `src/pipeline/phases/file-detection.ts`
- `DetectedFiles` diventa `{ workspace: string; files: Record<string, string[]> }`
- `doWork()` chiama `detectAllFiles()` con i tipi registrati
- Log dinamico: itera le chiavi

### Core — `src/pipeline/phases/graph.ts`
- `allFiles = Object.values(detected.files).flat()`

### Core — `src/plugin/discovery.ts`
- Raccogliere `fileType` da ogni plugin (default = `plugin.id`)
- Esporre `getRegisteredFileTypes()` che combina built-in + plugin

### Core — `src/extract/languages/registry.ts`
- Il markdown extractor registra anche il suo `fileType = "document"` e `extensions = [".md", ".txt", ".rst"]`

### Core — `src/cli/install/content/default-config.ts`
- Rimuovere sezione `images:`
- Aggiungere sezione `plugins:` commentata come esempio

### Plugin `@reponova/lang-plantuml`
- Aggiungere `fileType: "plantuml"` al plugin object
- Aggiungere `configDefaults: { parse: true }`
- L'extractor legge `config.parse` per decidere se parsare il contenuto (equivalente del vecchio `parse_puml`)

### Plugin `@reponova/lang-svg`
- Aggiungere `fileType: "svg"` al plugin object
- Aggiungere `configDefaults: { parse: true }`
- L'extractor legge `config.parse` (equivalente del vecchio `parse_svg_text`)

### Plugin `@reponova/lang-python`
- Aggiungere `fileType: "python"` al plugin object
- Nessuna config custom necessaria

---

## Backward Compatibility

Non esiste. Se il config ha `images:` viene ignorato (chiave sconosciuta, zod la scarta). Nessuna migration.

---

## Test da aggiornare

- Tutti i test che importano `detectFiles`, `detectDocFiles`, `detectDiagramFiles` → usare `detectAllFiles`
- Test del config loader → rimuovere `images`, testare `plugins`
- Test file-detection phase → verificare nuovo formato `DetectedFiles`

---

## Ordine di esecuzione

1. Modificare `LanguagePlugin` interface (aggiungere `fileType`, `configDefaults`)
2. Modificare Config/types (rimuovere `images`, aggiungere `plugins`)
3. Modificare config schema + migration
4. Riscrivere file detection (singola funzione)
5. Aggiornare file-detection phase
6. Aggiornare graph phase (consumer)
7. Aggiornare plugin discovery (raccogliere fileType, esporre `getRegisteredFileTypes`)
8. Aggiornare i 3 plugin packages
9. Fix test
10. Build + test full pass
