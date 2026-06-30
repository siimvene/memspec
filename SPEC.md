# Memspec Specification v0.5

## Abstract

Memspec is a specification for managing living project knowledge in AI agent workflows. It defines a convention for capturing, classifying, correcting, and retrieving project knowledge so that any agent or human starting a fresh session can load the current state of a codebase's tribal memory.

This document is the portable specification. It is implementation-agnostic — any system that conforms to this spec is Memspec-compatible, regardless of language, storage backend, or agent runtime.

### Relationship to OKF

Google Cloud's [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) shares Memspec's file surface — markdown body, YAML frontmatter, directory-of-files, no SDK. It standardizes the *static* half of agent knowledge: catalogs of external assets (tables, metrics, runbooks, API endpoints) authored by enrichment agents or humans. Memspec covers the *working-memory* half: claims an agent writes about its own decisions, fixes, and discoveries during work, with first-class lifecycle — witness, supersession, conflict edges, drift detection. A Memspec memory is structurally a valid OKF concept (its `type` is one of `fact`, `decision`, or `procedure`). The formats are complementary, not competing.

### Changes in v0.5 (Connected + Measured)

v0.5 adds two retrieval-side features and the project's first homegrown
retrieval eval harness. All additions are backward-compatible: new
fields and parameters are optional; missing values preserve v0.4
behaviour.

- **Follow linked notes from `memspec_search`.** New optional `expand_edges` flag follows the named links on each search match and surfaces the linked notes as additional results. `edge_types` filter narrows which link types are followed (default: all six — `refines`, `supports`, `depends_on`, `conflicts_with`, `supersedes`, `superseded_by`); `expand_depth` caps link-following depth at 1–3 hops (default 1). Linked-note hits carry an `expanded_via: {from_id, edge_type, hops}` field so callers can see why a record surfaced. Hop scoring is link-following order, no numeric decay; outbound only.
- **Temporal validity intervals.** New optional `valid_from` and `valid_to` ISO8601 fields on `MemoryFrontmatter`. `memspec_search` accepts an `as_of` filter that drops records whose validity window excludes the given timestamp. Orthogonal to `check_by` (which is a review schedule, not a truth window). Missing bounds mean "always valid."
- **`memspec_remember` and `memspec_get` validity wiring.** Remember accepts `valid_from` / `valid_to` at write time on both MCP and CLI surfaces; get returns them when present.
- **BENCHMARK.md + `scripts/run-bench.mjs`.** Reproducible retrieval-only eval harness against the public LongMemEval-S dataset. Reports Recall@5/10, MRR, and latency p50/p99. Not paper-comparable (different protocol, smaller sample) but a real measurement baseline for future regressions.

### Changes in v0.4 (Graph Primitives + Final Shim Cleanup)

v0.4 makes typed relations first-class and finishes the cleanup the v0.3
deprecation aliases were carrying.

- **Typed relation edges.** Three new optional frontmatter fields on every record: `refines` (this record elaborates on the parent; the parent stays valid), `supports` (this record is evidence for the target), `depends_on` (this record presupposes the target). All are `string[]` of memory ids; all sit alongside the existing `supersedes` / `superseded_by` / `conflicts_with` edges. No parallel relations store — edges live on the record like they always have.
- **New tools.** `memspec_relate` wires a typed edge from one memory to another after the fact (when an edge was missed at write time). `memspec_export` dumps the memory graph as JSONL, GraphML, or DOT for visualization in Gephi, Cytoscape, or graphviz — export only; no built-in visualizer.
- **`memspec_get` walks the relation graph.** Lineage now follows `refines`, `supports`, and `depends_on` chains alongside the existing supersede DAG (depth-capped at 3, cycle-safe).
- **`memspec_search` surfaces relation edges** on result objects, parity with `conflicts_with`.
- **Operator-tier path segregation.** Records whose effective `source_kind` resolves to `operator` relocate from `memory/{type}s/<id>.md` to `memory/operator/{type}s/<id>.md`. Reader handles both paths; if a record exists at both the operator-tier and agent-tier path, the operator-tier copy wins and a warning fires.
- **Write-path neighbour-walk.** `memspec_remember` now auto-attaches a suggested `conflicts_with` edge to the closest candidate when similarity falls into the mid-band (below the refusal threshold, above noise — matching the v0.3 conflict-inference rule). High-band still refuses. Operator-tier candidates are excluded from agent auto-attach.
- **`memspec_remember` near-duplicate refusal is enforced.** v0.3 documented the refusal but only emitted a warning; v0.4 actually refuses and points at `memspec_supersede`. `force: true` opts out.
- **Generated `SCHEMA.md`** at repo root, regenerated by `npm run schema` from `src/lib/schema.ts` via Zod introspection; `npm run check` includes `schema:check` to fail on doc drift.
- **`memspec migrate` v0.4.** The same one-shot CLI now hops v0.2 or v0.3 stores straight to v0.4. The pre-migration report adds an `Operator-tier relocations` block, a `Schema field migrations` roll-up, and a `v0.4 additions` reminder. Idempotent; resume protocol documented in MIGRATION-v0.3.md.
- **Deprecation shims removed.** The v0.3 MCP aliases `memspec_add` / `memspec_correct` are gone, as are the deprecated CLI commands `memspec add`, `memspec correct`, `memspec validate`, `memspec consolidate`, `memspec decay`, `memspec promote`. No successors for the latter four; use `memspec status` (validate), `memspec supersede --merge-from` (consolidate); decay is automatic; promote is gone with the witness chain as the replacement strength signal.

### Changes in v0.3 (Witnessed Claims, full slice)

v0.3 completes the witnessed-claims model: every memory is a claim paired with the evidence that last attested it, and the read surface shows the witness in words rather than as a number.

- **Confidence float retired.** Trust is expressed by provenance (`source_kind`) and the witness class (`verified_with`) instead of a 0.0–1.0 number. Old records keep their value as `ext.legacy_confidence` for archaeology, but it is no longer used in ranking or filtering.
- **State enum collapsed.** `captured | corrected | decayed | archived` are gone. The active set is `active | superseded | retired`. Past values are accepted on read (mapped: `captured → active`, `corrected → superseded`, `decayed | archived → retired`) and rewritten on first migration.
- **Field renames.** `decay_after → check_by`, `corrects → supersedes` (now an array, since N→1 merges are first-class), `corrected_by → superseded_by`, `correction_reason → supersede_reason`. The reader accepts both names for one version; the writer emits the new ones.
- **`kind`** (new): `claim | observation`. Claims have a `type`; observations index a moment, never go stale because never claimed to be current. `expires` is the observation-only hard expiry.
- **`pinned`** (new, operator-only): always surfaced in boot context.
- **`conflicts_with`** (new): explicit conflict edges. Annotated on read to surface contradictions rather than ranking them blind.
- **`verified_with`** (new): `anchor | operator | evidence | assertion`. Replaces `confidence` as the trust signal. Inferred at read time from existing data when missing.
- **Anchors are schema spine.** `ext.code_anchors` is dual-read for one version; the writer emits top-level `anchors`. The position change makes anchors first-class rather than optional garnish.
- **Migration.** `memspec migrate` is the one-shot, idempotent CLI that renames fields, remaps states, promotes anchors, retires confidence, and backfills `verified_with` from existing data. Dry-run is the default; `--apply` writes. Emits a source-to-source_kind inference table before any writes for operator review.

### Changes in v0.2 (Witnessed Claims, first slice)

v0.2 began moving memspec toward the witnessed-claims model with these schema-compatible additions:

- **`source` is required at write time.** `'unknown'` is rejected. MCP implementations default it to the connected client name.
- **`source_kind`** (`operator | agent | import`), inferred from the source string at write time. Operator-sourced records are protected: correcting one requires an explicit override, logged into the persisted reason.
- **Correction reasons are durable** (later renamed to `supersede_reason` in v0.3).
- **Anchorless verification requires evidence.**
- **Anchors may be cross-repo.**
- **TTL expiry flags, never deletes** (`decay_after`, now `check_by`).

---

## 1. Concepts

### 1.1 Memory Item

A memory item is a single unit of project knowledge. It has:
- A **type** (what kind of knowledge)
- A **state** (where it is in its lifecycle)
- **Content** (the knowledge itself, human-readable)
- **Metadata** (structured frontmatter)

### 1.2 Memory Store

A directory of memory items, organized by type and state. The store is the canonical source of truth. Any indexes, caches, or search layers are derived from the store and must be rebuildable from it.

### 1.3 Observation

A raw input from an agent or human that has not yet been classified into a memory item. Observations are the entry point — everything starts as an observation.

---

## 2. Memory Types

Three types. No more.

| Type | Description | When to use |
|------|-------------|-------------|
| `fact` | A verified piece of information about the project | Current state of architecture, configuration, dependencies, constraints |
| `decision` | A choice that was made, with context and reasoning | Why something is the way it is, what alternatives were considered |
| `procedure` | A reusable workflow, process, or sequence of steps | How to deploy, how to debug X, how to set up the dev environment |

### 2.1 Classification Rules

Observations are classified into types using these rules, applied in order:

1. **Pattern matching** (minimum viable, no LLM required):
   - Contains "decided", "chose", "picked X over Y", "went with" → `decision`
   - Contains "steps to", "how to", "process for", "workflow", "run X then Y" → `procedure`
   - Describes current state, configuration, or architecture → `fact`

2. **LLM-enhanced** (optional): If an LLM is available, use it for ambiguous cases. The LLM assigns type and confidence score. If unavailable, rule-based classification is sufficient.

3. **Unclassifiable**: Observations that don't match any pattern remain as observations and decay on a shorter TTL (default: 7 days).

Implementations MAY add additional classification rules. Implementations MUST NOT add additional memory types.

### 2.2 Classification Guidance for Common Gray Zones

Some knowledge doesn't map obviously to one type. These guidelines resolve the most common ambiguities:

**Rules and policies** ("always lint before committing", "never deploy on Fridays"):
- If the *why* is the valuable part — why we adopted this constraint, what alternatives were considered → `decision`
- If the *steps* are the valuable part — what to actually do and in what order → `procedure`
- If neither — it's just describing how things work right now → `fact`
- A rule often warrants both: a `decision` capturing the rationale, and a `procedure` capturing the workflow it implies. This is not duplication — they serve different retrieval needs.

**Skills and techniques** ("debug memory leaks with heap snapshots", "profile API latency with tracing"):
- If it's a repeatable sequence an agent should follow → `procedure`
- If it's a statement about what tool/approach we use and why → `decision` (chose heap snapshots over core dumps)
- If it's a statement about what's available or true → `fact` (heap snapshot support is enabled in staging)

**The disambiguation test:** Ask "what would a future agent need this for?"
- To understand *why things are this way* → `decision`
- To *do something* step by step → `procedure`
- To know *what is true now* → `fact`

---

## 3. Lifecycle

### 3.1 States

| State | Description | Retrievable |
|-------|-------------|-------------|
| `active` | Classified and current. Represents what's true now. | Yes |
| `superseded` | Replaced by a newer memory (via correction or merge). | No (unless explicitly requested) |
| `retired` | Removed from the working set by operator sweep. Retained in history. | No |

Legacy states from earlier versions still load: `captured → active`, `corrected → superseded`, `decayed | archived → retired`.

### 3.2 Transitions

```
active   ──→ superseded   (correction or merge signal received)
active   ──→ retired      (operator-approved sweep)
```

TTL expiry does **not** transition state. An item past `check_by` stays `active` and gets `stale: true` in frontmatter — it remains retrievable, with the flag carried in results so readers know to re-verify or supersede before relying on it. A successful verification clears the flag.

State transitions out of `active` are explicit acts: a supersede (with a durable reason) or an operator-approved sweep. Time alone never removes knowledge.

### 3.3 Decay Defaults

| Type | Default TTL | Rationale |
|------|-------------|-----------|
| `fact` | 90 days | Facts go stale as code changes. Force re-verification. |
| `decision` | 180 days | Decisions are more durable but should be revisited. |
| `procedure` | 90 days | Procedures drift as tooling and code change. |
| observation (unclassified) | 7 days | If it wasn't worth classifying, it probably isn't worth keeping. |

Implementations MAY override these defaults via configuration. A TTL of `0` or `never` means the item does not decay automatically.

Passing the TTL flags the item `stale: true` (see §3.2); it does not archive it. Physical retirement is `memspec sweep` — interactive, one prompt per candidate, CLI-only by design (removal is an operator act, not an agent surface).

### 3.4 Witness Class (`verified_with`)

Each active memory carries a witness class indicating how its current truth is attested. This replaces the v0.2 confidence float.

| Witness | Meaning |
|---------|---------|
| `anchor` | At least one code anchor was unchanged at last verification. Mechanical witness, strongest. |
| `operator` | An operator (`source_kind: operator`) stated this directly. Authority witness. |
| `evidence` | An agent verified the claim and stated what it checked (recorded in `ext.last_verification.evidence`). |
| `assertion` | The claim has only the writer's say-so. No anchor, no operator, no evidence. Weakest. |

Witness is information for the reader, not a write-rate limiter. The consuming LLM weighs the evidence in words. The witness is set at write time and updated by `verify` and `anchor` operations; it is inferred from existing data on records that predate the field.

**Historical: confidence float (removed in v0.3).** Pre-0.3 records had a `confidence` float [0, 1]. It encoded "verify call count" rather than truth probability, and the ranking formulas that mixed it with raw BM25 were cosmetic. The reader preserves any historical value under `ext.legacy_confidence` for archaeology; it is no longer used.

---

## 4. Self-Correction Protocol

Self-correction is how memory stays current as the codebase evolves.

### 4.1 Supersede Signal

Any agent or human can supersede a record. A supersede signal contains:
- **target**: ID of the memory being superseded
- **reason**: Why it's wrong or stale (free text). Persisted durably on both records.
- **replacement** (optional): New content that supersedes the target.
- **title** (optional): Fresh title for the replacement — superseded knowledge often no longer fits the old title.
- **merge_from** (optional, planned): List of duplicate ids to collapse atomically into one survivor.

### 4.2 Supersede Processing

When a supersede signal is received:

1. The target memory transitions to `superseded` state.
2. The target's `superseded_by` field is set to the surviving memory's id.
3. If replacement content is provided, a new memory is created in `active` state with `supersedes: [target_id]`, the provided title (or the old one), and a `check_by` reset to the type default — fresh knowledge does not inherit the dying record's TTL.
4. If no replacement is provided, the target is superseded without replacement (the knowledge is simply invalidated).
5. Both memories are retained — the supersede and the original.
6. The **reason is persisted durably** as `supersede_reason` frontmatter on every record involved: the archived original and (when minted) the replacement.

Historical correction reasons whose values the v0.2 bug dropped come back from migration as `supersede_reason: "(predates reason tracking)"`.

### 4.2.1 Operator Record Protection

Records whose effective `source_kind` is `operator` (the stored field, or inferred from the source string for records that predate it) MUST NOT be superseded without an explicit override flag (`--override-operator` / `override_operator`). When the override is used, that fact is appended to the persisted reason — overriding operator knowledge leaves a trace.

### 4.3 Implicit Correction (optional, requires index)

When a derived search index is available, the system MAY detect semantic contradictions between a new observation and existing active memories of the same type and tags. If detected, the system SHOULD flag the conflict for explicit correction rather than auto-correcting.

This capability is not required for conformance. Without an index, corrections are always explicit.

---

## 5. Retrieval

### 5.1 Query

A retrieval query contains:
- **context**: What the agent is working on (free text or tags)
- **types** (optional): Filter by memory type. Default: all types.
- **max_tokens** (optional): Token budget for the response. Default: 2000.
- **profile** (optional): Named retrieval profile. Default: `default`.
- **expand_edges** (optional, v0.5+): If true, follow the named links on each search match to surface linked notes as additional results. Default: false.
- **edge_types** (optional, v0.5+): Restrict link-following to specific link types. Default: all six (`refines`, `supports`, `depends_on`, `conflicts_with`, `supersedes`, `superseded_by`). No-op when `expand_edges` is false.
- **expand_depth** (optional, v0.5+): Cap on how many hops to follow, 1–3. Default: 1. No-op when `expand_edges` is false.
- **as_of** (optional, v0.5+): ISO8601 timestamp. Drops records whose `valid_from`/`valid_to` window excludes this instant. Records without validity bounds are always returned.

### 5.2 Response

A retrieval response is an ordered list of memory items, ranked by relevance, truncated to the token budget. The response format is implementation-defined but MUST include for each item:
- The memory content
- The memory type
- The witness class (`verified_with`) and the stale flag, if set
- Known `conflicts_with` edges (including edges to non-returned claims, with their titles inline)
- The creation date
- When `expand_edges` surfaced the hit, an `expanded_via: {from_id, edge_type, hops}` field naming the search match the linked note was reached from (v0.5+)

### 5.3 Ranking

Query results are ranked by **relevance** (keyword/BM25 similarity, normalized per result set; optionally reranked by embeddings in hybrid mode) combined with **witness recency** (how recently the claim was last verified). Confidence is gone in v0.3 — trust is communicated through the witness class, not folded into the rank. Result hits are appended to a local usage log (`usage.jsonl`), which feeds the boot-context usage boost (§5.5).

### 5.4 Retrieval Profiles

A retrieval profile is a named configuration that adjusts retrieval behavior for a specific use case. Profiles configure:
- `max_tokens`: Token budget
- `types`: Which memory types to include
- `ranking`: Weight overrides

Implementations MUST support at least a `default` profile. Additional profiles are optional. The pre-0.3 `min_confidence` knob is accepted but is a no-op.

### 5.5 Boot Context (Session-Start Injection)

The no-query boot path (`memspec context`) renders the working set for session-start injection. Three sections, in order:

1. **Needs attention** (cap 3) — claims flagged `stale` or with drifted anchors. Each line carries the id, type, a ⚠ marker, what is wrong, and the scripted next move (`→ verify | supersede`, plus `anchor` when drift names a file). Flagged claims beyond the cap stay in the working set carrying their ⚠ marker.
2. **Pinned** (cap 5) — operator-pinned claims, bypassing ranking; ordered by last-verified descending. Overflow pins fall back into the working set.
3. **Working set** — everything else, ranked by:

```
score       = type_weight × freshness × usage_boost
type_weight : decision 1.0, procedure 0.9, fact 0.8
freshness   = exp(-ln2 × days_since_last_verified / halflife)
              halflife: decision 180d, procedure 90d, fact 45d
usage_boost = 1 + 0.25 × log2(1 + retrievals_last_30d)
```

Freshness clocks from `last_verified`, not `created` — a re-witnessed old claim is fresh.

Every line carries the claim's id, type, source-kind tag, witness marker (`⚓` anchored / `✓Nd` verified N days ago / `⚠` stale), title, and a preview ≤120 chars, so every booted memory is immediately actionable without a re-search. All sections spend from one token budget (default 2000, hard cap 20 items total), greedy fill in section order. The header reports the active-claim count and attention count and points at `memspec_status`.

---

## 6. Storage Convention

### 6.1 Directory Layout

```
.memspec/
  observations/             # State: active, kind: observation (tier-agnostic)
    {date}/
      {id}.md
  memory/                   # State: active, kind: claim
    facts/
      {id}.md
    decisions/
      {id}.md
    procedures/
      {id}.md
    operator/               # v0.4: tier-segregated operator-sourced claims
      facts/
        {id}.md
      decisions/
        {id}.md
      procedures/
        {id}.md
  archive/                  # State: superseded or retired (tier-agnostic)
    {id}.md
  config.yaml               # Profiles, decay overrides, classification rules
```

The `.memspec/` directory lives in the project repository. It is committed to git alongside the codebase.

### 6.2 File Format

Each memory item is a markdown file with YAML frontmatter:

```markdown
---
id: ms_{ulid}
kind: claim | observation                 # NEW in v0.3; defaults to claim
type: fact | decision | procedure         # claims only
state: active | superseded | retired
created: {ISO 8601}
source: {agent or human identifier}       # required; 'unknown' is rejected at write time
source_kind: operator | agent | import    # trust tier inferred from source at write time
tags: [{tag}, ...]
check_by: {ISO 8601} | never              # renamed from decay_after; flag-only, never deletes
stale: true                               # optional — set when check_by passes; cleared by verification
last_verified: {ISO 8601}                 # optional — when last confirmed true (defaults to created)
verified_with: anchor | operator | evidence | assertion   # witness class; replaces confidence
pinned: true                              # optional — operator only; always surfaced in boot
anchors: [{file, sha, repo?}, ...]        # PROMOTED from ext.code_anchors to schema spine
supersedes: [{id}, ...]                   # ids this record replaces (renamed from corrects; now array)
superseded_by: {id}                       # id of the record that replaced this one (renamed from corrected_by)
supersede_reason: {text}                  # renamed from correction_reason
conflicts_with: [{id}, ...]               # explicit conflict edges to other memory ids
refines: [{id}, ...]                      # v0.4 — this record elaborates on the parent (parent stays valid)
supports: [{id}, ...]                     # v0.4 — this record is evidence for the target
depends_on: [{id}, ...]                   # v0.4 — knowledge or chronological dependency
expires: {ISO 8601}                       # observations only — hard expiry
---

# {Title}

{Content — human-readable description of the knowledge}

## Context
{Optional — why this matters, what prompted it}

## Alternatives
{Optional — for decisions, what was considered and rejected}
```

**Reader compatibility.** For one version, the reader accepts pre-0.3 frontmatter (`decay_after`, `corrects`/`corrected_by`/`correction_reason`, the old state values, `ext.code_anchors`, top-level `confidence`) and normalizes it into the v0.3 shape on parse. The writer emits v0.3 names only — re-saved records migrate organically. `memspec migrate` covers everything else in one pass.

### 6.3 Required Fields

- `id`: ULID prefixed with `ms_`. Globally unique within the store.
- `type`: One of `fact`, `decision`, `procedure`.
- `state`: One of the defined lifecycle states.
- `created`: ISO 8601 timestamp.
- `source`: Who wrote the record. Required at write time; `'unknown'` is rejected. MCP implementations SHOULD default it to the connected client name. `source_kind` is inferred at write time: source matching `siim|human:*|user` → `operator`; known import names → `import`; otherwise `agent`.

### 6.4 ID Format

IDs use ULID (Universally Unique Lexicographically Sortable Identifier) prefixed with `ms_`. This gives chronological sorting for free and avoids collisions across agents.

Example: `ms_01HXK7Y3P5QZJKM8N4R2T6W9VB`

---

## 7. Multi-Agent Access

Multiple agents access the same memory store by reading and writing files in `.memspec/`. Git handles versioning and conflict resolution.

### 7.1 Write Protocol

1. Agent writes a new file to `observations/` or `memory/`
2. Agent commits the file (or a watcher/hook commits it)
3. Other agents see the new memory on next read

### 7.2 Conflict Resolution

If two agents write conflicting memories simultaneously:
- Git merge conflicts are resolved by keeping both and flagging for correction
- The self-correction protocol handles semantic conflicts asynchronously

### 7.3 Source Attribution

Every memory item records its `source` — which agent or human created it. This enables tracing knowledge provenance without requiring a coordination protocol.

---

## 8. Integration Methods

Listed from simplest to most capable. Implementations MUST support method 1. Methods 2-3 are optional.

### 8.1 File I/O (minimum viable)

Agent reads and writes markdown files in `.memspec/`. No server, no dependencies, no API. Any agent that can read/write files is Memspec-compatible.

### 8.2 MCP Server

Optional MCP server. v0.4 exposes eleven tools:

- `memspec_search` — ranked retrieval with optional type filter and profile;
  result objects carry `verified_with`, `stale`, `conflicts_with`, and the
  named links (`refines`, `supports`, `depends_on`)
- `memspec_get` — fetch a memory by id with its lineage chain. v0.4 walks
  `supersedes` / `superseded_by` plus the typed relations `refines`,
  `supports`, `depends_on` (depth-capped at 3, cycle-safe)
- `memspec_remember` — write a new claim; anchors may be supplied inline so
  code-state facts are anchored at write time. Near-duplicate writes are
  refused (opt out with `force: true`); mid-band similarity auto-attaches a
  suggested `conflicts_with` edge
- `memspec_supersede` — replace, retract, or merge a memory.
  `body` filled → replacement (new active record). `body` empty → retraction.
  `merge_from` collapses N duplicates into one survivor atomically. Reason is
  persisted on every record involved.
- `memspec_relate` — wire a named link from one memory to another after the
  fact: `refines`, `supports`, `depends_on`, or `conflicts_with`
- `memspec_observe` — point-in-time observation with hard expiry (default 7d)
- `memspec_verify` — re-witness a claim; anchorless verification requires
  evidence
- `memspec_anchor` — link a claim to source files (records git blob SHAs)
- `memspec_reconcile` — list anchored claims whose files have drifted
- `memspec_status` — store health: counts by type/state/witness, stale,
  drifted anchors, declared and inferred conflicts, schema violations,
  sweep candidates
- `memspec_export` — dump the memory graph (nodes + edges) as JSONL,
  GraphML, or DOT for visualization in Gephi, Cytoscape, or graphviz

The v0.3 deprecation aliases were removed in v0.4: `memspec_add` and
`memspec_correct` no longer exist (use `memspec_remember` and
`memspec_supersede`). The six tools deleted in v0.3 — `promote`,
`consolidate`, `validate`, `decay`, `init`, `stores` — remain absent.

CLI-only surface (off the MCP tool list, by design):
`memspec init`, `memspec sweep`, `memspec stores`, `memspec migrate`.
The v0.3 CLI deprecation shims (`add`, `correct`, `promote`, `consolidate`,
`validate`, `decay`) were removed in v0.4.

### 8.3 CLI

Optional command-line interface (primary v0.3 commands):
- `memspec remember {type} "{title}" --source {who} [--anchor {files...}] [--pin] [--check-by {ts|never}]`
- `memspec observe "{text}" [--ttl {dur}]` — point-in-time observation with hard expiry
- `memspec supersede {id} --reason "{reason}" [--body "{new content}"] [--title] [--merge-from {ids}] [--override-operator]`
- `memspec verify {id} [--evidence "{what you checked}"]`
- `memspec anchor {id} {files...}` / `memspec reconcile [--since {ref}]`
- `memspec search "{query}"` / `memspec context [--query] [--budget]`
- `memspec status` — the single maintenance readout

---

## 9. Configuration

Configuration is stored in `.memspec/config.yaml`:

```yaml
# Classification
classification:
  llm: true                    # Use LLM for classification if available
  fallback: rules              # Fall back to rule-based if LLM unavailable

# Decay
decay:
  fact: 90d
  decision: 180d
  procedure: 90d
  observation: 7d

# Retrieval profiles
profiles:
  default:
    max_tokens: 2000
    types: [fact, decision, procedure]

# Index (optional)
index:
  enabled: false               # Enable derived search index
  backend: sqlite              # sqlite | custom
```

All configuration has sensible defaults. An empty or missing `config.yaml` uses the defaults defined in this spec.

---

## 10. Consolidation

Agents need triggers to write and maintain memories. Memspec defines two consolidation mechanisms:

### 10.1 Behavioral Triggers (agent instructions)

The agent instructions (patched into CLAUDE.md/AGENTS.md by `init`) tie memory writes to observable events during work:

- Fixed a bug → write/correct the relevant `fact`
- Changed architecture or configuration → correct stale memories, write new ones
- Established a workflow → write a `procedure`
- Discovered something non-obvious → write a `fact`
- Made a design choice → write a `decision` with rationale

This is the primary consolidation mechanism. It works with any agent runtime and requires no tooling beyond the CLI.

### 10.2 Commit Hook (optional, Claude Code)

A PostToolUse hook that fires when the agent runs `git commit` or `git push`. The hook injects a consolidation prompt while the agent still has full conversation context — it knows what it committed and why.

Configuration in `.memspec/config.yaml`:

```yaml
consolidation:
  trigger: commit    # commit | manual | none
  frequency: once    # once (per session) | always
```

- `commit` + `once`: first commit in a session triggers consolidation
- `commit` + `always`: every commit triggers
- `manual`: agent instructions only, no hook
- `none`: consolidation disabled

The hook is implementation-specific (Claude Code PostToolUse) but the consolidation config key is part of the spec. Other implementations MAY use different hook mechanisms tied to the same config.

### 10.3 Design Rationale

Agents don't reliably perform deferred tasks. A generic "review memories before ending" instruction is easy to ignore. Tying memory writes to specific completed actions (fixed a bug, made a decision, committed code) is more reliable because:

1. The trigger is concrete and observable
2. The agent has full context about *why* the change was made
3. The memory is written as part of the task, not as an afterthought

---

## 11. Stabilization Gate

> **Removed in v0.3 / v0.4.** The gate produced `captured` records that
> needed `promote`; the v0.3 reader collapses legacy `captured` items
> straight to `active` on load and `memspec promote` was a deprecation stub
> in v0.3 and is gone entirely in v0.4. The `stabilization` config block is
> accepted but inert. This section is retained for historical reference
> only.

### 11.1 Purpose

The stabilization gate is an optional mechanism that prevents unvalidated observations from immediately becoming active memories. When enabled, new memories start as `captured` and require confirmation before promotion to `active`.

This addresses a universal problem across domains: agents generate noisy observations that shouldn't be treated as established knowledge without validation. Whether a personal agent learning "user prefers morning meetings" or an infra agent observing "this service restarts every Tuesday" — unvalidated claims need a stabilization period.

### 11.2 Configuration

```yaml
stabilization:
  enabled: true                  # Default: false (backward compatible)
  min_confirmations: 2           # Times memory must be independently confirmed
  auto_promote_confidence: 0.9   # Confidence threshold for automatic promotion
```

When `enabled` is `false` (default), new memories go directly to `active` as in prior versions.

### 11.3 Promotion Criteria

A captured memory is promoted to `active` when ANY of:
- It has been confirmed `min_confirmations` times (by the same or different agents)
- Its confidence score reaches `auto_promote_confidence`

### 11.4 Confirmation Tracking

Confirmations are tracked via the `ext` field (see §6.5):

```yaml
ext:
  confirmations: 2
  confirmed_by: [claude-code, cursor]
  promoted_at: 2026-04-10T10:00:00Z
```

Each confirmation increments the count and raises confidence by an implementation-defined amount. The `confirmed_by` list tracks unique sources that confirmed the memory.

### 11.5 Behavior When Enabled

1. `add` creates memories with `state: captured` regardless of type
2. Captured memories are stored in `observations/`, not `memory/{type}s/`
3. Captured memories are NOT returned by default retrieval (consistent with §3.1)
4. Upon promotion, the file moves from `observations/` to `memory/{type}s/`
5. The `promoted_at` timestamp is recorded in `ext`

---

## 12. Store Composition

### 12.1 Purpose

A single agent may need memory from multiple scopes — personal preferences that follow across projects, organization-wide conventions, and project-specific knowledge. Store composition defines how multiple memory stores layer with precedence.

### 12.2 Store Layers

A store layer is a named memory store with:
- **name**: Identifier (e.g., `global`, `project`, `org`)
- **path**: Directory containing `.memspec/`
- **priority**: Integer — higher values take precedence
- **writable**: Whether the layer accepts writes

```yaml
stores:
  - name: global
    path: ~/.memspec
    priority: 0
    writable: true
  - name: project
    path: .memspec
    priority: 10
    writable: true
```

### 12.3 Precedence Rules

When multiple layers contain memories:
- **Search**: Results from all layers are merged, deduplicated by ID. Higher-priority layers win on ID collisions.
- **Write**: Writes go to the highest-priority writable layer by default. An explicit layer name may be specified.
- **Correction**: A correction in any layer marks the target as corrected, regardless of which layer the target lives in.

### 12.4 Auto-Detection

If no `stores` configuration is provided:
- The project `.memspec/` is used (priority 10, writable)
- If `~/.memspec/` exists, it is included automatically (priority 0, writable)

This means a global store is available without configuration — just `memspec init` in your home directory.

### 12.5 Use Cases

| Layer | Contains | Example |
|-------|----------|---------|
| `~/.memspec` (global) | Personal preferences, cross-project identity | "I use pnpm", "prefer functional style" |
| `.memspec` (project) | Project-specific knowledge | "uses PostgreSQL", "deploy process" |
| `/org/.memspec` (org, read-only) | Team conventions, shared decisions | "all services use structured logging" |

### 12.6 Extension Metadata Convention

The `ext` field (§6.5) supports a `store_layer` key indicating which layer a memory belongs to:

```yaml
ext:
  store_layer: global
```

This is informational — the file's physical location determines its layer, not this field.

---

## 13. Extension Metadata

### 13.1 The `ext` Field

The `ext` field in frontmatter is the official extension mechanism. It holds implementation-specific or domain-specific metadata without polluting the core schema.

### 13.2 Registered Conventions

The following `ext` keys have defined semantics across implementations:

| Key | Type | Description |
|-----|------|-------------|
| `confirmations` | number | Times this memory has been independently confirmed (§11.4) |
| `confirmed_by` | string[] | Sources that confirmed this memory |
| `promoted_at` | string | ISO 8601 timestamp of promotion to active |
| `store_layer` | string | Name of the store layer this memory belongs to (§12.6) |
| `episode` | string | Episode identifier for grouping related memories |
| `sequence` | number | Order within an episode |
| `relates_to` | string[] | IDs of related memories |
| `code_anchors` | array | Files this memory depends on: `[{file, sha, repo?}]` where `file` is project-root-relative (POSIX), `sha` is the git blob SHA of the file content at anchor time, and `repo` optionally names another repository the file lives in (§13.3) |
| `last_verification` | object | Most recent verification: `{at: ISO 8601, source?, evidence?}` |

Implementations MAY use additional `ext` keys. Unknown keys MUST be preserved on read/write.

### 13.3 Code Anchors

A memory about code state ("auth uses argon2id", "the app has 7 screens") goes stale the moment the code it describes changes — calendar TTL fires too late. Code anchors link a memory to the files it depends on so staleness can be detected from code change, not just time.

`ext.code_anchors` is an array of `{file, sha}` pairs. `sha` is the git blob SHA of the file content (`git hash-object <file>`) at the time the anchor was set or last verified. Comparing the recorded SHA against the current file content answers "has this file changed since the memory was last known true?" — including uncommitted edits, and insensitive to history rewrites.

Anchors are a convention, not a schema requirement. Tools that understand them (verify, reconcile, anchor-aware decay) use them; tools that don't ignore them. Memories without anchors keep calendar-only behavior.

**Cross-repo anchors.** An anchor MAY carry a `repo` field naming another repository the anchored file lives in. Verification resolves the repo as a sibling directory of the project root first, then under directories listed in `anchors.repo_search_paths` in `config.yaml`. When the repo is not checked out, verification returns `needs_review` with "anchor in repo X, fetch to verify" — the claim is flagged, never failed hard, and never mutated. Anchors without `repo` behave exactly as before.

**Anchorless verification.** As of v0.2, verifying a memory that has no anchors REQUIRES evidence text stating what was checked (recorded in `ext.last_verification.evidence`). A bare anchorless verify is the system trusting its own output and is rejected.

---

## 14. Conformance

An implementation is Memspec-conformant if it:

1. Uses the three defined memory types and no others
2. Implements the lifecycle states and transitions as specified
3. Supports the self-correction protocol
4. Uses the directory layout and file format conventions
5. Supports file I/O as a minimum integration method
6. Keeps the file store as canonical source of truth (indexes are derived)
7. Preserves unknown `ext` keys on read/write

An implementation MAY additionally:
- Provide MCP, CLI, or REST interfaces
- Add a derived search index
- Use LLM-enhanced classification
- Support custom retrieval profiles
- Add pre-storage filtering (PII, secrets)
- Implement the stabilization gate (§11)
- Support store composition (§12)
- Use registered `ext` conventions (§12)

---

## Appendix A: Example Memory Items

### Fact

```markdown
---
id: ms_01HXK7Y3P5QZJKM8N4R2T6W9VB
kind: claim
type: fact
state: active
created: 2026-04-04T10:30:00Z
source: claude-code
source_kind: agent
tags: [auth, api]
check_by: 2026-07-03T10:30:00Z
last_verified: 2026-04-04T10:30:00Z
verified_with: anchor
anchors:
  - file: src/auth/jwt.ts
    sha: 3f1d2c8a9b7e6f5d4c3b2a1908f7e6d5c4b3a291
---

# API authentication uses JWT with short-lived tokens

JWT with 15-minute expiry and refresh tokens. Supports web, CLI, and agent clients.
The token service is in `src/auth/jwt.ts`.
```

### Decision

```markdown
---
id: ms_01HXK8A2R7BMCN5P3Q4Y6Z1WXD
kind: claim
type: decision
state: active
created: 2026-04-03T14:00:00Z
source: human:siim
source_kind: operator
tags: [api, architecture]
check_by: 2026-10-03T14:00:00Z
last_verified: 2026-04-03T14:00:00Z
verified_with: operator
---

# Chose REST over GraphQL for the public API

REST for simplicity — most consumers are CLI tools and agents, not frontend apps.
GraphQL adds complexity without clear benefit for this audience.

## Alternatives
- GraphQL: more flexible queries, but overkill for our use case
- gRPC: good performance, but poor browser/agent support
```

### Supersession

```markdown
---
id: ms_01HXM2B4K8DNFP6R9S3V5X7YZA
kind: claim
type: fact
state: active
created: 2026-04-10T09:00:00Z
source: claude-code
source_kind: agent
tags: [auth, api]
check_by: 2026-07-10T09:00:00Z
last_verified: 2026-04-10T09:00:00Z
verified_with: assertion
supersedes: [ms_01HXK7Y3P5QZJKM8N4R2T6W9VB]
supersede_reason: Security review flagged CLI token storage; JWT replaced by OAuth2 PKCE
---

# API authentication uses OAuth2 with PKCE

Migrated from JWT to OAuth2 with PKCE flow on 2026-04-09. The JWT approach
was replaced after security review flagged token storage in CLI clients.
Token service moved from `src/auth/jwt.ts` to `src/auth/oauth.ts`.
```
