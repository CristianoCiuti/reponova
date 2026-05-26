# Install Architecture: Skill + Command Separation

## Principio

Separazione netta tra due artefatti:

- **`reponova-mcp`** = conoscenza passiva (come usare i tool MCP) — l'agent la consulta autonomamente quando rileva una domanda strutturale sul codice
- **`reponova-enrich`** = comando attivo (workflow enrichment multi-step) — l'utente lo invoca esplicitamente con `/reponova-enrich`

Il plugin/hook è un one-liner che ricorda l'esistenza dei tool e rimanda alla skill.

---

## OpenCode

**Fonti:**
- Commands: https://opencode.ai/docs/commands (`.opencode/commands/<name>.md`)
- Skills: https://opencode.ai/docs/skills (`.opencode/skills/<name>/SKILL.md`)

### Meccanismi disponibili

| Meccanismo | Path | Comportamento |
|------------|------|---------------|
| **Command** | `.opencode/commands/<name>.md` | L'utente invoca con `/name`. Frontmatter opzionale: `description`, `agent`, `model`. Body = prompt template. |
| **Skill** | `.opencode/skills/<name>/SKILL.md` | L'agent la consulta autonomamente quando la ritiene rilevante (match su `description`). Frontmatter: `name`, `description`. Body = reference knowledge. |
| **Plugin** | `.opencode/plugins/<name>.js` | Hook event-driven (es. `tool.execute.before`). Codice JS eseguito a runtime. |

### Artefatti da produrre

| Artifact | Path | Tipo | Funzione |
|----------|------|------|----------|
| MCP config | `.opencode/opencode.json` → `mcp.reponova` | config | Registra il server MCP (11 tool auto-esposti) |
| Plugin | `.opencode/plugins/reponova.js` | plugin | Reminder: "i tool MCP esistono, consulta skill reponova-mcp" |
| Skill MCP | `.opencode/skills/reponova-mcp/SKILL.md` | **skill** | Guida su QUANDO usare QUALE tool (decision table + best practices) |
| Command Enrich | `.opencode/commands/reponova-enrich.md` | **command** | Workflow enrichment — utente invoca con `/reponova-enrich` |

### Flusso

1. Plugin si attiva prima di bash → reminder breve ("consulta skill reponova-mcp")
2. Agent consulta `reponova-mcp` skill per capire quale tool usare
3. Agent usa i tool MCP direttamente (parametri esposti dal protocollo)
4. Utente digita `/reponova-enrich` → agent riceve il template del command e segue il workflow

### Formato command (`.opencode/commands/reponova-enrich.md`)

```markdown
---
description: Intelligent enrichment workflow for the reponova knowledge graph
---

(corpo del workflow — il prompt template che l'agent riceve quando l'utente invoca /reponova-enrich)
```

### Formato skill (`.opencode/skills/reponova-mcp/SKILL.md`)

```markdown
---
name: reponova-mcp
description: Knowledge graph MCP tools — use instead of grep/find for structural code questions.
---

(corpo della skill — decision table, key workflows, note importanti)
```

---

## Cursor

**Fonti:**
- Commands (v1.6+): https://cursor.com/changelog/1-6 — "Commands are stored in `.cursor/commands/[command].md`"
- Rules: https://cursor.com/docs/rules — `.cursor/rules/*.mdc` con frontmatter
- Skills: `.cursor/skills/*/SKILL.md` (documentato in community specs, non ancora nella docs ufficiale principale)

### Meccanismi disponibili

| Meccanismo | Path | Comportamento |
|------------|------|---------------|
| **Command** | `.cursor/commands/<name>.md` | Slash command. L'utente digita `/` in Agent/Composer → appare nel dropdown. Il filename (senza `.md`) diventa il nome del comando. **Nessun frontmatter** supportato — plain markdown. |
| **Rule** | `.cursor/rules/<name>.mdc` | Contesto persistente iniettato in base al tipo di attivazione. Frontmatter: `description`, `alwaysApply`, `globs`. |
| **Skill** | `.cursor/skills/<name>/SKILL.md` | Capacità riusabile caricata quando rilevante (Agent Skills standard). |

### Tipi di attivazione rule

| `alwaysApply` | `description` | `globs` | Comportamento |
|---|---|---|---|
| `true` | — | — | Sempre inclusa in ogni conversazione |
| `false` | — | provided | Auto-attached quando file matching sono in context |
| `false` | provided | — | Agent decide se è rilevante in base alla `description` |
| `false` | — | — | Solo con @-mention manuale (`@rule-name`) |

### Artefatti da produrre

| Artifact | Path | Tipo | Funzione |
|----------|------|------|----------|
| MCP config | `.cursor/mcp.json` → `mcpServers.reponova` | config | Registra il server MCP |
| Rule MCP | `.cursor/rules/reponova-mcp.mdc` | **rule** (`alwaysApply: true`) | Guida tool — sempre caricata in ogni conversazione |
| Command Enrich | `.cursor/commands/reponova-enrich.md` | **command** | Workflow enrichment — utente invoca con `/reponova-enrich` |

### Flusso

1. Rule `alwaysApply: true` è SEMPRE in context → agent sa che esistono i graph tools
2. Agent usa i tool MCP direttamente
3. Utente digita `/reponova-enrich` → agent riceve il contenuto del command e segue il workflow

### Formato command (`.cursor/commands/reponova-enrich.md`)

```markdown
(plain markdown — nessun frontmatter supportato per i commands in Cursor)
(corpo del workflow enrichment)
```

### Formato rule (`.cursor/rules/reponova-mcp.mdc`)

```markdown
---
description: reponova knowledge graph — use graph tools instead of grep/find
alwaysApply: true
---

(corpo della guida tool MCP)
```

### Note

- In Cursor, commands e rules sono DUE COSE SEPARATE:
  - `.cursor/commands/*.md` → slash commands invocabili dall'utente con `/`
  - `.cursor/rules/*.mdc` → contesto iniettato automaticamente in base alle regole di attivazione
- La rule `alwaysApply: true` fa contemporaneamente da "nudge" E da "guida tool" (non serve un plugin separato)

---

## Claude Code

**Fonti:**
- Skills (recommended): https://code.claude.com/docs/en/slash-commands — "The recommended format for defining commands is `.claude/skills/<name>/SKILL.md`, which supports both slash-command invocation (e.g., `/name`) and autonomous invocation by Claude."
- Commands (legacy): https://code.claude.com/docs/en/agent-sdk/slash-commands — `.claude/commands/<name>.md` (still supported, skills format preferred)
- Hooks: https://code.claude.com/docs/en/hooks — `.claude/settings.json` → `hooks.PreToolUse`

### Meccanismi disponibili

| Meccanismo | Path | Comportamento |
|------------|------|---------------|
| **Skill** | `.claude/skills/<name>/SKILL.md` | **DUAL-PURPOSE**: sia slash command (`/name`) sia caricamento autonomo da parte dell'agent. La `description` nel frontmatter determina quando l'agent la carica autonomamente. **Formato raccomandato.** |
| **Command (legacy)** | `.claude/commands/<name>.md` | Solo slash command. Ancora supportato ma deprecato in favore di skills. |
| **Hook** | `.claude/settings.json` → `hooks` | Script eseguito a specifici lifecycle points (PreToolUse, PostToolUse, etc.). |

### Distinzione skill "passiva" vs skill "command" in Claude Code

In Claude Code **NON esiste separazione a livello di filesystem** tra skill e command — sono lo stesso artefatto (`.claude/skills/<name>/SKILL.md`). La distinzione è COMPORTAMENTALE:

- **Skill passiva** (`reponova-mcp`): la `description` dice "Knowledge graph MCP tools — use instead of grep/find" → Claude la carica autonomamente quando rileva una domanda strutturale. L'utente PUÒ anche invocarla con `/reponova-mcp` ma normalmente non serve.
- **Skill-command** (`reponova-enrich`): la `description` dice "Intelligent enrichment workflow [...] Invoke when user asks to enrich" → Claude la carica SOLO quando l'utente la invoca esplicitamente con `/reponova-enrich`.

### Artefatti da produrre

| Artifact | Path | Tipo | Funzione |
|----------|------|------|----------|
| MCP config | `claude mcp add reponova -- npx -y reponova mcp --graph <path>` | config | Registra il server MCP |
| Hook | `.claude/settings.json` → `hooks.PreToolUse` | hook | Reminder: "tool MCP disponibili, consulta skill reponova-mcp" |
| Skill MCP | `.claude/skills/reponova-mcp/SKILL.md` | **skill** (passiva) | Guida tool — agent la carica autonomamente quando rileva query strutturali |
| Skill Enrich | `.claude/skills/reponova-enrich/SKILL.md` | **skill** (command) | Workflow enrichment — utente invoca con `/reponova-enrich` |

### Flusso

1. Hook PreToolUse si attiva prima di Bash → reminder breve
2. Agent consulta autonomamente `reponova-mcp` skill (basato su description matching)
3. Agent usa i tool MCP direttamente
4. Utente digita `/reponova-enrich` → agent carica la skill e segue il workflow

---

## VS Code (Copilot)

**Fonti:**
- Skills: https://code.visualstudio.com/docs/copilot/customization/agent-skills
- Instructions: https://code.visualstudio.com/docs/copilot/customization/custom-instructions
- Prompt files: https://code.visualstudio.com/docs/copilot/customization/prompt-files
- Plugins: https://code.visualstudio.com/docs/copilot/customization/agent-plugins
- Overview: https://code.visualstudio.com/docs/copilot/customization/overview

### Meccanismi disponibili

| Meccanismo | Path | Comportamento |
|------------|------|---------------|
| **Skill** | `.github/skills/<name>/SKILL.md` | DUAL-PURPOSE: invocabile con `/name` E caricata autonomamente quando Copilot la ritiene rilevante. Frontmatter: `name`, `description`, `user-invocable`, `disable-model-invocation`. |
| **Prompt file** | `.github/prompts/<name>.prompt.md` | Template riusabile invocato con `/name`. Più semplice di una skill (no directory, no risorse aggiuntive). |
| **Instructions** | `.github/copilot-instructions.md` | Always-on. Applicato a OGNI richiesta in chat. |
| **Instructions file** | `*.instructions.md` | Condizionale. Frontmatter `applyTo` per glob matching. |
| **Hook** | `.github/hooks/<event>.md` | Shell commands a lifecycle points (sperimentale). |

### Configurazione comportamento skill (VS Code)

| `user-invocable` | `disable-model-invocation` | Slash command? | Auto-loaded? | Use case |
|---|---|---|---|---|
| `true` (default) | `false` (default) | Sì | Sì | Skill general-purpose |
| `false` | `false` | **No** | Sì | **Conoscenza passiva** — agent la carica quando rilevante, non appare nel menu `/` |
| `true` | `true` | Sì | **No** | **Solo comando** — appare nel menu `/`, agent NON la carica autonomamente |
| `false` | `true` | No | No | Disabilitata |

### Artefatti da produrre

| Artifact | Path | Tipo | Funzione |
|----------|------|------|----------|
| MCP config | `.vscode/mcp.json` → `servers.reponova` | config | Registra il server MCP |
| Skill MCP | `.github/skills/reponova-mcp/SKILL.md` | **skill** (`user-invocable: false`) | Guida tool — auto-loaded quando Copilot rileva query strutturali. NON appare come comando. |
| Skill Enrich | `.github/skills/reponova-enrich/SKILL.md` | **skill** (`disable-model-invocation: true`) | Workflow enrichment — utente invoca con `/reponova-enrich`. NON auto-loaded. |

### Flusso

1. Copilot rileva che l'utente sta facendo una domanda strutturale → carica autonomamente `reponova-mcp` skill
2. Agent usa i tool MCP direttamente
3. Utente digita `/reponova-enrich` → Copilot carica la skill e segue il workflow

### Formato skill MCP (`.github/skills/reponova-mcp/SKILL.md`)

```markdown
---
name: reponova-mcp
description: Knowledge graph MCP tools — use instead of grep/find for structural code questions. Use when searching symbols, analyzing dependencies, or exploring architecture.
user-invocable: false
---

(corpo della guida tool MCP)
```

### Formato skill Enrich (`.github/skills/reponova-enrich/SKILL.md`)

```markdown
---
name: reponova-enrich
description: Intelligent enrichment workflow for the reponova knowledge graph. Invoke when user asks to enrich the graph.
disable-model-invocation: true
---

(corpo del workflow enrichment)
```

### Nota su `copilot-instructions.md`

In alternativa alla skill con `user-invocable: false`, si può mettere la guida MCP in una sezione di `.github/copilot-instructions.md` (GARANTITO always-on, inclusa in OGNI richiesta). La skill con `user-invocable: false` è più context-efficient (caricata solo quando rilevante) ma meno affidabile (dipende dall'intelligenza dell'agent per decidere il matching). Per il comando `/reponova-enrich` non c'è alternativa: **deve** essere una skill.

---

## Contenuto degli artefatti

### `reponova-mcp` (guida tool)

Contiene:
- Decision table: "per questa domanda → usa questo tool"
- Key workflows (5 pattern comuni)
- Note importanti (resolved paths, rebuild, filtri)
- **NON** contiene parametri dei tool (MCP li espone via protocollo)

~40 righe. Non è un reminder (troppo lungo), non è documentazione API (MCP lo fa). È il layer intermedio: QUANDO usare COSA.

### `reponova-enrich` (workflow command)

Contiene:
- Quick reference table (steps 0-8)
- Dettaglio di ogni step con output format JSON
- Rules (skip, immutabilità, batch naming, cache seal)
- ~100 righe

---

## Plugin/Hook (reminder)

Testo breve (1-2 frasi):

> "reponova: 11 MCP graph tools available. Consult the reponova-mcp skill to know which tool to use. Use graph_search instead of grep/find."

Non documenta nulla — rimanda alla skill.

---

## Naming & Path Convention

| Concetto | OpenCode | Cursor | Claude Code | VS Code |
|----------|----------|--------|-------------|---------|
| Guida tool (passiva) | skill `.opencode/skills/reponova-mcp/SKILL.md` | rule `.cursor/rules/reponova-mcp.mdc` | skill `.claude/skills/reponova-mcp/SKILL.md` | skill `.github/skills/reponova-mcp/SKILL.md` |
| Comando enrich (attivo) | command `.opencode/commands/reponova-enrich.md` | command `.cursor/commands/reponova-enrich.md` | skill `.claude/skills/reponova-enrich/SKILL.md` | skill `.github/skills/reponova-enrich/SKILL.md` |
| Reminder | plugin `.opencode/plugins/reponova.js` | (nella rule alwaysApply) | hook `.claude/settings.json` | (nella skill con description) |
| MCP server | `opencode.json` → `mcp` | `.cursor/mcp.json` | `claude mcp add` | `.vscode/mcp.json` |

---

## Differenze chiave tra IDE

| | Command ≠ Skill? | Come si invoca il command | Come si fornisce conoscenza passiva |
|---|---|---|---|
| **OpenCode** | **SÌ** — path diversi (commands/ vs skills/) | `/name` → carica `.opencode/commands/name.md` | Skill in `.opencode/skills/name/SKILL.md` |
| **Cursor** | **SÌ** — path diversi (commands/ vs rules/) | `/name` → carica `.cursor/commands/name.md` | Rule `.mdc` con `alwaysApply: true` |
| **Claude Code** | **NO** — stesso path (skills/), distinzione comportamentale | `/name` → carica `.claude/skills/name/SKILL.md` | Stessa directory — description guida il caricamento autonomo |
| **VS Code** | **NO** — stesso path (skills/), distinzione via frontmatter | `/name` → carica `.github/skills/name/SKILL.md` | Stessa directory — `user-invocable: false` + `disable-model-invocation: false` |

---

## Struttura file implementativa

```
src/cli/install/
├── index.ts              # CommandModule yargs + switch(target) → dispatch a targets/*
├── types.ts              # Target type, InstallerContext { projectDir, graphDir }
├── utils.ts              # JSONC helpers, writeConfigFile, ensureDir, _testing export
├── content/
│   ├── mcp-skill.ts      # export MCP_SKILL_MD — guida tool (~40 righe, raw text)
│   ├── enrich-command.ts  # export ENRICH_COMMAND_MD — workflow enrichment (~100 righe, raw text)
│   ├── hook-context.ts    # export HOOK_CONTEXT — reminder 1-2 frasi
│   ├── plugin-opencode.ts # export OPENCODE_PLUGIN_JS — template JS plugin
│   └── default-config.ts  # export DEFAULT_CONFIG_YAML — reponova.yml di default
├── targets/
│   ├── opencode.ts        # installOpenCode(ctx) — config + plugin + skill + command
│   ├── cursor.ts          # installCursor(ctx)   — config + rule + command
│   ├── claude.ts          # installClaude(ctx)   — hook + skill passiva + skill command
│   └── vscode.ts          # installVSCode(ctx)   — config + skill passiva + skill command
```

### Responsabilità

| File | Cosa fa |
|------|---------|
| `index.ts` | Solo yargs command definition + dispatch. Zero logica di installazione. |
| `types.ts` | `type Target`, `interface InstallerContext { projectDir: string; graphDir: string }` |
| `utils.ts` | `resolveJsonConfigPath`, `readJsoncText`, `setJsoncProperty`, `withTrailingNewline`, `writeConfigFile`, `ensureDir`. Export `_testing` per i test. |
| `content/*` | Ogni file export una singola `const` con il testo raw dell'artefatto. Nessuna logica, nessun fs, nessun frontmatter IDE-specifico. |
| `targets/*` | Ogni file export una singola funzione `install<IDE>(ctx: InstallerContext): void`. Assembla contenuto + frontmatter IDE-specifico, scrive su disco, stampa log. |

### Principi

1. **`content/` = corpo puro**. Mai path, mai frontmatter IDE-specifico, mai import fs.
2. **`targets/` = assemblaggio**. Aggiunge frontmatter, compone path finali, crea directory, scrive file.
3. **`utils.ts` = utility condivise**. Usate da tutti i target.
4. **`index.ts` = dispatch puro**. Chiama `install<IDE>(ctx)` e basta.

### Fix rispetto alla versione precedente

| IDE | Prima (SBAGLIATO) | Dopo (CORRETTO) |
|-----|-------------------|-----------------|
| OpenCode enrich | `.opencode/skills/reponova-enrich/SKILL.md` | `.opencode/commands/reponova-enrich.md` |
| Cursor enrich | `.cursor/rules/reponova-enrich.mdc` | `.cursor/commands/reponova-enrich.md` |
| VS Code | `.github/copilot-instructions.md` (flat section) | `.github/skills/reponova-mcp/SKILL.md` + `.github/skills/reponova-enrich/SKILL.md` |

---

## Fonti e verifica

| IDE | URL documentazione | Verifica |
|-----|-------------------|----------|
| OpenCode commands | https://opencode.ai/docs/commands | Verificato — `.opencode/commands/<name>.md` con frontmatter |
| OpenCode skills | https://opencode.ai/docs/skills | Verificato — `.opencode/skills/<name>/SKILL.md` |
| Cursor commands | https://cursor.com/changelog/1-6 | Verificato — "Commands are stored in `.cursor/commands/[command].md`" (v1.6, Sep 2025) |
| Cursor rules | https://cursor.com/docs/rules | Verificato — `.cursor/rules/*.mdc` con 4 tipi di attivazione |
| Claude Code skills | https://code.claude.com/docs/en/slash-commands | Verificato — "recommended format is `.claude/skills/<name>/SKILL.md`" |
| Claude Code commands (legacy) | https://code.claude.com/docs/en/agent-sdk/slash-commands | Verificato — `.claude/commands/` still supported |
| VS Code skills | https://code.visualstudio.com/docs/copilot/customization/agent-skills | Verificato — `user-invocable`, `disable-model-invocation` fields |
| VS Code instructions | https://code.visualstudio.com/docs/copilot/customization/custom-instructions | Verificato — `copilot-instructions.md` always-on |
