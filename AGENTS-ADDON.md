# Memspec As An `AGENTS.md` Addon

The fastest way to adopt Memspec is not a daemon, a database, or a search layer.

It is a prompt convention.

If an agent already reads `AGENTS.md` at session start, Memspec can begin as a section inside that file that tells the agent:

- where memory files live
- which types exist
- when to create or update them
- how correction works

This gets most of the value immediately.

## Why This Matters

A memory convention that requires new infrastructure before anyone can use it has a high adoption barrier.

A memory convention that fits inside `AGENTS.md` can be adopted tomorrow by:

- Codex
- Claude Code
- OpenClaw
- Cursor-based agent workflows
- humans following the same rules manually

## What Works Well In Prompt-Only Mode

These parts of Memspec can live entirely inside instructions:

- directory layout
- file naming convention
- frontmatter schema
- type definitions
- classification rules
- correction protocol
- retrieval guidance at session start

Example:

```md
## Memory Format

Persist durable knowledge in `.memspec/`.

Use only these types:
- `fact` for verified current state
- `decision` for choices and rationale
- `procedure` for repeatable workflows

Before creating a new memory:
1. Search existing memory for overlap
2. Update instead of duplicating when possible
3. If correcting an item, mark the old one corrected and link the replacement

At session start:
1. Load relevant active memories for the current task
2. Prefer active items over archived history
3. Treat memory files as canonical; any index is derived
```

That is already enough to improve consistency across agents.

## Ceiling Of Prompt-Only Adoption

Prompt instructions alone do not solve:

- semantic retrieval across many files
- automatic TTL/decay enforcement
- correction recurrence tracking
- stale memory detection at scale
- ranking by confidence/recency across a large store
- derived indexes and viewers

So prompt-only Memspec is real, but incomplete.

## Practical Two-Tier Model

### Tier 1: Convention-Only

Ship Memspec as an `AGENTS.md` addon.

Outcome:

- immediate adoption
- zero dependencies
- portable across agent runtimes
- works in git-backed repos today

### Tier 2: Runtime-Assisted

Add optional tooling later:

- watcher/indexer
- search layer
- decay worker
- correction analytics
- UI/timeline/review queue

Outcome:

- better retrieval
- less manual drift
- higher scale

## Recommendation

Design Memspec so Tier 1 stands on its own.

That means:

- the spec must be useful without code
- the file format must be sufficient as a source of truth
- the agent instructions must be concrete enough to follow manually

Then treat runtimes, indexes, and daemons as accelerators, not prerequisites.

If Memspec cannot function as an `AGENTS.md` addon, it is probably too heavy for broad adoption.
