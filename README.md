# Memspec

Structured memory for AI agents: a portable markdown spec plus a small TypeScript CLI and MCP wrapper.

Memspec keeps markdown files under `.memspec/` as the canonical source of truth. The CLI and MCP server are thin local tools for creating, validating, searching, and maintaining that memory. No daemon. No database-owned state.

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
# Initialize a memory store in your project
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

- **`docs/`** — the spec (v0.2), research, reality check, AGENTS.md addon
- **`src/`** — TypeScript CLI and MCP server
- **`.memspec/`** (in your project) — the memory store itself

## What's Included

- File-canonical store layout (markdown + YAML frontmatter)
- All 7 CLI commands: init, add, search, correct, status, decay, validate
- Stdio MCP wrapper for agent/tool integrations
- Zod schema validation and lifecycle state transitions
- File-backed keyword search with title/tag/body scoring
- Correction protocol with replacement linking and archival
- TTL-based decay with dry-run preview
- Extension model for richer metadata (ext namespace in frontmatter)

## What's Planned

- Derived SQLite index for faster search on large stores
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
