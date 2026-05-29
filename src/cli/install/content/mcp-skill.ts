/**
 * MCP tool usage guide — WHEN to use WHICH tool.
 * Parameters are NOT documented here (MCP protocol exposes them automatically).
 * This is the raw body content — IDE-specific frontmatter is added by each target.
 */
export const MCP_SKILL_MD = `# reponova — Knowledge Graph Tools

This project has a knowledge graph MCP server with 11 tools. **Use these instead of grep/find for any structural code question.** MCP auto-exposes tool parameters — this guide tells you WHEN to use each.

## Tool Selection Guide

| Question type | Use this tool | NOT this |
|---------------|--------------|----------|
| "Where is X defined?" / "Find function Y" | \`graph_search\` | grep, find |
| "What depends on X?" / "What breaks if I change X?" | \`graph_impact\` | manual trace |
| "How are A and B connected?" | \`graph_path\` | reading imports manually |
| "Tell me everything about symbol X" | \`graph_explain\` | reading source file |
| "What's in this module/community?" | \`graph_community\` | ls, find |
| "What are the most critical/coupled nodes?" | \`graph_hotspots\` | guessing |
| "Find something similar to X" / conceptual search | \`graph_similar\` | grep (can't do semantic) |
| "Give me full context about topic X" (token-budgeted) | \`graph_context\` | reading multiple files |
| "Find docs about X" | \`graph_docs\` | grep *.md |
| "Show me file structure without reading it" | \`graph_outline\` | cat, head |
| "Is the graph built / up to date?" | \`graph_status\` | ls reponova-out |

## Key Workflows

1. **Before refactoring**: \`graph_impact\` on the target symbol → see upstream/downstream blast radius
2. **Exploring unfamiliar code**: \`graph_search\` with \`context_depth: 2\` → see neighborhood around results
3. **Architecture overview**: Read \`reponova-out/report.md\` or use \`graph_hotspots\` + \`graph_community\`
4. **Tracing a call chain**: \`graph_path\` from A to B → shows exact weighted shortest path
5. **Building context for a task**: \`graph_context\` with your task description → token-budgeted, relevance-ranked context combining text search, vectors, and graph expansion

## Important Notes

- Tool responses include **"Absolute path"** for every file reference — use it to open/edit files directly.
- After code changes, run \`reponova build\` to rebuild (incremental, only processes changed files).
- \`graph_search\` supports \`type\` filter: "function", "class", "module" — use it to narrow results.
- \`graph_impact\` supports fuzzy matching — if exact symbol not found, it suggests alternatives.
`;
