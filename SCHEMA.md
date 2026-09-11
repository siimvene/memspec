<!--
  GENERATED FILE — DO NOT EDIT.
  Source of truth: src/lib/schema.ts (Zod schemas).
  Regenerate with: npm run schema  (script: scripts/generate-schema.ts)
  CI check: npm run schema:check (diffs this file against a fresh render).
-->

# Memspec Memory Frontmatter Schema

This document is generated from the Zod schema in `src/lib/schema.ts`.
Every field below corresponds to a YAML key in the frontmatter of a memory file
(see `SPEC.md §6.2` for the on-disk layout). The reader normalizes legacy v0.2
field/state names into this v0.3+ shape before validation.

## Identity

### `id`

- **Type:** `string` (ULID, `ms_` + 26 chars)
- **Required:** yes
- **Description:** ULID prefixed with `ms_`; globally unique within the store and chronologically sortable.

### `kind`

- **Type:** enum: `claim` \| `observation` \| `question`
- **Required:** no
- **Default:** `"claim"`
- **Description:** `claim` for fact/decision/procedure memories; `observation` for point-in-time notes that index a moment and expire rather than going stale.

### `type`

- **Type:** enum: `fact` \| `decision` \| `procedure`
- **Required:** no
- **Description:** Classification for claims (`fact` | `decision` | `procedure`); required when `kind: claim`, omitted on observations and questions.

### `state`

- **Type:** enum: `active` \| `superseded` \| `retired` \| `open` \| `resolved`
- **Required:** yes
- **Description:** Lifecycle state for claims/observations: `active` (current), `superseded` (replaced), or `retired` (no longer relevant). Questions instead use `open` (answer undecided) or `resolved` (settled).

## Provenance

### `created`

- **Type:** `string`
- **Required:** yes
- **Description:** ISO 8601 timestamp when this record was first written.

### `source`

- **Type:** `string`
- **Required:** yes
- **Description:** Who wrote the record (agent name, human identifier, or import label); required at write time, `"unknown"` is rejected.

### `source_kind`

- **Type:** enum: `operator` \| `agent` \| `import`
- **Required:** no
- **Description:** Trust tier inferred from `source` at write time: `operator` (human), `agent`, or `import`.

### `tags`

- **Type:** array of `string`
- **Required:** no
- **Default:** `[]`
- **Description:** Free-form tag list for filtering and search.

## Lifecycle

### `check_by`

- **Type:** `string`
- **Required:** yes
- **Description:** ISO 8601 deadline or `"never"`; when it passes the record is flagged `stale: true` at read time but never deleted (renamed from `decay_after`).

### `stale`

- **Type:** `boolean`
- **Required:** no
- **Description:** Set when `check_by` has passed; cleared by a successful `verify`. Lazy-flagged in memory on read; physical removal only via `memspec sweep`.

### `last_verified`

- **Type:** `string`
- **Required:** no
- **Description:** ISO 8601 timestamp of the last successful verification; defaults to `created` when never verified.

### `expires`

- **Type:** `string`
- **Required:** no
- **Description:** Observations only: hard ISO 8601 expiry after which the record is no longer surfaced.

### `pinned`

- **Type:** `boolean`
- **Required:** no
- **Description:** Operator-only flag; pinned claims are always surfaced in boot context (cap 5, ordered by `last_verified` descending).

## Temporal validity

### `valid_from`

- **Type:** `string`
- **Required:** no
- **Description:** ISO 8601 timestamp when the world-state truth claimed by this record becomes valid. Open-ended if absent. Orthogonal to `check_by` — validity bounds the truth window; `check_by` bounds the review schedule.

### `valid_to`

- **Type:** `string`
- **Required:** no
- **Description:** ISO 8601 timestamp when the world-state truth ceases to hold. Open-ended if absent. Orthogonal to `check_by` — past `valid_to` means the fact is no longer true, past `check_by` only means review is overdue.

## Witness

### `verified_with`

- **Type:** enum: `anchor` \| `probe` \| `operator` \| `evidence` \| `assertion`
- **Required:** no
- **Description:** Witness class for the last verification, in descending strength: `anchor` > `probe` > `operator` > `evidence` > `assertion`. Replaces the retired `confidence` field. `probe` is written only by `memspec probe` itself (`--set` or a matching re-check) — the entry point that actually executed the command; `verify` never runs probes.

### `anchors`

- **Type:** array of object { file, sha, repo }
- **Required:** no
- **Description:** Code anchors linking this memory to specific file contents; drift detected by comparing recorded SHA to current `git hash-object`. Promoted from `ext.code_anchors` to schema spine in v0.3.

## Edges

### `supersedes`

- **Type:** array of `string`
- **Required:** no
- **Description:** Ids this record replaces (renamed from `corrects`; now an array to support N→1 merges).

### `superseded_by`

- **Type:** `string`
- **Required:** no
- **Description:** Id of the record that replaced this one (renamed from `corrected_by`).

### `supersede_reason`

- **Type:** `string`
- **Required:** no
- **Description:** Durable reason explaining why this record was superseded (renamed from `correction_reason`).

### `conflicts_with`

- **Type:** array of `string`
- **Required:** no
- **Description:** Explicit conflict links to other memory ids; surfaced on read so contradictions are visible rather than blindly ranked.

### `refines`

- **Type:** array of `string`
- **Required:** no
- **Description:** Ids of notes this record refines or elaborates on; the parent stays valid (v0.4 named link).

### `supports`

- **Type:** array of `string`
- **Required:** no
- **Description:** Ids of notes this record provides evidence for (v0.4 named link).

### `depends_on`

- **Type:** array of `string`
- **Required:** no
- **Description:** Ids of notes this record presupposes — a knowledge or chronological dependency (v0.4 named link).

### `derived_from`

- **Type:** array of `string`
- **Required:** no
- **Description:** Ids of records this record was INFERRED from rather than observed directly; a record carrying any is `derived` (v0.11 named link).

## Actuation

### `requires_human`

- **Type:** array of `string`
- **Required:** no
- **Description:** Procedures only: step labels or short phrases a human must perform; an unattended runner refuses these steps. Schema error on non-procedure records (v0.11 actuation boundary).

## Evidence

### `evidence`

- **Type:** array of object { sha256, name, path, source, url, captured_at }
- **Required:** no
- **Description:** Committed evidence attachments (v0.11 Layer B): content-addressed local file copies under `evidence/`, or http(s) URL pointers recorded without fetching. A file-backed entry witnesses an anchorless claim as `evidence`.

## Question groups

### `answers`

- **Type:** array of `string`
- **Required:** no
- **Description:** Questions only: competing answer record ids for this question (v0.11 question groups).

### `closed`

- **Type:** `boolean`
- **Required:** no
- **Description:** Questions only: `true` means the listed `answers` are the only candidates (closed-world), enabling resolution by elimination (v0.11 question groups).

### `resolved_by`

- **Type:** `string`
- **Required:** no
- **Description:** Questions only: the surviving answer id, set when the question `state` is `resolved` (v0.11 question groups).

## Extension

### `ext`

- **Type:** record<`string`, `unknown`>
- **Required:** no
- **Description:** Extension bag for non-schema fields (e.g. `ext.confirmations`, `ext.last_verification`, `ext.legacy_confidence`). Conventions documented in `src/lib/types.ts`.

## Other

### `scope`

- **Type:** `string`
- **Required:** no
- **Description:** Read-side partition matching a `scopes:` key in config.yaml. Absent means visible from every scope (the default for pre-scoping records); `universal` means explicitly visible everywhere; any other value restricts the record to that one active scope.

### `probe`

- **Type:** object { cmd, hash }
- **Required:** no
- **Description:** A shell command plus the sha256 of its baseline stdout; a re-run whose output hashes differently marks the record drifted. Executes only via explicit `memspec probe`, gated by the machine-local trustfile (`.probe-trust.json`) — never on a read path and never inside `verify`, because record content is untrusted and the command shells out.

## Supporting types

### `MemoryKind`

`claim` \| `observation` \| `question`

### `MemoryType`

`fact` \| `decision` \| `procedure`

### `LifecycleState`

`active` \| `superseded` \| `retired`

### `QuestionState`

`open` \| `resolved`

### `SourceKind`

`operator` \| `agent` \| `import`

### `VerifiedWith`

`anchor` \| `probe` \| `operator` \| `evidence` \| `assertion`

### `CodeAnchor`

Anchor sub-record used by the `anchors` field.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | yes | Path relative to the project root (POSIX separators). |
| `sha` | `string` | yes | Git blob SHA of the file content at anchor time (`git hash-object`). |
| `repo` | `string` | no | When set, `file` lives in another repo checked out next to this project (or under a configured search path). |

