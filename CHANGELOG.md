# Changelog

## 0.3.0 — 2026-06-11

Witnessed claims, full slice. Schema rename, confidence retirement, dual-mode
reader, one-shot migrate CLI, search rebuild, boot context rewrite. Reader
accepts v0.2 records for one version; writer emits v0.3 only. Supersedes the
v0.2 "first slice" conceptually — same problem space, breaking redesign.

**Upgrading from v0.2 or earlier? Read [MIGRATION-v0.3.md](MIGRATION-v0.3.md).**

### ⚠ Breaking changes

- **MCP tools renamed.** `memspec_add` → `memspec_remember`,
  `memspec_correct` → `memspec_supersede`. Deprecation aliases answer under
  the old names for this release only (see below); they are removed in v0.4.
- **Six MCP tools deleted with no successor:** `memspec_promote`,
  `memspec_consolidate`, `memspec_validate`, `memspec_decay`,
  `memspec_init`, `memspec_stores`. Schema checking lives in
  `memspec_status`; merging lives in `memspec_supersede` + `merge_from`;
  stale flagging is automatic at read time; `init`/`stores` are CLI-only.
- **Schema field renames** (writer emits v0.3 only; reader is dual-mode for
  one version): `decay_after` → `check_by`, `corrects` → `supersedes`
  (string → array), `corrected_by` → `superseded_by`, `correction_reason` →
  `supersede_reason`, `ext.code_anchors` → top-level `anchors`.
- **State enum collapsed** to `active | superseded | retired`; the old
  `captured | corrected | decayed | archived` values are normalized on read.
- **`confidence` deleted.** Legacy values move to `ext.legacy_confidence`
  and are used nowhere; the `min_confidence` profile knob is a no-op.
- **Dedup refuses.** `remember` reports near-duplicates and points at
  `supersede` instead of silently writing a conflicting twin.
- **Anchorless `verify` requires evidence.** A bare self-verify is rejected.
- **Operator records are protected.** Superseding a claim with effective
  `source_kind: operator` requires `override_operator: true`, and the
  override is logged into the persisted reason.
- **`source` is required** on every write; `"unknown"` is rejected. The MCP
  server defaults to the connected client name.
- **Boot context format changed.** New header
  (`## Project memory — N active claims, M need attention …`), new
  `Needs attention` / `Pinned` / `Working set` sections, ids and witness
  markers on every line. Anything parsing the old render will break.
- **CLI deprecations:** `memspec add`, `memspec correct`,
  `memspec validate`, `memspec consolidate`, `memspec decay`,
  `memspec promote` print deprecation banners and limp through one release;
  all are gone in v0.4. `memspec migrate` files relocate to their v0.3 home
  (active claims to `memory/{type}s/`, superseded/retired to `archive/`).

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

- **Search rebuilt (Phase 4).** Single execution path, per-set BM25
  normalization, mtime-cached on-disk FTS index, `usage.jsonl` writes on
  result hits (feeds the boot ranking's usage boost). Results carry
  witness, stale, and conflict fields; `full=true` returns bodies inline
  under a token budget.
- **Boot context rewritten (Phase 5).** Ranking is
  `type_weight × freshness × usage_boost` with per-type half-lives
  (decision 180d, procedure 90d, fact 45d) clocked from `last_verified`.
  New sections above the working set: `Needs attention` (cap 3 — stale
  claims and drifted anchors, each with a scripted next move) and `Pinned`
  (cap 5, operator-only via the new `memspec remember --pin` CLI flag,
  deliberately absent from MCP). All sections spend from one 2000-token
  budget; the header carries store size and attention count.
- **`AGENTS-ADDON.md` rewritten.** Half the length — every instruction the
  tools now enforce was deleted; what remains is judgment the tools can't
  have, plus the conflict-resolution script that was missing.

### Deprecation aliases (removed in v0.4)

`memspec@0.2.0` is live on npm, so the renamed MCP primitives keep
answering under their old names for one minor version: `memspec_add`
forwards to `memspec_remember`, `memspec_correct` to `memspec_supersede`
(`replace` → `body`; `supersede_by` → merge into the named survivor).
Every shim response carries
`_deprecated: "use memspec_<new>; will be removed in v0.4"` plus a
DEPRECATED text block, and the server logs a warning to stderr. The six
deleted tools have no successor and no shim.

### Not in this release
- Migrating the operator's live `~/.memspec/` store (Phase 7 — manual,
  operator-supervised; see MIGRATION-v0.3.md for the procedure).

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
