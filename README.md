# Memspec

**Memspec is Git-backed project memory for AI coding agents, with verification and drift detection.** Claims about code are anchored to file SHAs; when the code changes, memspec flags the claim for review instead of letting facts rot silently. Duplicate rejection, typed supersede chains, and per-claim provenance turn memory into testable claims, not a notes file.

Markdown files under `.memspec/` are the canonical source of truth: human-readable, git-diffable, greppable. Lose the index, lose speed — not data. No backend service. No hosted memory API. No vendor lock-in.

## Architecture

<p align="center">
  <img src="assets/memspec_architecture_flow.svg" alt="How memspec works: agents read and write markdown memories under .memspec/, which flow through lifecycle, code anchors, linked notes, and FTS5/BM25 search to the MCP server and session hooks" width="620">
</p>

Agents `remember` claims and `observe` notes; everything lands as markdown under `.memspec/`. From there a structured layer — lifecycle (`active → superseded → retired`), code anchors, typed links, and temporal validity — feeds FTS5/BM25 search, the MCP server, and session-start hooks, so the next session wakes up with the right context instead of amnesia.

## Features

- **File-canonical.** Memories are markdown files with YAML frontmatter. Human-readable, git-diffable, greppable. Lose the index, lose speed — not data.
- **Three claim types + observations.** `fact`, `decision`, `procedure` with per-type TTLs; `observation` for point-in-time notes with hard expiry.
- **Lifecycle, not curation.** `active | superseded | retired`. Corrections create a new memory linked back to the original; supersede chains preserve the reason on every record involved. Past TTL = stale flag at read time, never deletion.
- **Code-anchored verification.** Tie memories to git blob SHAs. When code drifts, memspec flags drifted anchors for review instead of letting facts about code rot silently.
- **Linked notes** (v0.5+). Records reference other records by id (`refines`, `supports`, `depends_on`, `conflicts_with`, `supersedes`, `superseded_by`). Search can follow these links one or more hops to surface neighbours alongside direct matches; `--include-superseded` lets link-following reach archived predecessors (v0.6+).
- **Temporal validity** (v0.5+). Optional `valid_from` / `valid_to` per memory. Search with `--as-of <iso>` filters by world-state truth window, orthogonal to the `check_by` review schedule.
- **Operator-tier storage** (v0.4+). Records sourced by the operator land in a separate filesystem path with stricter overwrite protection (`--override-operator` required to supersede).
- **Layered stores** (v0.6+). A project `.memspec/` and a global `~/.memspec/` merge at retrieval time — project records take priority, global merges as a lower layer. Every search, context, and MCP path honours the configured `stores:` layers. A repo without its own store can bind to external stores via a `.memspec.yaml` pointer file (v0.9+).
- **Scope claims** (v0.9+). Stores declare which working directories they own; ingestion routes knowledge to the claiming store and holds unclaimed content local, so nothing crosses a sync boundary by default — team knowledge stays out of personal stores and vice versa.
- **Transcript ingestion** (v0.9+). `normalize` → `distill` → `reduce` turns raw harness session logs (Claude Code, Codex) into weekly experience digests; the dream pass diffs them against memory writes to catch work that happened but was never recorded. Raw transcripts never leave the machine.
- **Dedup-aware writes.** `remember` refuses near-duplicate claims and points at the existing record, so memory accretes corrections via `supersede` instead of silent duplicates.
- **FTS5/BM25 search.** SQLite FTS5 relevance, recency-weighted, ranked per profile.
- **MCP server.** Eleven tools, first-class integration with Claude Code, Cursor, Codex.
- **Witnessed claims.** Every memory carries `verified_with` (`anchor | operator | evidence | assertion`) — provenance, not a confidence score.
- **Dream pass** (v0.7+). Periodic reflection script (`memspec-dream`) reads the last N days of memspec writes and git log, asks an LLM to surface stale memories, supersede candidates, verify candidates, missing relations, and behavioural rules worth promoting. Output is review material, never auto-applied.
- **Zero infrastructure.** `npm install -g memspec` + `memspec init`. No accounts, no API keys, no hosted services.

## Install

```bash
npm install -g memspec
```

Or local:

```bash
git clone https://github.com/siimvene/memspec.git
cd memspec && npm install && npm run build && npm link
```

## Quick start

```bash
memspec init                                            # interactive setup, creates .memspec/

memspec remember fact "Auth uses JWT" \                 # write a claim, anchor it to code
  --source agent --tags auth --anchor src/auth/jwt.ts

memspec search "auth"                                   # BM25; --expand-edges follows linked notes

memspec reconcile                                       # find anchored claims whose code drifted
memspec verify ms_01HXK... --evidence "still JWT"       # confirm still true; refreshes timestamp

memspec supersede ms_01HXK... \                         # or replace with a corrected version
  --reason "Migrated to OAuth" --body "Now OAuth2 + PKCE"
```

The `anchor → reconcile → verify | supersede` loop is the differentiator: claims about code stay accountable to the code.

## Why not just AGENTS.md?

| Approach | Reviewable in Git | Code-anchored | Lifecycle | Search | Self-hosted |
|---|---|---|---|---|---|
| `AGENTS.md` / `CLAUDE.md` | yes | no | none | grep | yes |
| `MEMORY.md` / scratchpad | yes | no | none | grep | yes |
| Vector DB (Chroma, Qdrant) | no | no | manual | semantic | yes |
| Hosted memory API (Mem0, Letta) | no | no | hosted | hosted | no |
| **Memspec** | per-claim | yes | typed states | FTS5 + BM25 | yes |

If project memory fits in a paragraph in a single file, `AGENTS.md` is fine. Memspec is for when memory grows into a list of claims that need to track code reality, expire, supersede, and link to each other.

## Memory model

Three claim types plus observations, agent-operated, lifecycle handled in the tool:

| Type | Captures | Default TTL |
|---|---|---|
| `fact` | Verified project state | 90d |
| `decision` | A choice with rationale | 180d |
| `procedure` | A reusable workflow | 90d |
| `observation` | Point-in-time, hard expiry | 7d |

Each memory is one markdown file with YAML frontmatter. Past `check_by` → `stale` flag at read time, never deletion. `memspec sweep` is the only removal path, operator-approved one item at a time.

States: `active | superseded | retired`. Corrections create a new memory linked back to the original; supersede chains preserve the reason on every record involved. Everything lives in git history.

## Linked notes

Records reference other records by id in their frontmatter — `refines`, `supports`, `depends_on`, `conflicts_with`, `supersedes`, `superseded_by`. Search can follow these links to surface neighbours alongside direct matches:

```bash
memspec search "v0.5 plan" --expand-edges --expand-depth 1
```

Follows the listed ids one hop out and includes the linked notes in results. Each surfaced neighbour carries `expanded_via` showing how it got there. `--include-superseded` lets expansion reach archived predecessors via supersede chains. `--as-of <iso>` filters by `valid_from` / `valid_to` for world-state queries.

## Code-anchored verification

Calendar TTL is the wrong signal for facts about code. Memspec ties claims to file SHAs:

- `memspec anchor <id> <files...>` — record the git blob SHAs of the files this memory depends on
- `memspec verify <id>` — refresh "still true"; drifted anchors flag for review without mutating the memory
- `memspec reconcile` — scan all anchored memories for drift, including uncommitted edits

Anchor paths may be **absolute** (preferred), project-relative, or repo-qualified (`repo/path`). Prefer absolute paths when the store's project root is not the repo you're working in — a home-rooted personal store's project root is `$HOME`, so a bare `src/x.ts` resolves nowhere and the claim silently degrades to an unanchored assertion. For a repo-relative path to a sibling checkout, pass `--anchor-root <dir>` (`anchor_root` over MCP); it is recorded as a cross-repo anchor and resolved as a sibling directory (or via `anchors.repo_search_paths`) on read. A path that resolves nowhere is reported back, never silently dropped.

Drifted memories never auto-archive. They surface for human judgement via `memspec status`.

## Search

SQLite FTS5 full-text + BM25, recency-weighted per profile. Zero setup beyond `better-sqlite3`.

Index rebuilds on demand from the markdown files. Lose the index, lose speed — not data.

Every result set carries a **coverage** verdict so an agent can tell "the store knows nothing here" from a low-ranked hit: `none` (no active record matches), `weak` (fewer than half of the distinct query terms occur in the top hit, or a title/tag-only match, or barely above the BM25 floor — don't infer from rank; the note names which terms matched nothing), or `ok`. A `coverage_witness` names the strongest witness behind the hits (`anchor > operator > evidence > assertion`), so coverage `ok` with witness `assertion` reads as "claimed, but unverified". The CLI prints a final `Coverage:` line; JSON/MCP expose `coverage`, `coverage_note`, and `coverage_witness`.

Anchored results are drift-checked on the read path: a record whose anchored file has changed since it was last anchored prints a `[DRIFTED]` marker (JSON/MCP: `drifted`, with `anchor_unchecked` when the anchor's repo is not checked out here). No `reconcile` run needed to see it.

## Usage receipts & outcomes

Every search hit is logged to a local, gitignored `usage.jsonl` — one row per result, carrying the query (truncated to 200 chars), a session id (`MEMSPEC_SESSION_ID` > `CLAUDE_SESSION_ID` > a per-process id), the hit's rank, and which surface issued the search (`cli` | `mcp`). Search hits and `memspec_get` results carry `last_referenced` / `sessions` back to the caller when known — read-only derivations, never written to frontmatter.

Retrieval alone doesn't say whether a memory actually helped. `memspec outcome <id> <useful|dead_end|corrected> [--note] [--source]` (CLI + `memspec_outcome` MCP tool) appends a durable, append-only receipt to `outcomes.jsonl` without ever mutating the record. `supersede` records a `corrected` outcome automatically for every id it collapses — you don't have to call it yourself when you already know a claim was wrong. Record `dead_end` whenever a retrieved memory turned out wrong or useless for the task at hand; it feeds `status`'s two usage-derived surfaces:

- **Cold** — active records created more than 30 days ago that have never been retrieved, or weren't retrieved in the last 60 days. Candidates for `memspec supersede` or a closer look, not automatic removal.
- **Promotion candidates** — active observations, and facts witnessed only by `assertion` and created in the last 14 days, that have been retrieved in 2+ distinct sessions with zero `dead_end` outcomes. Candidates only — nothing is auto-promoted.

Both sections print in `memspec status` text output and surface as `cold` / `promotion_candidates` arrays in the MCP `memspec_status` JSON.

## Trust profiles

Memspec doesn't enforce a write policy; the agent's instruction file does (see [AGENTS-ADDON.md](AGENTS-ADDON.md)). Two reference profiles:

**Operator solo** (default). The agent writes facts, decisions, procedures, and observations freely. Duplicate rejection, anchor drift, and supersede chains catch bad writes. Friction-free; relies on `git log` to undo mistakes. Suits single-operator setups where memspec is your own agent infrastructure.

**Team review.** For shared repos with multiple writers:

- Observations: agent writes freely.
- Facts: agent writes only when anchored to code; anchorless facts route to a PR for review.
- Decisions: drafted by agent, merged by human.
- Procedures: agent-written, reviewed at first use.
- Operator-tier claims: never overridden without `--override-operator` and a reason in the supersede record.
- Secrets: never stored. Anywhere. Ever.

Pick the profile in your `AGENTS.md` / `CLAUDE.md` and the agent will follow it. The store records every write, so deviations show up in `git log`.

## MCP server

```bash
memspec-mcp                          # stdio in current project
memspec-mcp --cwd /path/to/project   # pin a root
```

`memspec init` auto-creates `.mcp.json` for host tool discovery (Claude Code, Cursor, etc).

Thirteen MCP tools: `memspec_search`, `memspec_get`, `memspec_remember`, `memspec_supersede`, `memspec_relate`, `memspec_unrelate`, `memspec_observe`, `memspec_verify`, `memspec_outcome`, `memspec_anchor`, `memspec_reconcile`, `memspec_status`, `memspec_export`. The CLI exposes a superset (`init`, `migrate`, `sweep`, `context` are CLI-only — store creation, schema migration, physical removal, and session-start context are operator acts, not an agent surface).

For manual `.mcp.json` setup:

```json
{
  "mcpServers": {
    "memspec": { "command": "memspec-mcp", "args": ["--cwd", "/abs/path/to/project"] }
  }
}
```

## Global store

`~/.memspec/` is a cross-project memory layer for personal preferences, common patterns, infra knowledge. When both stores exist, the project store takes priority; global merges as a lower layer.

```bash
memspec init --cwd ~/.memspec
```

## Multi-store: pointer files & scope claims

Different orgs lay memory out differently — store beside the code, store in a sibling team repo, one personal umbrella. Two declarations make any layout explicit and keep knowledge from leaking across store boundaries:

**Pointer file.** A repo with no store of its own carries a `.memspec.yaml` at its root binding it to the stores that serve it (paths resolve against the pointer's directory; a `.memspec/` directory closer to cwd always wins):

```yaml
# service-repo/.memspec.yaml — memory lives in the sibling team repo
stores:
  - name: team
    path: ../platform-team-specs
    priority: 10
    writable: true
  - name: personal
    path: ~/.memspec
    priority: 0
    writable: true
```

Reads fan out across the layers. Writes must be unambiguous: with more than one writable layer in scope, `remember` refuses until you say `--store team` or `--store personal` — a silently-guessed store is how team knowledge ends up in a personal repo.

**Scope claims.** A store's `config.yaml` declares the working directories whose knowledge it owns:

```yaml
claims:
  - ~/work/platform/**
  - ~/git/my-project
```

Ingestion (`memspec reduce`) routes each session's digest to the claiming store. Sessions nobody claims are **held local** — they never cross a sync boundary, and route automatically the day a claim appears. No claims configured anywhere = classic single-store behaviour.

## Record scoping

A store shared across several projects (a home-rooted personal store, or one shared repo store) can partition records by working directory so a query issued while working on one project doesn't surface another's noise:

```yaml
scopes:
  kleidia: [~/git/kleidia, ~/git/kleidia-docs]
  plg: ['~/piletilevi/**']
```

A record's `scope` is absent (visible from every scope — the default), `universal` (explicitly visible everywhere), or a name from the map above (visible only when that scope is active). `remember`/`observe`/`search` all accept `--scope`, or derive it from `cwd` against the patterns above.

Set `scopes_require: true` in `config.yaml` to make this mandatory: `remember`/`observe` then refuse a write that resolves no scope at all (no `--scope` passed, cwd matched no pattern) rather than letting it land unscoped. Pass `--scope universal` for a record that genuinely belongs everywhere — that's the explicit opt-out, not a workaround.

Records written before scoping existed (or written since without a scope) can be backfilled from their tags: `node bin/repair-scope-backfill.mjs --store <root> --map tag:scope,tag:scope,...` (dry-run by default; `--apply` writes, with an undo journal). Records whose tags match two different scopes are left untouched and reported ambiguous; records matching nothing are left untouched and counted; operator-sourced records are skipped unless `--include-operator`.

## Store layout

```
.memspec/
  memory/
    facts/  decisions/  procedures/        # active, agent-tier
    operator/{facts,decisions,procedures}/ # operator-tier (separate path)
  observations/                            # raw, unclassified
  archive/                                 # superseded + retired
  config.yaml                              # decay, profiles, scopes, stores
```

Frontmatter fields per record: `id`, `kind`, `type`, `state`, `source`, `source_kind`, `verified_with` (`anchor | operator | evidence | assertion`), `tags`, `check_by`, `anchors`, `supersedes`, `superseded_by`, `conflicts_with`, `refines`, `supports`, `depends_on`, optional `valid_from` / `valid_to`. Human-readable, git-diffable, greppable.

## CLI reference

| Command | What |
|---|---|
| `memspec init` | Create `.memspec/`, configure search, install hooks |
| `memspec remember <type> <title> --source <who>` | Write a fact/decision/procedure |
| `memspec observe <text>` | Capture a point-in-time observation |
| `memspec search <query> [--expand-edges] [--include-superseded] [--as-of <iso>]` | Search; optionally follow linked notes |
| `memspec context [--query] [--limit]` | Token-budgeted memory dump for session-start hooks |
| `memspec supersede <id> --reason "..." [--body] [--merge-from <ids>]` | Replace, retract, or merge records |
| `memspec relate --from <id> --to <id> --type <kind>` | Wire a link between records after the fact |
| `memspec verify <id> [--evidence "..."] [--check-by <iso\|never>]` | Mark a memory still true; checks anchors; `--check-by` pins the next review date explicitly instead of resetting to the type default |
| `memspec outcome <id> <useful\|dead_end\|corrected> [--note] [--source]` | Record what happened after a retrieved memory was acted on (append-only; never mutates the record) |
| `memspec anchor <id> <files...>` | Link a memory to file SHAs |
| `memspec reconcile` | Find anchored memories with drifted code |
| `memspec normalize [--source <harness>]` | Session logs → local trajectory records (deterministic, local-only) |
| `memspec distill [--limit <n>]` | Trajectories → per-session digests via a cheap LLM |
| `memspec reduce [--force]` | Per-session digests → committed experience digest, routed by claims |
| `memspec status` | Health readout (counts, witness, stale, drift, conflicts, cold records, promotion candidates) |
| `memspec sweep [--dry-run] [--answers <file>]` | Interactively retire stale items (operator-only removal path); `--answers` reads `<id>\t<y\|n>` lines non-interactively instead of prompting |
| `memspec export --format <jsonl\|graphml\|dot>` | Export records and links to stdout |
| `memspec migrate` | v0.2/v0.3 → v0.4+ store migration (idempotent, dry-run by default) |

## Hooks for Claude Code

`memspec init` installs two hooks at `~/.claude/hooks/`:

- `memspec-session-start.js` — runs `memspec context` and injects memory into the session prompt so the agent doesn't have to remember to search; also surfaces unreviewed dream passes (counts + open questions) until a `_Reviewed:` marker lands (v0.8+)
- `memspec-consolidate.js` — on commit, prompts the agent to write memories about what just shipped

Configurable in `.memspec/config.yaml`. Pass `--no-install-hooks` to skip. See [`hooks/`](hooks/) for the scripts.

## Dream pass

A periodic reflection over the store. Reads the last N days of memspec writes + git log, asks an LLM to surface stale memories, supersede / merge candidates, verify candidates, missing typed relations, and behavioural rules worth promoting to your agent instruction file. **Proposals only — never auto-applied.**

```bash
memspec-dream                          # weekly default (7 days, current .memspec/)
memspec-dream 14                       # custom window
MEMSPEC_DREAM_AUTOCOMMIT=1 memspec-dream
```

Output lands at `<store>/dream/YYYY-MM-DD.md` for a human to review. Defaults to invoking `claude` (Claude Code CLI) headlessly; override with `MEMSPEC_LLM_BIN` and `MEMSPEC_LLM_ARGS` for other CLIs.

Cron example (Sunday 22:00 local):

```cron
0 22 * * 0  cd /path/to/project && MEMSPEC_DREAM_AUTOCOMMIT=1 memspec-dream
```

Inspired by [Aaron Fulkerson's Exo](https://aaronfulkerson.com/2026/05/23/meet-exo/) and the [`dream-skill`](https://github.com/grandamenium/dream-skill) prior art.

## Transcript ingestion

The dream pass can only consolidate what sessions bothered to write down. Transcript ingestion closes that gap by distilling what sessions actually *did* (v0.9+):

```
memspec normalize   # harness logs -> trajectory records   (deterministic, 0 tokens, local/)
memspec distill     # trajectories -> per-session digests   (cheap LLM, incremental, local/)
memspec reduce      # digests -> experience digest           (deterministic, committed, claim-routed)
```

- **normalize** reads Claude Code (`~/.claude/projects/`) and Codex (`~/.codex/sessions/`) session logs into trajectory-v1-shaped records (after [Letta's Trajectory](https://www.letta.com/blog/trajectory/) format; own implementation). Adapter per harness — adding one is a small PR.
- **distill** runs each session through a cheap model (`MEMSPEC_DISTILL_BIN`/`MEMSPEC_DISTILL_ARGS`, default `claude --model haiku -p`) into a ~250-word digest: what happened, decisions, fixes, discoveries, loose ends. Incremental with a per-run cap, so a heavy week never becomes one un-fittable batch. Secret shapes are redacted.
- **reduce** merges fresh digests into `<store>/digests/<date>-<hostname>.md` — the only artifact that gets committed. Raw transcripts, trajectories, and per-session digests stay in the gitignored `local/` and never leave the machine.
- The **dream pass** then reads experience digests alongside memspec writes and reports `UNRECORDED WORK`: things that demonstrably happened but produced no memory — with ready-to-run `memspec remember` proposals.

Scheduling is wall-clock-free by design: run all three from any wake-driven daily job (macOS launchd fires missed slots on wake; `distill` and `reduce` self-gate). Laptops that were off simply catch up on next wake — data is delayed, never lost.

## Docs

- [SPEC.md](SPEC.md) — design rationale and frontmatter schema
- [SCHEMA.md](SCHEMA.md) — generated field reference (regenerated from Zod via `npm run schema`)
- [CHANGELOG.md](CHANGELOG.md) — release history
- [MIGRATION-v0.3.md](MIGRATION-v0.3.md) — v0.2/v0.3 → v0.4+ upgrade path
- [AGENTS-ADDON.md](AGENTS-ADDON.md) — block to paste into `AGENTS.md` / `CLAUDE.md` if `init` couldn't patch your repo

## License

MIT
