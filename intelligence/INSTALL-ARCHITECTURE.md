# Install Architecture: Skill + Command Separation

## Principio

Separazione netta tra:
- **`reponova-mcp`** = skill passiva (come usare i tool MCP) — reference consultabile
- **`reponova-enrich`** = command attivo (workflow enrichment multi-step) — invocato esplicitamente dall'utente

Il plugin/hook è un one-liner che ricorda l'esistenza dei tool e rimanda alla skill.

---

## OpenCode

| Artifact | Path | Tipo | Funzione |
|----------|------|------|----------|
| MCP config | `.opencode/opencode.json` → `mcp.reponova` | config | Registra il server MCP (11 tool auto-esposti) |
| Plugin | `.opencode/plugins/reponova.js` | plugin | Reminder: "i tool MCP esistono, consulta skill reponova-mcp" |
| Skill MCP | `.opencode/skills/reponova-mcp/SKILL.md` | skill | Guida su QUANDO usare QUALE tool (decision table + best practices) |
| Command Enrich | `.opencode/skills/reponova-enrich/SKILL.md` | command | Workflow enrichment — utente invoca con `/reponova-enrich` |

**Flusso:**
1. Plugin si attiva prima di bash → reminder breve
2. Agent consulta `reponova-mcp` skill per capire quale tool usare
3. Agent usa i tool MCP direttamente (parametri esposti dal protocollo)
4. Utente digita `/reponova-enrich` → agent carica la skill e segue il workflow

---

## Cursor

| Artifact | Path | Tipo | Funzione |
|----------|------|------|----------|
| MCP config | `.cursor/mcp.json` → `mcpServers.reponova` | config | Registra il server MCP |
| Rule MCP | `.cursor/rules/reponova-mcp.mdc` | rule (`alwaysApply: true`) | Guida tool — sempre caricata in ogni conversazione |
| Rule Enrich | `.cursor/rules/reponova-enrich.mdc` | rule (`alwaysApply: false`) | Workflow enrichment — caricata solo quando Cursor decide che è rilevante (match su `description`) |

**Note Cursor:**
- Non esiste il concetto di plugin/hook → la rule `alwaysApply: true` fa da nudge + guida
- Non esiste il concetto di command → la rule con `description` viene attivata dal context engine di Cursor quando l'utente menziona enrichment

---

## Claude Code

| Artifact | Path | Tipo | Funzione |
|----------|------|------|----------|
| MCP config | Registrato via `claude mcp add` | config | Registra il server MCP |
| Hook | `.claude/settings.json` → `hooks.PreToolUse` | hook | Reminder: "tool MCP disponibili, consulta skill reponova-mcp" |
| Skill MCP | `.claude/skills/reponova-mcp/SKILL.md` | skill | Guida su QUANDO usare QUALE tool |
| Command Enrich | `.claude/skills/reponova-enrich/SKILL.md` | command | Workflow enrichment — utente invoca con `/reponova-enrich` |

**Flusso identico a OpenCode** — Claude Code ha lo stesso modello skill/command.

---

## VS Code (Copilot)

| Artifact | Path | Tipo | Funzione |
|----------|------|------|----------|
| MCP config | `.vscode/mcp.json` → `servers.reponova` | config | Registra il server MCP |
| Instructions | `.github/copilot-instructions.md` § `## reponova` | always-on | Guida tool MCP (equivalente skill, unico meccanismo disponibile) |
| Instructions | `.github/copilot-instructions.md` § `## reponova enrich` | always-on | Workflow enrichment (stesso file, no alternative) |

**Limitazione VS Code:**
- Non ha plugin/hook, non ha command, non ha attivazione condizionale
- Tutto va in `copilot-instructions.md` — è l'unica leva
- Entrambe le sezioni sono sempre caricate (nessun on-demand possibile)

---

## Contenuto delle skill

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

> "reponova: 11 tool MCP disponibili per query strutturali sul codebase. Consulta la skill reponova-mcp per sapere quale tool usare. Usa graph_search invece di grep."

Non documenta nulla — rimanda alla skill.

---

## Naming Convention

| Concetto | OpenCode | Cursor | Claude | VS Code |
|----------|----------|--------|--------|---------|
| Guida tool | skill `reponova-mcp` | rule `reponova-mcp.mdc` | skill `reponova-mcp` | section `## reponova` |
| Workflow enrich | command `reponova-enrich` | rule `reponova-enrich.mdc` | command `reponova-enrich` | section `## reponova enrich` |
| Reminder | plugin `.js` | (nella rule alwaysApply) | hook PreToolUse | (nelle instructions) |
| MCP server | config `opencode.json` | config `mcp.json` | `claude mcp add` | config `mcp.json` |
