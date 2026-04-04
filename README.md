# Memspec

Portable memory for AI agents.

Memspec keeps markdown files under `.memspec/` as the canonical source of truth, then layers a small CLI and stdio MCP server on top. The goal is boring, inspectable, local-first memory that works across Claude, Cursor, Codex, OpenClaw, or any other tool that can call a CLI or MCP server.

No daemon. No backend service. No database-owned state.

## Why Memspec

- Markdown files are the source of truth.
- Works locally with zero infrastructure.
- Search is useful out of the box: SQLite FTS5, BM25 ranking, stemming, phrase bonus.
- Embeddings are optional and configured at `memspec init` time.
- The same store can be accessed through the CLI or over MCP.

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
# Interactive mode lets you choose:
# - FTS5 only
# - Hybrid search with OpenAI-compatible embeddings
# - Hybrid search with Ollama embeddings
memspec init

# Add memories
memspec add fact "API uses JWT" --body "JWT with 15min expiry and refresh tokens" --source therin --tags auth,api
memspec add decision "REST over GraphQL" --body "REST for simplicity — most consumers are CLI tools" --source siim --decay-after never
memspec add procedure "Deploy bot" --body "SSH to server, git pull, pm2 restart" --source therin --tags deploy

# Search
memspec search "auth"
memspec search "deploy" --type procedure --json

# Check store health
memspec status
memspec validate

# Manage decay
memspec decay --dry-run
memspec decay

# Correct stale knowledge
memspec correct ms_01HXK... --reason "Migrated to OAuth" --replace "Now uses OAuth2 with PKCE"
```

## What You Get

- File-canonical store layout using markdown plus YAML frontmatter
- Seven CLI commands: `init`, `add`, `search`, `correct`, `status`, `decay`, `validate`
- Stdio MCP server: `memspec-mcp`
- FTS5/BM25 search by default
- Optional hybrid search with embeddings from an OpenAI-compatible endpoint or Ollama
- Schema validation and lifecycle transitions
- Correction, decay, archival, and extension metadata support

## Store Layout

```text
.memspec/
  observations/
  memory/
    facts/
    decisions/
    procedures/
  archive/
  config.yaml
```

Active memories live under `memory/`. Corrected, decayed, and archived items live under `archive/`.

## Search Modes

`memspec init` supports two search modes:

- `fts5` - the default, zero-setup mode
- `hybrid` - FTS5 candidate retrieval plus embeddings reranking

Hybrid mode currently supports:

- OpenAI-compatible embeddings endpoints
- Ollama local embeddings endpoints

## MCP Wrapper

```bash
# Start a stdio MCP server in the current project
memspec-mcp

# Or pin it to a project root
memspec-mcp --cwd /path/to/project
```

Exposed MCP tools:

- `memspec_init`
- `memspec_add`
- `memspec_search`
- `memspec_status`
- `memspec_validate`

## CLI Commands

| Command | Description |
|---------|-------------|
| `memspec init` | Create `.memspec/` directory structure and default config |
| `memspec add <type> <title>` | Add a fact, decision, or procedure |
| `memspec search <query>` | Search active memories by keyword |
| `memspec correct <id> --reason "..."` | Correct or invalidate a memory item |
| `memspec status` | Show store summary (counts, decay warnings, recent items) |
| `memspec decay [--dry-run] [--archive]` | Apply TTL rules to expired items |
| `memspec validate` | Check all memory files against the schema |

## Package Shape

- **`docs/`** - spec, design notes, research, AGENTS addon, MCP usage
- **`src/`** - TypeScript CLI, search/index logic, MCP server
- **`.memspec/`** - the memory store inside each project

## What's Planned

- Faster derived index management for larger stores
- Optional vector search for semantic retrieval
- Automatic observation classification (rule-based + LLM-enhanced)
- Retrieval profiles with token budgeting

## For Agent Authors

Copy the [AGENTS.md addon](docs/AGENTS-ADDON.md) into your agent's system prompt or `AGENTS.md`. It gives the agent a concrete contract for when to call `memspec` and how to treat `.memspec/` as canonical.

## Docs

- [Specification v0.2](docs/SPEC.md) — the portable format and lifecycle
- [Design](docs/DESIGN.md) — architecture rationale
- [Research](docs/RESEARCH.md) — prior art analysis
- [Reality Check](docs/REALITY-CHECK.md) — fit test against a real memory system
- [AGENTS.md Addon](docs/AGENTS-ADDON.md) — copy-paste usage contract for agents
- [MCP Wrapper](docs/MCP.md) — stdio server usage and tool surface

## License

MIT
