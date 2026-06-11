# Memspec Specification v0.2

## Abstract

Memspec is a specification for managing living project knowledge in AI agent workflows. It defines a convention for capturing, classifying, correcting, and retrieving project knowledge so that any agent or human starting a fresh session can load the current state of a codebase's tribal memory.

This document is the portable specification. It is implementation-agnostic — any system that conforms to this spec is Memspec-compatible, regardless of language, storage backend, or agent runtime.

### Changes in v0.2 (Witnessed Claims, first slice)

v0.2 starts moving memspec toward a witnessed-claims model: every memory is a claim paired with the evidence that last attested it. This release is schema-compatible — readers tolerate records written before it.

- **`source` is required at write time.** `'unknown'` is rejected. MCP implementations default it to the connected client name.
- **`source_kind`** (optional field): `operator | agent | import`, inferred from the source string at write time. Operator-sourced records are protected: correcting one requires an explicit override, and the override is logged into the correction reason.
- **Correction reasons are durable.** `correction_reason` is written to both the replacement and the archived original. Corrections may carry a fresh title, and may supersede into an existing memory instead of minting a new one (duplicate merging).
- **Anchorless verification requires evidence.** A bare self-verify is rejected; the caller must state what was checked.
- **Anchors may be cross-repo** (`{file, sha, repo?}`). An anchor whose repo is not checked out flags the claim for review instead of failing.
- **TTL expiry flags, never deletes.** Items past `decay_after` get `stale: true` and stay active and searchable; results carry the flag. Physical retirement is `memspec sweep`, an interactive operator-run CLI command.

Planned for v0.3 (breaking): removal of the `confidence` float in favor of witness display, MCP tool surface reduction and renames (`remember`/`supersede`/`observe`), an `observation` record kind with hard expiry, and a boot-context ranking rewrite.

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
| `captured` | Raw observation, not yet classified | No |
| `active` | Classified and current. Represents what's true now. | Yes |
| `corrected` | Superseded by a newer memory. No longer current. | No (unless explicitly requested) |
| `decayed` | TTL expired. No longer relevant. | No (unless explicitly requested) |
| `archived` | Removed from working set. Retained in history. | No |

### 3.2 Transitions

```
captured ──→ active       (classification)
captured ──→ archived     (unclassifiable + TTL expired)
active   ──→ corrected    (correction signal received)
active   ──→ archived     (operator-approved sweep, or manual cleanup)
corrected ──→ archived    (after retention period)
```

As of v0.2, TTL expiry does **not** transition state. An item past `decay_after` stays `active` and gets `stale: true` in frontmatter — it remains retrievable, with the flag carried in results so readers know to re-verify or correct before relying on it. A successful verification clears the flag. The `decayed` state remains defined for records written by earlier versions.

State transitions out of `active` are explicit acts: a correction (with a durable reason) or an operator-approved sweep. Time alone never removes knowledge.

### 3.3 Decay Defaults

| Type | Default TTL | Rationale |
|------|-------------|-----------|
| `fact` | 90 days | Facts go stale as code changes. Force re-verification. |
| `decision` | 180 days | Decisions are more durable but should be revisited. |
| `procedure` | 90 days | Procedures drift as tooling and code change. |
| observation (unclassified) | 7 days | If it wasn't worth classifying, it probably isn't worth keeping. |

Implementations MAY override these defaults via configuration. A TTL of `0` or `never` means the item does not decay automatically.

Passing the TTL flags the item `stale: true` (see §3.2); it does not archive it. Physical retirement is `memspec sweep` — interactive, one prompt per candidate, CLI-only by design (removal is an operator act, not an agent surface).

### 3.4 Confidence Score

> **Deprecated.** Scheduled for removal in v0.3 — trust will be expressed by provenance (`source_kind`) and verification method instead of a number. New tooling should not build on this field.

Each active memory has a confidence score from 0.0 to 1.0. This affects retrieval ranking, not lifecycle.

- Initial confidence is set by classification (rule-based: 0.7, LLM-enhanced: LLM-assigned)
- Confidence increases when an agent or human explicitly confirms the memory (e.g., via a confirmation signal or by correcting a different memory and citing this one as still accurate)
- Confidence decreases as the memory approaches its TTL without confirmation
- Confidence does not affect whether an item is retrievable — only its ranking
- The mechanism for tracking confirmation is implementation-defined

---

## 4. Self-Correction Protocol

Self-correction is how memory stays current as the codebase evolves.

### 4.1 Correction Signal

Any agent or human can signal a correction. A correction signal contains:
- **target**: ID of the memory being corrected
- **reason**: Why it's wrong or stale (free text)
- **replacement** (optional): New content that supersedes the target
- **title** (optional): Fresh title for the replacement — corrected knowledge often no longer fits the old title
- **supersede_by** (optional): ID of an existing active memory that supersedes the target, instead of minting a new one. Mutually exclusive with replacement. This is how duplicates merge.

### 4.2 Correction Processing

When a correction signal is received:

1. The target memory transitions to `corrected` state
2. The target's `corrected_by` field is set to the superseding memory's ID (the new replacement, or the existing memory named by `supersede_by`)
3. If replacement content is provided, a new memory is created in `active` state with `corrects` pointing to the target, the provided title (or the old one), and a decay clock reset to the type default — fresh knowledge does not inherit the dying record's TTL
4. If no replacement is provided, the target is corrected without replacement (the knowledge is simply invalidated)
5. Both memories are retained — the correction and the original
6. The **reason is persisted durably** as `correction_reason` frontmatter on every record involved: the archived original and (when minted) the replacement

### 4.2.1 Operator Record Protection

Records whose effective `source_kind` is `operator` (the stored field, or inferred from the source string for records that predate it) MUST NOT be corrected without an explicit override flag (`--override-operator` / `override_operator`). When the override is used, that fact is appended to the persisted correction reason — overriding operator knowledge leaves a trace.

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

### 5.2 Response

A retrieval response is an ordered list of memory items, ranked by relevance, truncated to the token budget. The response format is implementation-defined but MUST include for each item:
- The memory content
- The memory type
- The confidence score
- The creation date

### 5.3 Ranking

Items are ranked by a weighted combination of:
- **Relevance**: Semantic or keyword similarity to the query context
- **Confidence**: The memory's confidence score
- **Recency**: How recently the memory was created or confirmed

Default weights: relevance 0.4, confidence 0.3, recency 0.3. Implementations MAY allow custom weights via retrieval profiles.

### 5.4 Retrieval Profiles

A retrieval profile is a named configuration that adjusts retrieval behavior for a specific use case. Profiles configure:
- `max_tokens`: Token budget
- `types`: Which memory types to include
- `min_confidence`: Minimum confidence threshold
- `ranking`: Weight overrides for relevance, confidence, recency

Implementations MUST support at least a `default` profile. Additional profiles are optional.

---

## 6. Storage Convention

### 6.1 Directory Layout

```
.memspec/
  observations/             # State: captured
    {date}/
      {id}.md
  memory/                   # State: active
    facts/
      {id}.md
    decisions/
      {id}.md
    procedures/
      {id}.md
  archive/                  # State: archived, corrected, decayed
    {id}.md
  config.yaml               # Profiles, decay overrides, classification rules
```

The `.memspec/` directory lives in the project repository. It is committed to git alongside the codebase.

### 6.2 File Format

Each memory item is a markdown file with YAML frontmatter:

```markdown
---
id: ms_{ulid}
type: fact | decision | procedure
state: captured | active | corrected | decayed | archived
confidence: 0.0-1.0       # deprecated, removal planned for v0.3
created: {ISO 8601}
source: {agent or human identifier}   # required; 'unknown' is rejected at write time
source_kind: operator | agent | import   # optional — trust tier inferred from source at write time
tags: [{tag}, ...]
decay_after: {ISO 8601}
stale: true               # optional — set when decay_after passes; cleared by verification
last_verified: {ISO 8601}  # optional — when this memory was last confirmed true (defaults to created)
corrects: {id}          # present if this corrects another memory
corrected_by: {id}      # present if this was corrected
correction_reason: {text}  # present on corrected records and their replacements
---

# {Title}

{Content — human-readable description of the knowledge}

## Context
{Optional — why this matters, what prompted it}

## Alternatives
{Optional — for decisions, what was considered and rejected}
```

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

Optional MCP server exposing:
- `memspec.observe` — submit an observation (accepts free text, returns ID)
- `memspec.query` — retrieval with context, types, token budget, profile
- `memspec.correct` — signal a correction (target ID, reason, optional replacement)
- `memspec.search` — raw search (keyword or semantic, returns unranked results)

### 8.3 CLI

Optional command-line interface:
- `memspec observe "{text}"` — submit observation
- `memspec query "{context}"` — retrieve relevant memories
- `memspec correct {id} --reason "{reason}" --replace "{new content}"`
- `memspec search "{query}"` — raw search
- `memspec status` — summary of memory store (counts by type/state, recent activity)

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
    min_confidence: 0.7
    ranking:
      relevance: 0.4
      confidence: 0.3
      recency: 0.3

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
type: fact
state: active
confidence: 0.9
created: 2026-04-04T10:30:00Z
source: claude-code
tags: [auth, api]
decay_after: 2026-07-03T10:30:00Z
---

# API authentication uses JWT with short-lived tokens

JWT with 15-minute expiry and refresh tokens. Supports web, CLI, and agent clients.
The token service is in `src/auth/jwt.ts`.
```

### Decision

```markdown
---
id: ms_01HXK8A2R7BMCN5P3Q4Y6Z1WXD
type: decision
state: active
confidence: 0.85
created: 2026-04-03T14:00:00Z
source: human:siim
tags: [api, architecture]
decay_after: 2026-10-03T14:00:00Z
---

# Chose REST over GraphQL for the public API

REST for simplicity — most consumers are CLI tools and agents, not frontend apps.
GraphQL adds complexity without clear benefit for this audience.

## Alternatives
- GraphQL: more flexible queries, but overkill for our use case
- gRPC: good performance, but poor browser/agent support
```

### Correction

```markdown
---
id: ms_01HXM2B4K8DNFP6R9S3V5X7YZA
type: fact
state: active
confidence: 0.9
created: 2026-04-10T09:00:00Z
source: claude-code
tags: [auth, api]
decay_after: 2026-07-10T09:00:00Z
corrects: ms_01HXK7Y3P5QZJKM8N4R2T6W9VB
---

# API authentication uses OAuth2 with PKCE

Migrated from JWT to OAuth2 with PKCE flow on 2026-04-09. The JWT approach
was replaced after security review flagged token storage in CLI clients.
Token service moved from `src/auth/jwt.ts` to `src/auth/oauth.ts`.
```
