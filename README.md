# Memspec

Portable, file-canonical memory for AI agents.

## What's new in v0.4

v0.4 ("graph primitives") makes typed relations first-class: every record can
carry optional `refines`, `supports`, and `depends_on` edges alongside the
existing supersede/conflict edges. New `memspec_relate` wires edges after the
fact, `memspec_export` dumps the graph as JSONL / GraphML / DOT, operator-tier
records segregate on disk under `memory/operator/`, and the v0.3 deprecation
shims (`memspec_add`, `memspec_correct`, plus the deprecated CLI commands) are
gone. `memspec migrate` hops v0.2 or v0.3 stores straight to v0.4 in one pass.
See [MIGRATION-v0.3.md](MIGRATION-v0.3.md) for the upgrade path and
[CHANGELOG.md](CHANGELOG.md) for the full list of changes.

v0.3 ("witnessed claims") replaced confidence scores with evidence: every claim
carries how it was last witnessed (`anchor`, `operator`, `evidence`, or
`assertion`), conflicts are first-class edges, and the boot context opens with
a "Needs attention" maintenance queue.

## The Problem

AI coding agents wake up with amnesia. Every session starts cold — no memory of what was decided, what failed, what the project's tribal knowledge says. Teams solve this with scattered markdown files, prompt stuffing, or bespoke database-backed memory services that create vendor lock-in and operational overhead.

The result: agents re-discover the same facts, repeat the same mistakes, and can't build on prior work. Humans waste time re-explaining context that should persist.

Existing solutions fall into two camps:

- **File-based** (MEMORY.md, daily logs): Human-readable and git-friendly, but retrieval is primitive grep. No lifecycle, no decay, no self-correction. Knowledge rots silently.
- **Service-based** (hosted memory APIs, vector DBs): Better retrieval, but require infrastructure, accounts, API keys, and trust in a third-party data store. Not portable across tools.

## What Memspec Does

Memspec is a **specification and CLI** for managing living project knowledge. It keeps markdown files under `.memspec/` as the canonical source of truth, then layers structured lifecycle management, full-text search, and an MCP server on top.

For a potential user, the point is simple:

- Keep memory **inside the repo**, not trapped in a vendor backend
- Make it **agent-operated with human oversight**, not human-curated with agent access
- Improve retrieval and hygiene **without introducing a service to babysit**
- Let any tool speak to the same memory through **files, CLI, or MCP**

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

## Why This Shape

Most agent memory systems ask you to adopt their runtime, their database, and their API surface before you get value. That is fine for a product. It is bad for a standard.

Memspec takes the opposite path:

- **The repo owns memory.** Your project can outlive any model, SDK, MCP server, or wrapper.
- **Derived state stays disposable.** Search indexes and embeddings can be rebuilt; the markdown files remain the contract.
- **Interop is optional, not mandatory.** A shell script can read the files, an agent can use the CLI, and Claude/Cursor/Codex can use MCP. Same store, different access paths.
- **Adoption stays low-friction.** `memspec init` gives you working search immediately, and better retrieval is an additive upgrade rather than a platform migration.

That architecture exists for one reason: long-lived project memory should be portable across tools and boring to operate.

### Design Principles

- **Files are truth.** The derived index is disposable and rebuildable from files. If the index disappears, you lose speed, not data.
- **Three memory types.** Facts, decisions, and procedures. That's the universal vocabulary every agent understands. Richer categorization uses the extension model, not new core types.
- **Self-correction over curation.** Agents write, correct, and expire memories autonomously. When knowledge goes stale, the agent supersedes it — the old memory links to the replacement, and the evolution is traceable in git history. No human review queue.
- **Decay is a flag, not a delete.** Every memory has a TTL, but expiry marks it `stale` rather than removing it — stale items stay searchable, carrying the flag so agents re-verify or correct before relying on them. Physical removal is `memspec sweep`, operator-approved, one prompt per item.
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
observe → classify → [active] → stale flag → sweep → archive
                        ↑            │
                        │ correction / verify
                        └─────────────┘
```

- **observation** → point-in-time note with hard expiry, not yet (and maybe never) a claim
- **active** → a live claim, available for retrieval, ranked by witness freshness and usage
- **active + stale** → `check_by` passed; still retrievable, flagged for re-verification or supersession
- **superseded** → replaced by newer knowledge, pointer to replacement and durable reason preserved
- **retired** → removed via operator-run `memspec sweep`; retained in git history

No transition requires human approval. Corrections create new memories and link back to what they replaced. The full evolution is in git.

### Default TTLs

| Type | Default TTL |
|------|-------------|
| fact | 90 days |
| decision | 180 days |
| procedure | 90 days |
| observation | 7 days |

Per-item overrides via `check_by` in frontmatter. Use `never` for genuinely permanent knowledge.

### Code-anchored verification

Calendar TTL is the wrong signal for facts about code state — "auth is a mockup" goes stale
the moment the auth implementation ships, not 90 days later. Memspec closes that gap with
three operations:

- **`memspec anchor <id> <files...>`** links a memory to the files it depends on, recording
  each file's git blob SHA in the `anchors` frontmatter field. Anchoring asserts the memory is
  true against the current file state.
- **`memspec verify <id>`** records "this memory is still true as of now." If the memory has
  anchors, each anchored file is checked first — drifted anchors return `needs_review` without
  touching the memory. Anchorless memories require `--evidence "what you checked"`; a bare
  self-verify is rejected. A clean verify refreshes `last_verified`, records the witness in
  `verified_with`, resets the `check_by` clock, and clears any stale flag.
  Anchors may reference files in another repo (`repo` field on the anchor); if that repo isn't
  checked out next to the project (or under `anchors.repo_search_paths` in `config.yaml`),
  verify flags the memory for review instead of failing.
- **`memspec reconcile`** scans all anchored memories for drift (including uncommitted edits)
  and reports candidates for review. Run it after landing commits; resolve each candidate with
  `verify` (still true), `supersede` (now wrong), or `anchor` (still true, re-baseline).

`memspec status` and the boot context's "Needs attention" section surface anchor drift
alongside stale flags, but drifted memories are never auto-archived — code change is a signal
for review, not deletion.

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

## How It Works

**Memspec is agent-operated.** The human runs one command — `memspec init` — to set up the store. After that, the agent reads, writes, corrects, and maintains memory autonomously through CLI commands, MCP tools, or direct file I/O.

The human's role is oversight, not curation: review what the agent captured in git diffs, override when needed, and trust the lifecycle to handle staleness.

### Human: one-time setup

```bash
memspec init
# Interactive prompt: choose FTS5 (default) or hybrid with embeddings
# Creates .memspec/ in your project root
# Detects brownfield memory sources like MEMORY.md and memory/
# Patches AGENTS.md or CLAUDE.md so the agent knows to use Memspec
# Done. The agent takes it from here.
```

`init` is intentionally more than scaffolding. On a brownfield repo, it should leave you with a usable memory store, not an empty directory and more setup work.

### Brownfield categorization

When `init` imports existing memory, the categorization is conservative:

- current project state, architecture, and configuration become `fact`
- choices with rationale become `decision`
- reusable workflows and runbooks become `procedure`
- ambiguous notes stay as observations until the agent can classify them safely

The goal is not perfect first-pass extraction. The goal is a correct-enough starting store that the agent can improve through normal work.

### Agent: ongoing operation

The agent uses these commands (via shell, MCP, or programmatic access) as part of its normal workflow:

```bash
# Learn something → write it down
memspec remember fact "API uses JWT" \
  --body "JWT with 15min expiry and refresh tokens" \
  --source agent --tags auth,api

memspec remember decision "REST over GraphQL" \
  --body "REST for simplicity — most consumers are CLI tools" \
  --source agent --check-by never

# A claim about code? Anchor it in the same call.
memspec remember fact "Auth is still a mockup" \
  --body "login() returns a hardcoded session" \
  --source agent --anchor src/auth/login.ts

# Need context → search for it
memspec search "auth"
memspec search "deploy" --type procedure --json

# Knowledge is stale → supersede it (the reason is persisted on every record involved)
memspec supersede ms_01HXK... --reason "Migrated to OAuth" \
  --body "Now uses OAuth2 with PKCE" \
  --title "Auth uses OAuth2 PKCE"

# Found duplicates → merge them into the survivor instead of minting a third copy
memspec supersede ms_01HXK... --reason "Duplicates of the surviving claim" \
  --merge-from ms_01HXJ...,ms_01HXI...

# Still true → say how you know (required when the memory has no code anchors)
memspec verify ms_01HXK... --evidence "checked src/auth/oauth.ts, PKCE flow present"

# Housekeeping readout (schema check, stale flags, drift, conflicts, sweep candidates)
memspec status
```

`--source` is required on `remember` (the MCP server defaults it to the connected client name), and
superseding an operator-sourced record (`source_kind: operator`) requires `--override-operator` —
the override is logged into the persisted reason.

No human in the loop for day-to-day memory operations. The agent decides what to remember, when to search, and when knowledge has gone stale. The human sees the results in git.

## Who It Is For

Use Memspec if you want:

- project memory that survives model swaps and tool churn
- git-visible knowledge instead of hidden prompts or opaque vector stores
- better retrieval than `grep`, without standing up a memory service
- agent-operated memory where you review in git, not curate by hand

It is a bad fit if you want:

- a hosted multi-tenant product with user accounts, dashboards, and org-level administration
- a central memory service that owns the canonical state
- fully automatic long-term memory with no review of what gets captured

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

Exposed tools (v0.4, eleven total): `memspec_search`, `memspec_get`, `memspec_remember`, `memspec_supersede`, `memspec_relate`, `memspec_observe`, `memspec_verify`, `memspec_anchor`, `memspec_reconcile`, `memspec_status`, `memspec_export`. The v0.3 deprecation aliases `memspec_add` and `memspec_correct` were removed in v0.4.

`memspec init`, `memspec sweep`, `memspec stores`, and `memspec migrate` are deliberately CLI-only — store creation and physical removal are operator acts, not an agent surface.

### Host Registration

`memspec init` auto-creates a `.mcp.json` file in the project root for host tool discovery. MCP-compatible tools (Claude Code, Cursor, etc.) read this file to find available servers.

For manual setup or other tools, add to `.mcp.json`:

```json
{
  "mcpServers": {
    "memspec": {
      "command": "memspec-mcp",
      "args": ["--cwd", "/absolute/path/to/project"]
    }
  }
}
```

If `.mcp.json` already exists with other servers, `memspec init` merges its entry without overwriting them.

## Global Store

Memspec supports a global store at `~/.memspec/` for cross-project memory (personal preferences, common patterns, infrastructure knowledge). When both a project store and a global store exist, the project store takes priority and the global store is merged as a lower-priority layer.

Create the global store with:

```bash
memspec init --cwd ~/.memspec
```

## Store Layout

```
.memspec/
  observations/        # Raw, unclassified
  memory/
    facts/             # Active agent-tier facts
    decisions/         # Active agent-tier decisions
    procedures/        # Active agent-tier procedures
    operator/          # v0.4: tier-segregated operator-sourced records
      facts/
      decisions/
      procedures/
  archive/             # Superseded and retired items
  config.yaml          # Search engine, embeddings, decay rules
```

Each memory is a markdown file with YAML frontmatter (id, kind, type, state, source, source_kind, verified_with, tags, timestamps, check_by, anchors). Human-readable, git-diffable, greppable.

## CLI Reference

| Command | Description |
|---------|-------------|
| `memspec init` | Create `.memspec/` and configure search engine |
| `memspec remember <type> <title> --source <who> [--anchor <files...>] [--pin] [--check-by <ts\|never>]` | Record a fact, decision, or procedure (`--source` required; anchors inline; `--pin` is operator-only) |
| `memspec observe <text> [--ttl <dur>]` | Capture a point-in-time observation with hard expiry (default 7d) |
| `memspec search <query>` | Search active memories (stale items are returned flagged) |
| `memspec context [--format] [--query] [--type]` | Emit a token-budgeted memory summary for agent context injection |
| `memspec supersede <id> --reason "..." [--body] [--title] [--merge-from <ids>] [--override-operator]` | Replace, retract, or merge memory; reason persisted on every record involved |
| `memspec relate --from <id> --to <id> --type <refines\|supports\|depends_on\|conflicts_with>` | Wire a typed edge from one memory to another after the fact |
| `memspec verify <id> [--evidence "..."]` | Record that a memory is still true; checks code anchors, requires evidence when anchorless |
| `memspec anchor <id> <files...> [--replace]` | Link a memory to the files it depends on |
| `memspec reconcile [--since <ref>] [--json]` | Find anchored memories whose code has drifted |
| `memspec status` | The single maintenance readout (counts, witness classes, stale flags, anchor drift, conflicts, schema violations, sweep candidates) |
| `memspec sweep [--dry-run]` | Interactively retire stale-flagged items (the only removal path) |
| `memspec export --format <jsonl\|graphml\|dot> [--include-superseded] [--types <list>]` | Export the memory graph (nodes + edges) to stdout |
| `memspec migrate [--apply] [--override source=tier]` | One-shot v0.2/v0.3 → v0.4 store migration (idempotent; dry-run by default) |

## Session-start context injection

The hard part of agent memory is not storage — it's making sure the agent actually reads it.
Telling agents "run `memspec_search` at session start" works in theory and fails in practice:
under task pressure, the instruction gets ignored.

The architectural fix is to stop asking. `memspec init` installs a Claude Code `SessionStart`
hook at `~/.claude/hooks/memspec-session-start.js` that runs `memspec context --format markdown`
and pushes the result into the agent's session-start context automatically. The agent never has
to decide whether to use memspec — the relevant memories are already in the prompt.

```bash
memspec context                  # markdown block for the SessionStart hook
memspec context --format json    # structured array for programmatic consumers
memspec context --query auth     # search-mode, useful for task-aware lookups
memspec context --limit 5        # hard-cap items (hard ceiling is 20)
memspec context --budget 1500    # token budget (default 2000)
```

If you manage hooks manually, pass `--no-install-hooks` to `memspec init`. See
[`hooks/memspec-session-start.js`](hooks/memspec-session-start.js) for the script that
fires on `SessionStart`.

## Memory Consolidation

Agents need triggers to write and maintain memories. Memspec uses two mechanisms:

### 1. Behavioral triggers (agent instructions)

`memspec init` patches your `CLAUDE.md` or `AGENTS.md` with instructions that tie memory writes to observable events:

- **Fixed a bug** → write/correct the relevant `fact`
- **Changed architecture or configuration** → correct stale memories, write new ones
- **Established a workflow** → write a `procedure`
- **Discovered something non-obvious** → write a `fact`
- **Made a design choice** → write a `decision` with rationale

These work regardless of git discipline. The agent writes memories as part of the task, not as a deferred chore.

### 2. Commit hook (Claude Code)

For Claude Code users, a PostToolUse hook triggers a consolidation prompt when the agent commits code. The agent still has full conversation context, so it can write meaningful memories about what it just committed and why.

`memspec init` installs this hook automatically alongside the session-start hook
(pass `--no-install-hooks` to opt out). For manual installation, copy
[`hooks/memspec-consolidate.js`](hooks/memspec-consolidate.js) to `~/.claude/hooks/`
and add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$HOME/.claude/hooks/memspec-consolidate.js\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Configurable in `.memspec/config.yaml`:

```yaml
consolidation:
  trigger: commit    # commit | manual | none
  frequency: once    # once (per session) | always
```

- `commit` + `once` (default): first commit in a session triggers consolidation
- `commit` + `always`: every commit triggers (thorough but noisy)
- `manual`: agent instructions only, no hook enforcement
- `none`: disabled entirely

## For Agent Authors

If `init` cannot patch your repo instructions automatically, copy the block from [AGENTS-ADDON.md](AGENTS-ADDON.md) into `AGENTS.md` or `CLAUDE.md`.

## What's Planned

- Retrieval profiles with token budgeting and context-aware ranking
- Automatic observation classification (rule-based + optional LLM)
- Extension model for domain-specific metadata without breaking core types

## License

MIT
