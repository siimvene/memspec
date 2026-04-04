# Memspec Specification v0.1

## Abstract

Memspec is a specification for managing living project knowledge in AI agent workflows. It defines a convention for capturing, classifying, correcting, and retrieving project knowledge so that any agent or human starting a fresh session can load the current state of a codebase's tribal memory.

This document is the portable specification. It is implementation-agnostic — any system that conforms to this spec is Memspec-compatible, regardless of language, storage backend, or agent runtime.

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
active   ──→ decayed      (TTL expired)
active   ──→ archived     (manual or bulk cleanup)
corrected ──→ archived    (after retention period)
decayed  ──→ archived     (after retention period)
```

No transition requires human approval. All transitions are triggered by the system, by an agent, or by time.

### 3.3 Decay Defaults

| Type | Default TTL | Rationale |
|------|-------------|-----------|
| `fact` | 90 days | Facts go stale as code changes. Force re-verification. |
| `decision` | 180 days | Decisions are more durable but should be revisited. |
| `procedure` | 90 days | Procedures drift as tooling and code change. |
| observation (unclassified) | 7 days | If it wasn't worth classifying, it probably isn't worth keeping. |

Implementations MAY override these defaults via configuration. A TTL of `0` or `never` means the item does not decay automatically.

### 3.4 Confidence Score

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

### 4.2 Correction Processing

When a correction signal is received:

1. The target memory transitions to `corrected` state
2. The target's `corrected_by` field is set to the new memory's ID
3. If replacement content is provided, a new memory is created in `active` state with `corrects` pointing to the target
4. If no replacement is provided, the target is corrected without replacement (the knowledge is simply invalidated)
5. Both memories are retained — the correction and the original

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
confidence: 0.0-1.0
created: {ISO 8601}
source: {agent or human identifier}
tags: [{tag}, ...]
decay_after: {ISO 8601}
corrects: {id}          # present if this corrects another memory
corrected_by: {id}      # present if this was corrected
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

## 10. Conformance

An implementation is Memspec-conformant if it:

1. Uses the three defined memory types and no others
2. Implements the lifecycle states and transitions as specified
3. Supports the self-correction protocol
4. Uses the directory layout and file format conventions
5. Supports file I/O as a minimum integration method
6. Keeps the file store as canonical source of truth (indexes are derived)

An implementation MAY additionally:
- Provide MCP, CLI, or REST interfaces
- Add a derived search index
- Use LLM-enhanced classification
- Support custom retrieval profiles
- Add pre-storage filtering (PII, secrets)

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
