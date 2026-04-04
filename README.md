# Memspec

Portable, file-canonical memory for AI agents.

## The Problem

AI coding agents wake up with amnesia. Every session starts cold — no memory of what was decided, what failed, what the project's tribal knowledge says. Teams solve this with scattered markdown files, prompt stuffing, or bespoke database-backed memory services that create vendor lock-in and operational overhead.

The result: agents re-discover the same facts, repeat the same mistakes, and can't build on prior work. Humans waste time re-explaining context that should persist.

Existing solutions fall into two camps:

- **File-based** (MEMORY.md, daily logs): Human-readable and git-friendly, but retrieval is primitive grep. No lifecycle, no decay, no self-correction. Knowledge rots silently.
- **Service-based** (hosted memory APIs, vector DBs): Better retrieval, but require infrastructure, accounts, API keys, and trust in a third-party data store. Not portable across tools.

## What Memspec Does

Memspec is a **specification and CLI** for managing living project knowledge. It keeps markdown files under `.memspec/` as the canonical source of truth, then layers structured lifecycle management, full-text search, and an MCP server on top.

```
Any agent (CLI, MCP, or direct file I/O)
    │
    │  write observations
    │  query for context
    │  signal corrections
    ▼
┌──────────────────────────────────┐
│       Memspec Convention         │
│   Types · Lifecycle · Retrieval  │
├──────────────────────────────────┤
│      Markdown Files (git)        │  ← canonical source of truth
├──────────────────────────────────┤
│   SQLite FTS5 Derived Index      │  ← rebuildable, one-directional
│   + Optional Embeddings          │
└──────────────────────────────────┘
```

No daemon. No backend service. No database-owned state.

### Design Principles

- **Files are truth.** The derived index is disposable and rebuildable from files. If the index disappears, you lose speed, not data.
- **Three memory types.** Facts, decisions, and procedures. That's the universal vocabulary every agent understands. Richer categorization uses the extension model, not new core types.
- **Self-correction over curation.** When knowledge goes stale, agents signal corrections — the old memory is superseded, the new one takes its place, and the evolution is traceable in git history. No human review queue.
- **Decay is a feature.** Every memory has a TTL. Facts go stale as code changes. Procedures drift as tooling evolves. Forcing re-verification keeps memory honest.
- **Zero-infrastructure default.** `npm install` and `memspec init` — that's it. No accounts, no API keys, no hosted services. Works offline, works on any platform Node runs on.

## Memory Types

| Type | What it captures | Examples |
|------|-----------------|---------|
| **fact** | Verified project state | "Auth uses JWT with 15min expiry", "DB is Postgres 16" |
| **decision** | A choice with context and rationale | "Chose REST over GraphQL for client simplicity" |
| **procedure** | A reusable workflow or process | "Deploy: run tests, build, push, verify health" |

Observations that don't fit these types stay as raw observations until they do, or they decay.

## Memory Lifecycle

```
observe → classify → [active] → decay → archive
                        ↑            │
                        │ correction  │
                        └─────────────┘
```

- **captured** → raw observation, not yet classified
- **active** → classified, available for retrieval, ranked by confidence
- **corrected** → superseded by newer knowledge, pointer to replacement preserved
- **decayed** → TTL expired, removed from active retrieval
- **archived** → retained in git history only

No transition requires human approval. Corrections create new memories and link back to what they replaced. The full evolution is in git.

### Default TTLs

| Type | Default TTL |
|------|-------------|
| fact | 90 days |
| decision | 180 days |
| procedure | 90 days |
| observation | 7 days |

Per-item overrides via `decay_after` in frontmatter. Use `never` for genuinely permanent knowledge.

## Install

```bash
npm install -g memspec
```

Or clone and link locally:

```bash
git clone https://github.com/siimvene/memspec.git
cd memspec
npm install && npm run build
npm link
```

## Quickstart

```bash
# Initialize a memory store in your project.
# Interactive mode lets you choose search engine:
#   FTS5 only (default, zero-setup)
#   Hybrid with OpenAI-compatible embeddings
#   Hybrid with Ollama local embeddings
memspec init

# Add memories
memspec add fact "API uses JWT" \
  --body "JWT with 15min expiry and refresh tokens" \
  --source therin --tags auth,api

memspec add decision "REST over GraphQL" \
  --body "REST for simplicity — most consumers are CLI tools" \
  --source siim --decay-after never

memspec add procedure "Deploy bot" \
  --body "SSH to server, git pull, pm2 restart" \
  --source therin --tags deploy

# Search
memspec search "auth"
memspec search "deploy" --type procedure --json

# Correct stale knowledge
memspec correct ms_01HXK... --reason "Migrated to OAuth" \
  --replace "Now uses OAuth2 with PKCE"

# Maintenance
memspec status
memspec validate
memspec decay --dry-run
```

## Search

Two modes, configured at `memspec init`:

- **FTS5** (default) — SQLite full-text search with BM25 ranking, porter stemming, and phrase bonus. Zero setup, zero dependencies beyond `better-sqlite3`.
- **Hybrid** — FTS5 candidate retrieval plus embeddings reranking. Supports OpenAI-compatible endpoints and Ollama. Configured interactively or via CLI flags.

Search always operates over the derived index, which is rebuilt from files on demand. If the index is missing, it rebuilds automatically.

## MCP Server

Memspec ships an MCP server for integration with Claude Code, Cursor, Codex, and any MCP-compatible tool:

```bash
# Start stdio MCP server in current project
memspec-mcp

# Pin to a specific project root
memspec-mcp --cwd /path/to/project
```

Exposed tools: `memspec_init`, `memspec_add`, `memspec_search`, `memspec_status`, `memspec_validate`

## Store Layout

```
.memspec/
  observations/        # Raw, unclassified
  memory/
    facts/             # Active facts
    decisions/         # Active decisions
    procedures/        # Active procedures
  archive/             # Corrected, decayed, archived items
  config.yaml          # Search engine, embeddings, decay rules
```

Each memory is a markdown file with YAML frontmatter (id, type, state, confidence, source, tags, timestamps, decay rules). Human-readable, git-diffable, greppable.

## CLI Reference

| Command | Description |
|---------|-------------|
| `memspec init` | Create `.memspec/` and configure search engine |
| `memspec add <type> <title>` | Add a fact, decision, or procedure |
| `memspec search <query>` | Search active memories |
| `memspec correct <id> --reason "..."` | Correct or invalidate a memory |
| `memspec status` | Store summary (counts, decay warnings, recent items) |
| `memspec decay [--dry-run] [--archive]` | Apply TTL rules to expired items |
| `memspec validate` | Check all memory files against schema |

## For Agent Authors

Copy this into your agent's system prompt or `AGENTS.md`:

```markdown
## Memory (Memspec)

This project uses Memspec for structured memory. Memory lives in `.memspec/`.

### When to Recall
Before answering questions about prior work, project state, or past decisions:
1. Run `memspec search "<query>"`
2. Prefer active memories over archive history
3. If search returns nothing, say so — don't fabricate from stale context

### When to Write
- `memspec add fact "<title>" --body "<content>" --source <agent> --tags tag1,tag2`
- `memspec add decision "<title>" --body "<content>" --source <agent> --decay-after never`
- `memspec add procedure "<title>" --body "<content>" --source <agent>`

### When to Correct
- `memspec correct <id> --reason "<why>"`
- `memspec correct <id> --reason "<why>" --replace "<new content>"`

### Rules
- `.memspec/` files are canonical. The index is derived and disposable.
- Use only `fact`, `decision`, and `procedure` as core types.
- Never store secrets in memory files.
- Don't delete stale knowledge silently — correct or decay it.
```

## What's Planned

- Retrieval profiles with token budgeting and context-aware ranking
- Automatic observation classification (rule-based + optional LLM)
- Extension model for domain-specific metadata without breaking core types

## License

MIT
