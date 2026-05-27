# Analisi: Batching nell'Enrichment Pipeline

## Problema

Quando l'agent esegue l'enrichment in modalità manuale (senza LLM provider configurato), deve:
1. Sapere QUALI nodi processare per ogni batch
2. Sapere IN QUALE FILE scrivere ogni batch di output
3. Non inventarsi nomi di file a caso (tipo `_batch_1.json`)

Attualmente la skill dice solo "scrivi `.enrich/descriptions/batch-NNN.json`" — ma non dice:
- Quanti nodi per batch
- Quali nodi in quale batch
- Come raggrupparli

**Soluzione**: il CLI prepara i batch di INPUT, l'agent li legge, ragiona, e scrive i batch di OUTPUT.

---

## Mappa dei batch nell'enrichment

Il pipeline ha **4 step che producono batch** e **1 step single-shot**:

| Step | Cosa produce | Strategia batch attuale (orchestrator) | Dipende da |
|------|-------------|---------------------------------------|------------|
| 1 — Descriptions | `descriptions/batch-NNN.json` | Token budget (40k token/batch), raggruppamento per directory | `candidates.json` + source code |
| 2 — Profiles | `profiles/community-NNN.json` | 1 community per file (>= 3 membri) | `descriptions.json` + `graph.json` |
| 3 — Routing | `routing/batch-NNN.json` | Chunking fisso (30 candidati/batch) | `candidates.json` + `profiles.json` + `descriptions.json` |
| 4 — Restructure | `restructure.json` (singolo file) | Single-shot, non è un batch | `profiles.json` + `edge-density.json` + `routing.json` |
| 6 — Updated Profiles | `updated-profiles/community-NNN.json` | 1 community per file (solo modified) | `modified-communities.json` + `graph-applied.json` + `descriptions.json` |

---

## Analisi dettagliata per step

### Step 1: Node Descriptions

**Input necessario per l'agent**: Per ogni nodo candidato, il source code (file + start_line + end_line).

**Come il CLI li batchizza (orchestrator.ts L61-82)**:
- Usa `packBatches()` da `batcher.ts`
- Raggruppa nodi per directory del source file
- Riempie batch fino a `description_batch_tokens` (default: 40000 token, ~4 char/token)
- Se un nodo è troppo grande, finisce da solo in un batch

**Output dell'agent**: Per ogni batch, un array JSON `[{id, description}]`

**Dipendenze**: Solo `candidates.json` (output di Step 0) + source code dei file. **Nessuna dipendenza da step precedenti LLM**. Può essere preparato subito dopo `enrich:metrics`.

**Può essere pre-creato dal CLI?** ✅ SÌ — il CLI ha tutto: conosce i nodi, ha il source code, sa il token budget. Può creare i batch di input con il codice già incluso.

**Formato ideale del batch di input (creato dal CLI)**:
```json
{
  "batchId": 1,
  "totalBatches": 12,
  "items": [
    {
      "nodeId": "Function:authenticate_user",
      "qualifiedName": "auth.service.authenticate_user",
      "filePath": "src/auth/service.py",
      "startLine": 42,
      "endLine": 67,
      "code": "def authenticate_user(...):\n    ..."
    }
  ]
}
```

---

### Step 2: Community Profiles

**Input necessario per l'agent**: Per ogni community (>= 3 membri), la lista dei nodi con le loro descrizioni + gli edge interni.

**Come il CLI li batchizza (orchestrator.ts L84-133)**:
- 1 job = 1 community
- Filtra community con meno di 3 membri e "unclustered"
- Incllude: members `[{id, description}]` + edges interni `[{source, target, type}]`

**Output dell'agent**: Per ogni community, un singolo oggetto JSON `{communityId, label, profile, misfits}`

**Dipendenze**: Richiede `descriptions.json` (output merged di Step 1). **NON può essere pre-creato insieme a Step 1** — deve aspettare che le descrizioni siano complete e merged.

**Può essere pre-creato dal CLI?** ✅ SÌ, ma SOLO DOPO il merge di Step 1. Serve un comando separato: `enrich:prepare profiles` (o simile) che legge `descriptions.json` e crea i batch di input per Step 2.

**Formato ideale del batch di input (creato dal CLI)**:
```json
{
  "communityId": "auth",
  "members": [
    {"id": "Function:authenticate_user", "description": "Authenticates users by..."},
    {"id": "Function:validate_token", "description": "Validates JWT tokens..."}
  ],
  "internalEdges": [
    {"source": "Function:authenticate_user", "target": "Function:validate_token", "type": "calls"}
  ]
}
```

---

### Step 3: Candidate Routing

**Input necessario per l'agent**: Per ogni candidato, la sua descrizione, la community attuale, il profilo della community attuale, le community adiacenti (con edge count) e i profili di quelle community.

**Come il CLI li batchizza (orchestrator.ts L136-206)**:
- Chunking fisso: `routing_batch_size` (default: 30 candidati per batch)
- Per ogni candidato: `{nodeId, description, currentCommunity, adjacentCommunities: [{id, edgeCount}]}`
- Include anche i profili delle community rilevanti nel prompt

**Output dell'agent**: Per ogni batch, un array `[{node, action, to?, reason}]`

**Dipendenze**: Richiede `candidates.json` + `profiles.json` + `descriptions.json`. **NON può essere pre-creato prima di Step 2** — serve il profilo delle community.

**Può essere pre-creato dal CLI?** ✅ SÌ, ma SOLO DOPO il merge di Step 2. Il CLI ha tutti i dati per assemblare i batch con il contesto necessario.

**Formato ideale del batch di input (creato dal CLI)**:
```json
{
  "batchId": 1,
  "totalBatches": 4,
  "candidates": [
    {
      "nodeId": "Function:hash_password",
      "description": "Hashes passwords using bcrypt...",
      "currentCommunity": "auth",
      "currentCommunityProfile": "Authentication and identity management...",
      "adjacentCommunities": [
        {"id": "data", "edgeCount": 5, "profile": "Database access layer..."},
        {"id": "utils", "edgeCount": 2, "profile": "Generic utilities..."}
      ]
    }
  ]
}
```

---

### Step 4: Restructure (NON è un batch)

**Input necessario per l'agent**: Profili di tutte le community, top-20 edge density pairs, info su community che hanno ricevuto nodi dal routing, size outliers.

**Come funziona (orchestrator.ts L210-253)**: Single-shot — un solo prompt, un solo output.

**Dipendenze**: Richiede `profiles.json` + `edge-density.json` + `routing.json`.

**Può essere pre-creato dal CLI?** ✅ SÌ — un singolo file di input con tutto il contesto assemblato. Ma è una sola chiamata, quindi il "batch" non c'entra.

**Formato ideale del file di input (creato dal CLI)**:
```json
{
  "profiles": [...],
  "topEdgeDensityPairs": [...],
  "gainedNodes": {"data": 3, "utils": 1},
  "sizeOutliers": [{"communityId": "core", "nodeCount": 87}]
}
```

---

### Step 6: Updated Profiles

**Input necessario per l'agent**: Per ogni community modificata (da Step 5: apply), la nuova lista di membri + edges interni. Identico a Step 2 ma solo per community modified/created.

**Come il CLI li batchizza (orchestrator.ts L264-313)**: Identico a Step 2 — 1 community per file.

**Dipendenze**: Richiede `modified-communities.json` + `graph-applied.json` + `descriptions.json`. **NON può essere pre-creato prima di Step 5** — `graph-applied.json` e `modified-communities.json` sono output di `enrich:apply`.

**Può essere pre-creato dal CLI?** ✅ SÌ, ma SOLO DOPO `enrich:apply`. Serve che il CLI prepari i batch con la nuova composizione delle community.

---

## Catena di dipendenze e punti di preparazione batch

```
enrich:metrics (Step 0)
    ↓ produce candidates.json + edge-density.json
    ↓
[CLI può preparare batch Step 1]  ← PUNTO DI PREPARAZIONE #1
    ↓
AGENT scrive output batch Step 1
    ↓
enrich:merge descriptions
    ↓ produce descriptions.json
    ↓
[CLI può preparare batch Step 2]  ← PUNTO DI PREPARAZIONE #2
    ↓
AGENT scrive output batch Step 2
    ↓
enrich:merge profiles
    ↓ produce profiles.json
    ↓
[CLI può preparare batch Step 3 + input Step 4]  ← PUNTO DI PREPARAZIONE #3
    ↓
AGENT scrive output batch Step 3 + restructure.json (Step 4)
    ↓
enrich:merge routing
    ↓
enrich:apply (Step 5)
    ↓ produce graph-applied.json + modified-communities.json
    ↓
[CLI può preparare batch Step 6]  ← PUNTO DI PREPARAZIONE #4
    ↓
AGENT scrive output batch Step 6
    ↓
enrich:merge updated-profiles
    ↓
enrich:finalize (Step 7)
```

---

## Domanda chiave: Si possono creare tutti i batch insieme?

**NO.** Ogni punto di preparazione dipende dall'output LLM dello step precedente:

- Step 2 richiede `descriptions.json` → output di Step 1 (prodotto dall'agent)
- Step 3 richiede `profiles.json` → output di Step 2 (prodotto dall'agent)
- Step 6 richiede `graph-applied.json` → output di Step 5 (che dipende da routing prodotto dall'agent)

L'unico batch preparabile "upfront" (senza output LLM) è **Step 1**.

---

## Proposta: comando `enrich:prepare <step>`

Un nuovo comando CLI che:
1. Legge i prerequisiti (file merged degli step precedenti)
2. Divide in batch secondo parametri configurabili
3. Scrive i batch di INPUT in una directory dedicata
4. L'agent li legge, ragiona, e scrive i batch di OUTPUT nella directory di output

### Struttura directory proposta

```
reponova-out/.enrich/
├── candidates.json          ← output enrich:metrics (Step 0)
├── edge-density.json        ← output enrich:metrics (Step 0)
│
├── input/                   ← BATCH DI INPUT (creati dal CLI, letti dall'agent)
│   ├── descriptions/
│   │   ├── batch-001.json   ← {batchId, items: [{nodeId, code, ...}]}
│   │   └── batch-012.json
│   ├── profiles/
│   │   ├── community-001.json  ← {communityId, members, internalEdges}
│   │   └── community-015.json
│   ├── routing/
│   │   ├── batch-001.json   ← {batchId, candidates: [{nodeId, context...}]}
│   │   └── batch-004.json
│   ├── restructure-input.json  ← singolo file con tutto il contesto
│   └── updated-profiles/
│       ├── community-001.json
│       └── community-003.json
│
├── output/                  ← BATCH DI OUTPUT (scritti dall'agent, letti dal merge)
│   ├── descriptions/
│   │   ├── batch-001.json   ← [{id, description}]
│   │   └── batch-012.json
│   ├── profiles/
│   │   ├── community-001.json  ← {communityId, label, profile, misfits}
│   │   └── community-015.json
│   ├── routing/
│   │   ├── batch-001.json   ← [{node, action, to?, reason}]
│   │   └── batch-004.json
│   ├── restructure.json     ← {merges, splits}
│   └── updated-profiles/
│       ├── community-001.json
│       └── community-003.json
│
├── descriptions.json        ← output enrich:merge descriptions (merged)
├── profiles.json            ← output enrich:merge profiles (merged)
├── routing.json             ← output enrich:merge routing (merged)
├── restructure.json         ← copiato da output/ (single-shot)
├── graph-applied.json       ← output enrich:apply
├── modified-communities.json ← output enrich:apply
└── updated-profiles.json    ← output enrich:merge updated-profiles (merged)
```

### Flusso rivisto per l'agent

```
1. reponova enrich:metrics                      ← Step 0
2. reponova enrich:prepare descriptions         ← crea input/descriptions/batch-*.json
3. AGENT legge input/descriptions/batch-001.json → scrive output/descriptions/batch-001.json
   ...ripete per tutti i batch...
4. reponova enrich:merge descriptions           ← merge output/descriptions/*.json → descriptions.json
5. reponova enrich:prepare profiles             ← crea input/profiles/community-*.json
6. AGENT legge input/profiles/community-001.json → scrive output/profiles/community-001.json
   ...ripete per tutte le community...
7. reponova enrich:merge profiles               ← merge output/profiles/*.json → profiles.json
8. reponova enrich:prepare routing              ← crea input/routing/batch-*.json + input/restructure-input.json
9. AGENT legge input/routing/batch-001.json → scrive output/routing/batch-001.json
   ...ripete per tutti i batch...
   AGENT legge input/restructure-input.json → scrive output/restructure.json
10. reponova enrich:merge routing               ← merge output/routing/*.json → routing.json
11. reponova enrich:apply                       ← produce graph-applied.json + modified-communities.json
12. reponova enrich:prepare updated-profiles    ← crea input/updated-profiles/community-*.json
13. AGENT legge e scrive come Step 6
14. reponova enrich:merge updated-profiles
15. reponova enrich:finalize                    ← assembla file finali, CANCELLA .enrich/
```

### Impatto sulla codebase esistente

| File | Modifica |
|------|----------|
| `src/cli/enrich-prepare.ts` | **NUOVO** — comando `enrich:prepare <step>` |
| `src/pipeline/enrich/prepare.ts` | **NUOVO** — logica di preparazione batch |
| `src/pipeline/enrich/merge.ts` | Aggiornare path: leggere da `output/<step>/` invece che da `<step>/` |
| `src/pipeline/enrich/finalize.ts` | Aggiungere cleanup di `.enrich/` a fine finalize |
| `src/pipeline/enrich/batcher.ts` | Riutilizzato da `prepare.ts` |
| `src/cli/install/content/enrich-command.ts` | Riscrivere la skill con il nuovo flusso |
| `src/pipeline/enrich/orchestrator.ts` | Opzionale — se il provider è configurato usa il flusso automatico (invariato) |

### Nota sulla coesistenza con il flusso automatico

L'orchestrator (`runFullEnrichment`) continua a funzionare quando c'è un LLM provider configurato — fa tutto da solo internamente. Il flusso `enrich:prepare` → agent → `enrich:merge` è il path MANUALE (senza provider), dove l'agent umano o IA fa da LLM. I due flussi condividono lo stesso `merge.ts`, `apply.ts`, `finalize.ts`.

---

## Riepilogo decisionale

| Domanda | Risposta |
|---------|----------|
| Si possono creare tutti i batch insieme? | **No** — dipendenze a catena (Step 2 richiede output Step 1, etc.) |
| L'unico batch creabile "upfront"? | **Step 1** (descriptions) — dipende solo da `candidates.json` + source code |
| Serve un nuovo comando CLI? | **Sì** — `enrich:prepare <step>` |
| Dove vanno i file temporanei? | `reponova-out/.enrich/input/` e `reponova-out/.enrich/output/` |
| Chi pulisce? | `enrich:finalize` cancella `.enrich/` (o almeno `input/` e `output/`) |
| Il flusso automatico (con provider) cambia? | **No** — l'orchestrator continua a funzionare invariato |
