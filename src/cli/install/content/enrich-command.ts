/**
 * Enrich command workflow — loaded ONLY when user explicitly requests enrichment.
 * This is the full multi-step workflow where the agent acts as the LLM.
 * Raw body content — IDE-specific frontmatter/wrapping is added by each target.
 */
export const ENRICH_COMMAND_MD = `# reponova enrich

Intelligent enrichment workflow — you are the LLM that reads source code, reasons about architectural placement, and writes intermediate files that CLI commands merge and apply.

## Quick Reference

| Step | Type | Command / Action |
|------|------|-----------------|
| Pre | CLI | \`reponova build --target communities\` |
| Check | CLI | \`reponova build --check enrich\` (exit 0 = done) |
| 0 | CLI | \`reponova enrich:metrics\` |
| 1 | YOU | Read source → write \`.enrich/descriptions/batch-NNN.json\` → \`reponova enrich:merge descriptions\` |
| 2 | YOU | Read descriptions + edges → write \`.enrich/profiles/community-NNN.json\` → \`reponova enrich:merge profiles\` |
| 3 | YOU | Read candidates + profiles → write \`.enrich/routing/batch-NNN.json\` → \`reponova enrich:merge routing\` |
| 4 | YOU | Read profiles + density + routing → write \`.enrich/restructure.json\` |
| 5 | CLI | \`reponova enrich:apply\` |
| 6 | YOU | Read modified list → re-profile → write \`.enrich/updated-profiles/community-NNN.json\` → \`reponova enrich:merge updated-profiles\` |
| 7 | CLI | \`reponova enrich:finalize\` |
| 8 | CLI | \`reponova cache --target enrich\` then \`reponova build --start-after enrich\` |

## Detailed Steps

### Step 1: Node Descriptions

For each node in \`.enrich/candidates.json\`, read its source code (\`source_file\` + \`start_line\`/\`end_line\`) and write a 1-2 sentence description of what it does architecturally.

**Output format** (\`.enrich/descriptions/batch-NNN.json\`):
\`\`\`json
[{"id": "qualified_name", "description": "Authenticates users by validating credentials against the database."}]
\`\`\`

### Step 2: Community Profiling

Group nodes by community. For each community with 3+ members, produce:

**Output format** (\`.enrich/profiles/community-NNN.json\`):
\`\`\`json
{"communityId": "auth", "label": "Authentication Services", "profile": "Manages user identity verification and token issuance.", "misfits": [{"nodeId": "utils.hash", "reason": "Generic utility, not auth-specific"}]}
\`\`\`

### Step 3: Candidate Routing

For each candidate (high boundary-ratio nodes + misfits from Step 2), decide STAY or MOVE:

**Output format** (\`.enrich/routing/batch-NNN.json\`):
\`\`\`json
[{"node": "utils.hash", "action": "move", "to": "data", "reason": "Used exclusively by database layer"}]
\`\`\`

### Step 4: Restructure Detection

Analyze community structure for merges (tightly coupled pairs) and splits (oversized/incoherent clusters):

**Output format** (\`.enrich/restructure.json\`):
\`\`\`json
{"merges": [], "splits": []}
\`\`\`

### Step 6: Updated Profiles

Same as Step 2 but only for communities listed in \`.enrich/modified-communities.json\`.

## Rules

- **SKIP** any step whose final merged file already exists (e.g., skip Step 1 if \`.enrich/descriptions.json\` exists).
- **NEVER** modify \`graph.json\` — it is immutable after the communities phase.
- **ALWAYS** seal the cache at the end: \`reponova cache --target enrich\`.
- Batch file naming: zero-padded 3-digit (\`batch-001.json\`, \`community-001.json\`).
- If a step has no work (e.g., no modified communities in Step 6), write an empty array to the final file.
`;
