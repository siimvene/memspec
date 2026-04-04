# Memspec Agent Contract

Add this block to the repo's `AGENTS.md`, `CLAUDE.md`, or equivalent instruction file if `memspec init` cannot patch it automatically.

```markdown
## Memspec

This repository uses Memspec for project memory. `.memspec/` is the canonical store for durable project knowledge.

Before answering questions, planning work, or editing code:
1. Search Memspec for relevant facts, decisions, and procedures.
2. Prefer active memory over stale assumptions.

While working:
1. Write durable project truths back to Memspec as:
   - `fact` for current state or constraints
   - `decision` for choices and rationale
   - `procedure` for repeatable workflows
2. If something is useful but still unclear, record it as an observation instead of forcing a type.
3. If you discover memory drift, correct the stale memory instead of leaving both versions active.

Do not treat Memspec as a chat transcript dump or private scratchpad. It is for durable repo knowledge that should survive agent resets.
```
