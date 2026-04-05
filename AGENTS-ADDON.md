# Memspec Agent Contract

Add this block to the repo's `AGENTS.md`, `CLAUDE.md`, or equivalent instruction file if `memspec init` cannot patch it automatically.

```markdown
## Memory (Memspec)

This project uses Memspec for structured memory. `.memspec/` is the canonical store for durable project knowledge.
Memspec is agent-operated, not human-curated with agent access.

### On session start
Run `memspec search` for context relevant to the task. Prefer active memories over stale assumptions.

### When to write memories
After these events, write or correct memories immediately — don't defer to session end:
- **Fixed a bug** → write/correct the relevant `fact` about how the system works
- **Changed architecture or configuration** → correct stale `decision`/`fact`, write new ones
- **Established a workflow** (deploy, test, debug sequence) → write a `procedure`
- **Discovered something non-obvious** about the codebase → write a `fact`
- **Made a design choice** between alternatives → write a `decision` with rationale

Use `memspec add <type> "<title>" --body "<content>" --source <agent> --tags <tags>`.
Use `memspec correct <id> --reason "<why>" --replace "<new content>"` for stale memories.

### Rules
- Only write knowledge that helps a future agent starting cold. No session transcripts.
- If the store is thin, persist stable facts and decisions you discover while scanning the repo.
- If you discover memory drift, correct the stale memory — don't leave both versions active.
- Never store secrets in memory files.
```
