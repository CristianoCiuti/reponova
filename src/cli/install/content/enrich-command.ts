/**
 * Enrich command workflow — loaded ONLY when user explicitly requests enrichment.
 * This is the full multi-step workflow where the agent acts as the LLM.
 * Raw body content — IDE-specific frontmatter/wrapping is added by each target.
 */
export const ENRICH_COMMAND_MD = `# reponova enrich

Intelligent enrichment workflow — you are the LLM that reads structured input batches, reasons about architectural placement, and writes output batches that CLI commands merge and apply.

## Quick Reference

| Step | Type | Command / Action |
|------|------|-----------------|
| Pre | CLI | \`reponova build --target communities\` |
| Check | CLI | \`reponova build --check enrich\` (exit 0 = done) |
| 0 | CLI | \`reponova enrich:metrics\` |
| 1 | CLI | \`reponova enrich:prepare descriptions\` |
| 1 | YOU | Read \`.enrich/input/descriptions/\` → write \`.enrich/output/descriptions/batch-NNN.json\` |
| 1 | CLI | \`reponova enrich:merge descriptions\` |
| 2 | CLI | \`reponova enrich:prepare profiles\` |
| 2 | YOU | Read \`.enrich/input/profiles/\` → write \`.enrich/output/profiles/community-NNN.json\` |
| 2 | CLI | \`reponova enrich:merge profiles\` |
| 3 | CLI | \`reponova enrich:prepare routing\` |
| 3 | YOU | Read \`.enrich/input/routing/\` → write \`.enrich/output/routing/batch-NNN.json\` |
| 3 | CLI | \`reponova enrich:merge routing\` |
| 4 | CLI | \`reponova enrich:prepare restructure\` |
| 4 | YOU | Read \`.enrich/input/restructure/\` → write \`.enrich/output/restructure/restructure.json\` |
| 5 | CLI | \`reponova enrich:apply\` |
| 6 | CLI | \`reponova enrich:prepare updated-profiles\` |
| 6 | YOU | Read \`.enrich/input/updated-profiles/\` → write \`.enrich/output/updated-profiles/community-NNN.json\` |
| 6 | CLI | \`reponova enrich:merge updated-profiles\` |
| 7 | CLI | \`reponova enrich:finalize\` |
| 8 | CLI | \`reponova cache --target enrich\` then \`reponova build --start-after enrich\` |

## Flow

Each enrichment step follows the same pattern:

1. **Prepare** (CLI): \`reponova enrich:prepare <step>\` — creates structured input batches in \`.enrich/input/<step>/\`
2. **Process** (YOU): Read input batches, reason, write results to \`.enrich/output/<step>/\`
3. **Merge** (CLI): \`reponova enrich:merge <step>\` — concatenates output batches into \`.enrich/<step>.json\`

You NEVER need to invent file paths or read raw source code directly. All context is pre-assembled in the input batches.

## Detailed Steps

### Step 1: Node Descriptions

**Input**: \`.enrich/input/descriptions/batch-NNN.json\` — each file contains:
\`\`\`json
{"batchId": 1, "totalBatches": 5, "items": [{"nodeId": "...", "qualifiedName": "...", "filePath": "...", "code": "..."}]}
\`\`\`

**Your job**: For each item, read the code and write a 1-2 sentence description of what it does architecturally.

**Output** (\`.enrich/output/descriptions/batch-NNN.json\`):
\`\`\`json
[{"id": "qualified_name", "description": "Authenticates users by validating credentials against the database."}]
\`\`\`

### Step 2: Community Profiling

**Input**: \`.enrich/input/profiles/community-NNN.json\` — each file contains:
\`\`\`json
{"communityId": "auth", "members": [{"id": "...", "description": "..."}], "internalEdges": [...]}
\`\`\`

**Your job**: Analyze the community's members and edges. Produce a profile.

**Output** (\`.enrich/output/profiles/community-NNN.json\`):
\`\`\`json
{"communityId": "auth", "label": "Authentication Services", "profile": "Manages user identity verification and token issuance.", "misfits": [{"nodeId": "utils.hash", "reason": "Generic utility, not auth-specific"}]}
\`\`\`

### Step 3: Candidate Routing

**Input**: \`.enrich/input/routing/batch-NNN.json\` — each file contains:
\`\`\`json
{"batchId": 1, "totalBatches": 3, "candidates": [{"nodeId": "...", "description": "...", "currentCommunity": "...", "currentCommunityProfile": "...", "adjacentCommunities": [{"id": "...", "edgeCount": 5, "profile": "..."}]}]}
\`\`\`

**Your job**: For each candidate, decide STAY or MOVE based on its description and community profiles.

**Output** (\`.enrich/output/routing/batch-NNN.json\`):
\`\`\`json
[{"node": "utils.hash", "action": "move", "to": "data", "reason": "Used exclusively by database layer"}]
\`\`\`

### Step 4: Restructure Detection

**Input**: \`.enrich/input/restructure/restructure-input.json\` — single file with full context:
\`\`\`json
{"profiles": [...], "topEdgeDensityPairs": [...], "gainedNodes": {...}, "sizeOutliers": [...]}
\`\`\`

**Your job**: Propose merges (tightly coupled community pairs) and splits (oversized/incoherent clusters).

**Output** (\`.enrich/output/restructure/restructure.json\`):
\`\`\`json
{"merges": [], "splits": []}
\`\`\`

### Step 6: Updated Profiles

Same as Step 2. Input/output use the same format but are in \`.enrich/input/updated-profiles/\` and \`.enrich/output/updated-profiles/\`.

## Rules

- **SKIP** any step whose final merged file already exists (e.g., skip Step 1 if \`.enrich/descriptions.json\` exists).
- **NEVER** modify \`graph.json\` — it is immutable after the communities phase.
- **ALWAYS** seal the cache at the end: \`reponova cache --target enrich\`.
- **ALWAYS** run \`reponova enrich:prepare <step>\` BEFORE processing that step.
- Output batch file naming MUST match input batch file naming (same \`batch-NNN.json\` or \`community-NNN.json\` pattern).
- If a step has no work (e.g., no modified communities in Step 6), write an empty array to the final file.
- You read from \`.enrich/input/<step>/\`, you write to \`.enrich/output/<step>/\`. Never invent other paths.
`;
