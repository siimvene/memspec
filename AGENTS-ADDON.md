# Memspec Agent Contract

Add this block to the repo's `AGENTS.md`, `CLAUDE.md`, or equivalent instruction file if `memspec init` cannot patch it automatically.

```markdown
## Memory (Memspec)

This project uses Memspec for structured memory. `.memspec/` is the canonical store for durable project knowledge.
Memspec is agent-operated, not human-curated with agent access.

### On session start
In Claude Code (and any harness supporting `SessionStart` hooks), the relevant active memories
are auto-injected at session start via `memspec context` — you should already see them.
As a fallback, run `memspec search` for context relevant to the task. Prefer active memories
over stale assumptions.

### Before answering operational questions
When your next action requires project-specific operational knowledge — how to deploy, where services run, server addresses, credential paths, established workflows — search memspec first.
Run `memspec search <topic>` (e.g. `memspec search deploy`, `memspec search server`) before falling back to generic pattern-matching (Dockerfile, CI configs, Makefile).
The memory store is the documented answer; the repo scan is the guess. Never skip this step even if you believe you can infer the answer from repo structure.

### When to write memories
After these events, write or correct memories immediately — don't defer to session end:
- **Fixed a bug** → write/correct the relevant `fact` about how the system works
- **Changed architecture or configuration** → correct stale `decision`/`fact`, write new ones
- **Established a workflow** (deploy, test, debug sequence) → write a `procedure`
- **Discovered something non-obvious** about the codebase → write a `fact`
- **Made a design choice** between alternatives → write a `decision` with rationale

Use `memspec add <type> "<title>" --body "<content>" --source <agent> --tags <tags>`.
Use `memspec correct <id> --reason "<why>" --replace "<new content>"` for stale memories.

### Guidelines
- Only write knowledge that helps a future agent starting cold. No session transcripts.
- If the store is thin, persist stable facts and decisions you discover while scanning the repo.
- If you discover memory drift, correct the stale memory — don't leave both versions active.
- Never store secrets in memory files.
- When classifying, ask: does a future agent need this to understand *why* (decision), to *do something* (procedure), or to know *what's true* (fact)?
```
