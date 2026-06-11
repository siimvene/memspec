# Changelog

## 0.3.0 — in progress

Witnessed claims, full slice. Schema rename, confidence retirement, dual-mode
reader, one-shot migrate CLI. Reader accepts v0.2 records for one version;
writer emits v0.3 only.

### Done
- **Schema rename.** `decay_after` → `check_by`, `corrects`/`corrected_by` →
  `supersedes` (array) / `superseded_by`, `correction_reason` →
  `supersede_reason`. State enum collapses to `active | superseded | retired`
  (the old `captured | corrected | decayed | archived` values still load and
  get normalized into the new shape on read).
- **New schema fields.** `kind: claim | observation` (orthogonal to `type`),
  `pinned` (operator-only, surfaced in boot), `conflicts_with` (explicit
  conflict edges), `expires` (observations only — hard expiry),
  `verified_with` (`anchor | operator | evidence | assertion`, the witness
  display that replaces confidence).
- **Confidence retired.** No top-level `confidence` in v0.3 records. Reader
  moves any legacy float into `ext.legacy_confidence` for archaeology only;
  ranking and `min_confidence` profile knobs are no-ops now.
- **Anchors as schema spine.** `ext.code_anchors` is dual-read but writer
  emits the top-level `anchors` field. `memspec anchor` writes to the new
  location and records `verified_with: anchor`.
- **`memspec migrate` CLI.** Idempotent dry-run by default; `--apply` writes.
  Emits a per-source `source_kind` inference table BEFORE any writes so the
  operator reviews ambiguous strings (date-suffixed variants get bucketed
  together so the review surface stays short). `--override source=tier`
  accepts manual corrections without re-editing files. Migration covers
  field renames, state remap, anchor promotion, confidence relocation,
  `supersede_reason` backfill (`"(predates reason tracking)"` for
  historical corrections whose reason the v0.2 bug ate), `verified_with`
  inference (anchored + last_verified → `anchor`; ext last_verification with
  evidence → `evidence`; operator source → `operator`; else `assertion`),
  and stale-flagging items already past `check_by`. Files relocate to their
  v0.3 home (active claims to `memory/{type}s/`, superseded/retired to
  `archive/`). Second `--apply` is a no-op.
- **`memspec promote` deprecated.** The stabilization gate is gone in v0.3;
  the command stays on the CLI surface as a deprecation message until the
  Phase 3 tool-surface cut.
- **MCP tool surface cut to 9 (Phase 3).** Renamed: `add` →
  `memspec_remember` (anchors inline at write time, witness recorded as
  `anchor` / `operator` / `assertion` based on what's present), `correct` →
  `memspec_supersede` (now with `merge_from` for N→1 atomic collapse, `body`
  empty = retraction, `body` filled = replacement). New: `memspec_observe`
  (hard expiry, default 7d, no type/source classification — observations
  are agent-only by definition). Kept: `memspec_search`, `memspec_get`
  (adds lineage chain in response — walks `supersedes` backward and
  `superseded_by` forward), `memspec_verify` (anchorless requires
  evidence, as in v0.2), `memspec_anchor`, `memspec_reconcile`,
  `memspec_status` (absorbs `validate` schema check; adds conflict report,
  sweep candidates, witness counts). Removed from MCP: `memspec_add`,
  `memspec_correct`, `memspec_promote`, `memspec_consolidate`,
  `memspec_validate`, `memspec_decay`, `memspec_init`, `memspec_stores`.
- **Lazy stale flagging.** `store.loadActive()` now adds `stale: true` in
  memory for items past `check_by` without mutating the file — the flag
  shows up in search, sweep, and status without a separate `memspec decay`
  invocation. Persisted stale flags are still respected and cleared by
  `verify`. The `memspec decay` CLI is a deprecation shim that surfaces
  expired and drifted items read-only.
- **CLI deprecations.** `memspec validate` and `memspec consolidate` print
  a deprecation banner and point at the new surface (`status` for both;
  `supersede --merge-from` for the merge half of `consolidate`). They still
  report results so scripts limp through one release; the commands and the
  MCP-equivalent tools are gone in v0.4.

### Deferred to 0.3 (later phases — not in this slice)
- Search rebuild — single search path, per-set BM25 normalization, optional
  bodies in budget, witness/stale/conflict fields, `usage.jsonl` writes,
  mtime-cached on-disk FTS index (Phase 4).
- Boot context renderer rewrite — per-type freshness half-lives, usage
  boost, pinned and needs-attention sections, witness markers in every line
  (Phase 5).
- Config (`~/.memspec/config.yaml`), dream/digest scripts, `CLAUDE.md` and
  `AGENTS-ADDON.md` rewrite (Phase 6).
- Run migrate on the live `~/.memspec/` store (Phase 7 — Siim-supervised).

## 0.2.0 — Witnessed Claims, first slice

Backward-compatible at the schema level: readers tolerate records written
before this release. New fields are optional; old records reinterpret in place.

### Changed
- **`add` requires `--source`** ("unknown" rejected). The MCP server defaults
  the source to the connected client name. New records carry `source_kind`
  (`operator | agent | import`) inferred from the source string.
- **`correct` persists the reason** as `correction_reason` frontmatter on both
  the replacement and the archived original (previously the reason was
  discarded). The replacement's decay clock resets to the type default instead
  of inheriting from the dying record.
- **`correct --title`** lets the replacement take a fresh title.
- **`correct --supersede-by <id>`** points `corrected_by` at an existing memory
  instead of minting a new one — merging duplicates is now one call.
- **Operator records are protected**: correcting a record with effective
  `source_kind: operator` requires `--override-operator`, and the override is
  logged into the persisted correction reason.
- **Anchorless `verify` requires `--evidence`**; a bare self-verify is
  rejected. Evidence is recorded in `ext.last_verification.evidence`.
- **Anchors gain an optional `repo` field** for files in other repositories.
  Resolution: sibling of the project root, then `anchors.repo_search_paths`
  from `config.yaml`. Unavailable repos return `needs_review`
  ("anchor in repo X, fetch to verify") instead of failing hard.
- **`decay` flags instead of deleting**: items past TTL get `stale: true` and
  stay active and searchable; search results carry the flag. A successful
  verify clears it. The `--archive` option is removed.
- **New `memspec sweep`** (CLI-only, deliberately off the MCP surface):
  interactive per-item retirement of stale-flagged memories — the only path
  that physically removes items.
- **Boot context lines are actionable**: `memspec context` markdown now renders
  `- {id} {type} [{source_kind}] {⚓|✓Nd}: {title} — {preview ≤120 chars}` so
  every booted memory can be verified/corrected/anchored without a re-search.
