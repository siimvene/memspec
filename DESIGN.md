# Memspec — Design

## Overview

Memspec is a methodology for managing living project knowledge — the tribal memory that accumulates as a codebase evolves. It defines how knowledge is captured, how it stays current through self-correction, and how any agent starting cold can load the current state of the project.

The reference implementation uses markdown files in a git repository.

```
Any agent (read/write files or MCP)
    |
    |  write observations
    |  query for context
    |  signal corrections
    v
+----------------------------------+
|        Memspec Convention        |
|   Types · Lifecycle · Retrieval  |
+----------------------------------+
|       Markdown Files (git)       |  ← canonical source of truth
+----------------------------------+
|    Optional: Derived Index       |  ← rebuildable, one-directional
|    (SQLite + vector search)      |
+----------------------------------+
```

## Memory Types

Three types. An agent writes raw observations; the system classifies into one of these.

| Type | Description | Examples |
|------|-------------|---------|
| **fact** | A verified piece of information | "Auth uses JWT with 15min expiry", "DB is Postgres 16" |
| **decision** | A choice that was made, with context | "Chose REST over GraphQL because of client simplicity" |
| **procedure** | A reusable workflow or process | "Deploy sequence: run tests, build, push, verify health" |

That's it. Observations that don't fit these types stay as raw observations until they do, or they decay.

## Memory Lifecycle

```
observe → classify → [active] → decay → archive
                        ↑            |
                        | correction  |
                        +─────────────+
```

### States

- **captured**: Raw observation, not yet classified
- **active**: Classified and available for retrieval. Confidence score determines retrieval weight.
- **corrected**: An agent or human signaled this memory led to wrong behavior. Superseded by the correction.
- **decayed**: TTL expired or relevance dropped. Removed from active retrieval.
- **archived**: Retained in git history only. Not returned unless explicitly requested.

No "reviewed" state. No human gate. Classification is automatic — rule-based with optional LLM enhancement.

## Self-Correction

This is the core mechanism that keeps memory current as the codebase evolves. Architecture changes, components get replaced, configuration shifts, principles get revised. The memory must reflect these changes automatically.

When a memory becomes stale or wrong:

1. Agent or human signals a correction: "this is no longer true" or "this led to wrong behavior"
2. The correction becomes a new memory capturing the current state
3. The original is marked `corrected` with a pointer to the replacement
4. Both retained in git history — the evolution is traceable
5. Correction patterns feed back into classification confidence

The result: the active memory store always reflects what's true *now*. An agent starting a fresh session loads current project state, not historical artifacts. Git history preserves the full evolution for anyone who needs it.

No review queue. No human approval. The system learns from corrections the same way a team's tribal knowledge updates when someone says "actually, we don't do it that way anymore."

## Markdown Schema

Each memory is a markdown file with frontmatter:

```markdown
---
id: ms_01HXK...
type: fact
state: active
confidence: 0.9
source: claude-code
created: 2026-04-04T10:30:00Z
decay_after: 2026-07-04T00:00:00Z
tags: [auth, api]
---

# API auth uses JWT with short-lived tokens

JWT with 15-minute expiry + refresh tokens. Chosen over session-based auth
because API supports multiple client types (web, CLI, agent).
```

### Required frontmatter
- `id`: Unique identifier
- `type`: fact | decision | procedure
- `state`: captured | active | corrected | decayed | archived
- `created`: ISO timestamp

### Optional frontmatter
- `confidence`: 0.0–1.0, affects retrieval ranking
- `source`: Which agent/human created this
- `decay_after`: When to remove from active retrieval
- `tags`: For filtering
- `corrects`: ID of memory this corrects
- `corrected_by`: ID of memory that corrected this

## Storage Layout

```
.memspec/
  observations/           # Raw, unclassified
    2026-04-04/
      ms_01HXK....md
  memory/                 # Active, classified
    facts/
    decisions/
    procedures/
  archive/                # Decayed/corrected items
  config.yaml             # Retrieval profiles, decay rules
```

Lives in the project repo. Multiple agents read/write to the same directory. Git handles history and conflict resolution.

## Retrieval

Retrieval returns context-appropriate memories, not raw search results.

### Without an index (baseline)
- Scan active memory files
- Filter by type and tags
- Rank by recency and confidence
- Truncate to token budget

This is grep-over-markdown. It works. It's slow on large memory stores but functional.

### With a derived index (enhanced)
- SQLite for metadata queries + vector store for semantic search
- Index rebuilds from files on demand (one-directional: files → index)
- If the index is missing or stale, fall back to file scan
- The index never writes back to files

### Retrieval Profiles

Different contexts need different memory:

```yaml
# config.yaml
profiles:
  default:
    max_tokens: 2000
    types: [fact, decision, procedure]
    min_confidence: 0.7
    ranking:
      recency: 0.3
      relevance: 0.4
      confidence: 0.3

  incident:
    max_tokens: 1500
    types: [fact, procedure]
    min_confidence: 0.5
    ranking:
      recency: 0.5
      relevance: 0.3
      confidence: 0.2
```

## Classification

When an agent writes a raw observation:

1. **Rule-based**: Pattern match ("decided to..." → decision, "steps to..." → procedure)
2. **LLM-enhanced** (optional): Type assignment, confidence scoring, tag extraction
3. **Dedup**: Check semantic similarity against recent memories
4. **Promote**: Move to active memory with confidence score

If no LLM is available, rule-based classification still works. Items that can't be classified stay as observations and decay on a shorter TTL.

## Integration

### Minimum viable (any agent)
Agent reads/writes markdown files in `.memspec/`. That's it. No server, no API, no dependencies.

### MCP server (enhanced)
Optional MCP server for agents that support it:
- `memspec.observe` — submit observation
- `memspec.query` — context-aware retrieval
- `memspec.correct` — signal a memory is wrong
- `memspec.search` — raw search

### File watch (automatic capture)
Optional watcher that picks up file changes and triggers classification. Not required — classification can also run on a schedule or on query.

## What This Is Not

- Not a database. Files are the source of truth.
- Not a platform. No hosted service required.
- Not a product. It's a methodology with a reference implementation.
- Not coupled to any agent runtime. Works with anything that can read/write files.

## Open Questions

- Optimal decay TTL defaults per type?
- How to measure if a retrieved memory was actually useful to the agent?
- Best approach for cross-project memory (shared facts vs project-scoped)?
- Reference implementation language (leaning toward TypeScript for MCP ecosystem fit)?
