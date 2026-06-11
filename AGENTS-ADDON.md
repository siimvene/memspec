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

If the `memspec` command is not found (not on PATH) and no `memspec_*` MCP tools are available,
the CLI is still usable: it is a Node tool — run `npm link` in the memspec checkout to expose
`memspec`/`memspec-mcp`, or invoke it directly as `node <memspec-repo>/dist/cli.js <command>`.
Do not conclude the tool is missing without checking these.

### Retrieve before assuming
Before acting on an assumption about how this project works, search memspec. This applies to:
- **Operational knowledge** — deploy steps, server addresses, credential paths, established workflows
- **Architectural decisions** — tech stack choices, API design patterns, component boundaries, data models
- **Project conventions** — naming, file structure, testing strategy, code style rationale

Run `memspec search <topic>` before falling back to inference from repo structure or generic heuristics.
A recorded decision, fact, or procedure outweighs what the codebase appears to suggest — the memory captures *why*, the code only shows *what*.

### When to write memories
After these events, write or correct memories immediately — don't defer to session end:
- **Fixed a bug** → write/correct the relevant `fact` about how the system works
- **Changed architecture or configuration** → correct stale `decision`/`fact`, write new ones
- **Established a workflow** (deploy, test, debug sequence) → write a `procedure`
- **Discovered something non-obvious** about the codebase → write a `fact`
- **Made a design choice** between alternatives → write a `decision` with rationale

Use `memspec add <type> "<title>" --body "<content>" --source <agent> --tags <tags>`.
`--source` is required and may not be "unknown" — identify yourself.
Use `memspec correct <id> --reason "<why>" --replace "<new content>" [--title "<new title>"]`
for stale memories; the reason is persisted on both records, so make it one a future agent
can act on. If the corrected content no longer fits the old title, pass `--title`.
To merge a duplicate into an existing memory instead of minting a new one:
`memspec correct <dup-id> --reason "duplicate of <id>" --supersede-by <id>`.

### Code-anchored verification
Facts about code state ("auth is a mockup", "the app has 7 screens") go stale the moment
the code changes — calendar decay fires too late. Anchor them to the files they describe:
- After writing a code-state `fact`, run `memspec anchor <id> <files...>` to link it to its source files.
- After committing changes, run `memspec reconcile` — it lists memories whose anchored files changed.
- Resolve each candidate: `memspec verify <id>` (still true), `memspec correct <id> --reason ... --replace ...`
  (now wrong), or `memspec anchor <id> <files...>` (still true against the new code; re-baseline).
- When you re-confirm any memory is still accurate, record it with `memspec verify <id>` — this refreshes
  its freshness signal and resets the decay clock. Re-verification that isn't recorded is invisible.
- Verifying a memory with no anchors requires `--evidence "what you checked"`. A bare self-verify
  is rejected — state the evidence or anchor the memory.

### Flags are work orders
- A search result or status entry marked **stale**: the TTL passed without re-verification.
  Re-check it against the world before relying on it, then `memspec verify` (with evidence)
  or `memspec correct` it. Stale items are never auto-deleted; resolving the flag is your job.
- A verify that returns **needs_review** (anchor drift, or "anchor in repo X, fetch to verify"):
  read the changed files, then verify, correct, or re-anchor. The memory is left untouched
  until you act.
- A record with `source_kind: operator` is operator-stated knowledge. Correcting it requires
  `--override-operator` — use it only with explicit cause, and say so in the reason.
- Physical removal is `memspec sweep`, an operator-run CLI command. Don't try to delete
  memories yourself; flag them via correction instead.

### Memory hygiene
- **Search before adding.** Run `memspec search <topic>` first. If a similar memory exists and is wrong,
  `memspec correct` it; if it exists and is right, `memspec verify` it — don't add a duplicate.
- **Don't ask permission** to write, correct, verify, or decay memories. Memory upkeep is the agent's job;
  asking is friction. The bar is: would a future agent starting cold benefit?
- **Run `memspec status` periodically** and review stale and anchor-drifted items it reports.

### Guidelines
- Only write knowledge that helps a future agent starting cold. No session transcripts.
- If the store is thin, persist stable facts and decisions you discover while scanning the repo.
- If you discover memory drift, correct the stale memory — don't leave both versions active.
- Never store secrets in memory files.
- When classifying, ask: does a future agent need this to understand *why* (decision), to *do something* (procedure), or to know *what's true* (fact)?
```
