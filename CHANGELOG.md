# Changelog

## 0.6.3 — 2026-06-30

Patch release. Fixes a stale hardcoded version string. No API or runtime
behaviour changes.

### Bug fixes

- **`memspec --version` (and the MCP server version) now report the real
  package version.** The version was hardcoded as `'0.6.1'` in
  `src/cli.ts` and `src/mcp.ts`, and `npm version` only bumps
  `package.json` — so the bump to 0.6.2 never reached the source. As a
  result the published 0.6.2 CLI still printed `0.6.1`. Both strings are
  now `0.6.3` and tracked with the release.

## 0.6.2 — 2026-06-30

Build-tooling patch. No runtime or API changes — the published package
behaves identically to 0.6.1. This release exists to stop shipping stale
compiled artifacts in the npm tarball.

### Build

- **`dist/` is now wiped before every build.** A new `clean` script runs
  ahead of `tsc`, so compiled outputs for commands removed in the v0.4
  rewrite (`add`, `consolidate`, `correct`, `decay`, `promote`,
  `validate`) no longer linger in `dist/` and get packed into the
  published tarball. `tsc` only overwrites files it regenerates, so
  without an explicit clean these orphans persisted indefinitely.
- **`postbuild` restores the bin executable bit.** Because `clean`
  deletes and recreates `dist/cli.js` and `dist/mcp.js`, the executable
  bit that the previous in-place `tsc` overwrite happened to preserve is
  lost. A `postbuild` step `chmod`s both bin files to `0o755` via Node's
  `fs.chmodSync` (a no-op on Windows). Both steps are dependency-free.

## 0.6.1 — 2026-06-30

Patch release. Fixes a silent failure mode in layered stores — the
`stores:` config block in `.memspec/config.yaml` was only honored by
the `memspec stores` listing command. Every retrieval path (search,
context, MCP) constructed a single `MemspecStore` directly and ignored
the configured layers, so records from lower-priority stores were
silently unreachable.

### Bug fixes

- **Layered stores honored by retrieval (`#2`).** `searchPayload`,
  `runContext`, and the MCP `memspec_get` handler now wrap their store
  construction in `CompositeStore.forCwd(cwd)`. With no `stores:`
  config present, behaviour is byte-identical to v0.6.0 (single-layer
  composite). When `stores:` is configured, records from all layers
  surface in search, context, and MCP retrieval — matching what
  `memspec stores` has been advertising all along.

  Reported and root-caused by [@KongFuzi1](https://github.com/KongFuzi1)
  (Mika Tsernobrivoi) on 2026-05-31. Fix scope follows their suggestion
  exactly. Thank you.

### Internal

- New `CompositeStore.forCwd(cwd)` static helper. Loads the project
  config and returns a CompositeStore wired to the configured layers,
  or a single-layer composite when no `stores:` is set. Used by the
  three retrieval entry points.
- New `CompositeStore.loadSuperseded()` method, mirroring the existing
  `loadActive()` and `loadAll()` surface so the v0.6 `include_superseded`
  feature works across layered stores.

### Tests

- New `test/layered-stores-retrieval.test.ts` (7 cases): repro from
  `#2`, no-layering regression guard, layer-precedence honoured,
  read-only layer write rejection, MCP search across layers, MCP get
  across layers.
- Total test count: 212 → 219.

### Known follow-up

`SPEC.md §12.4` mentions auto-detection of `~/.memspec` even without
explicit config. v0.6.1 only fixes the explicit-config case; the
auto-detection path is unchanged. If that promise matters, file a
follow-up issue — out of scope for this patch.

## 0.6.0 — 2026-06-30

**Linked Notes.** Vocabulary cleanup release: the feature formerly known
as "graph traversal on search" is now "follow links from each match into
its linked notes." API parameter names are unchanged, so v0.5 callers
work as-is. Two small bug fixes round out the release.

### Bug fixes

- **Archive expansion (`include_superseded`).** Real-store eval finding:
  `memspec_search --expand-edges` previously couldn't follow
  `supersedes` / `superseded_by` links into archived predecessors
  because the active-state filter ran before link-following. A new
  `include_superseded` flag on `memspec_search` lets link-following
  reach superseded records as targets while keeping search matches
  themselves active-only. Default false — no behaviour change for
  existing callers.
- **`scripts/run-bench.mjs` sample-size rendering.** `renderMarkdown`
  now reads per-condition `n` from each row instead of the module
  `SAMPLE_SIZE` constant. Eval runs at non-default sample sizes render
  correct headers without manual patching.

### Docs

- **Vocabulary swap: graph → linked notes.** SPEC.md, MCP tool
  descriptions, and `src/lib/schema.ts` field descriptions now use
  "linked notes" / "named links" / "follow links from each match"
  language instead of "graph traversal" / "typed edges" / "BFS hop
  depth." API parameter names unchanged (`expand_edges`, `edge_types`,
  `expand_depth`, `expanded_via` field stay). Code-internal names
  (`graph-walk.ts`, `EdgeType`, `expandGraph`) also unchanged — devs
  grepping for graph/BFS still find them. Motivated by operator
  feedback that the graph terminology was unnecessarily jargon-heavy
  for what is, mechanically, just "markdown files reference other
  markdown files by id, and search can optionally open those linked
  files too."
- **README cut from 437 → ~130 lines.** Restructured around: install →
  quick start → memory model → linked notes → tools → docs pointers.
  Removed redundant problem/why-this-shape/design-principles prose
  (lives in SPEC.md), trimmed install-and-how-it-works duplication,
  dropped "Who It Is For" framing. Uses linked-notes vocabulary
  throughout.

### Not in this release

- **LLM-driven query planning** — still a v0.7+ candidate; needs a
  pluggable LLM client design first.
- **Inbound link traversal** — current walker is outbound only; reverse
  index work deferred.
- **Code rename `graph-walk.ts` → `linked-notes.ts`** etc — cosmetic,
  would churn history with no functional value.

## 0.5.0 — 2026-06-29

**Connected + Measured.** Two retrieval-side features (graph traversal on
search, temporal validity intervals) plus the project's first homegrown
retrieval eval harness. Backward-compatible: every new field and parameter
is optional, missing values preserve v0.4 behaviour.

Motivated by arxiv 2606.24775 ("Are We Ready For An Agent-Native Memory
System?" — Zhou et al., June 2026). Findings O3 (lifecycle prevents stale
facts), O4 (graph organization wins cross-session), and O6 (consolidation
kills chronology, hurting time-dependent queries) drove this release's
design.

### Done

- **Graph traversal expansion on `memspec_search`.** `expand_edges: true`
  walks typed edges outward from BM25 seed hits. `edge_types` filter
  (default: all six — `refines`, `supports`, `depends_on`,
  `conflicts_with`, `supersedes`, `superseded_by`); `expand_depth` 1–3
  (default 1). Expanded hits carry an `expanded_via: {from_id, edge_type,
  hops}` field so the caller can see why a record surfaced. Hop scoring
  is BFS order — no numeric decay; `hops` is preserved on hits for
  future re-rankers. Outbound traversal only (inbound walk deferred).
- **Temporal validity intervals.** New optional `valid_from` / `valid_to`
  ISO8601 fields on `MemoryFrontmatter`. `memspec_search` accepts an
  `as_of` filter that drops records whose validity window excludes the
  given timestamp. Orthogonal to `check_by` (which is a review schedule,
  not a truth window). Missing bounds mean "always valid" — backward
  compatible with every v0.4 record.
- **`memspec_remember` accepts validity at write time.** Both MCP and
  CLI surfaces take optional `valid_from` / `valid_to`.
- **`memspec_get` returns validity fields** when present on the record.
- **BENCHMARK.md + `scripts/run-bench.mjs`.** Homegrown retrieval-only
  eval harness running against the public LongMemEval-S dataset.
  Recall@5, Recall@10, MRR, plus latency p50/p99. Four-condition
  comparison committed at v0.5 release. Methodology is documented and
  reproducible; not paper-comparable (different protocol, smaller
  sample), but a real measurement baseline for future regressions.

### Honest eval finding

v0.5 ships features without retrieval-quality regression. On the
LongMemEval-S Knowledge-Update slice (n=20), all five tested conditions
(v0.4 baseline, v0.5-graph no-expand, v0.5-graph expand=1,
v0.5-integration no-expand, v0.5-integration expand=1) saturate at
Recall@5/10/MRR = 1.000. The dataset/protocol doesn't differentiate
retrieval strategies because the ground-truth tags are lexically
distinctive enough that BM25 alone hits the ceiling.

Graph expansion's benefit needs richer datasets (LoCoMo multi-session,
or ingest protocols that build organic typed edges over time) to
surface. Cost-side measurement is meaningful: graph BFS adds roughly
5ms p50 and 5–10ms p99 latency even when walking an empty edge
frontier. The cost is small but real; the gain is unmeasurable on
this dataset.

### Not in this release

- **LLM-driven query planning** (the paper's "SimpleMem" pattern, Table
  5) — deferred to v0.6. Needs a pluggable LLM client design first.
- **Automatic extraction module** — deliberately rejected. memspec's
  identity is "the agent decides what to remember"; auto-extraction
  would change that contract.
- **Multi-engine storage backend** (the paper's third tier of memory
  representation) — scope creep for now.
- **Inbound graph walks** — `expand_edges` is outbound-only in v0.5.
- **`memspec_unrelate`** — still out of scope.

## 0.4.0 — 2026-06-28

Graph primitives plus the final v0.3-shim cleanup. Typed relation edges
(`refines`, `supports`, `depends_on`) become first-class alongside the
existing supersede/conflict edges; `memspec_relate` wires them after the
fact, `memspec_export` dumps the graph for visualization, operator-tier
records segregate on disk, and the v0.3 deprecation aliases — both MCP and
CLI — are gone.

**Upgrading from v0.2 or v0.3? `memspec migrate --apply` hops in one pass.
See [MIGRATION-v0.3.md](MIGRATION-v0.3.md).**

### ⚠ Breaking changes

- **MCP deprecation aliases removed.** `memspec_add` and `memspec_correct`
  no longer exist. Use `memspec_remember` and `memspec_supersede`. The
  `_deprecated` field on alias responses is gone with them.
- **CLI deprecation shims removed.** `memspec add`, `memspec correct`,
  `memspec validate`, `memspec consolidate`, `memspec decay`, and
  `memspec promote` no longer exist. Use `memspec remember`,
  `memspec supersede`, `memspec status` (replaces `validate`), and
  `memspec supersede --merge-from` (replaces the merge half of
  `consolidate`). Decay flagging is automatic at read time;
  `promote`/stabilization is gone entirely with witness chain as the
  replacement strength signal.
- **`memspec_remember` now actually refuses near-duplicates.** v0.3 documented
  the refusal but only emitted a warning; v0.4 refuses and points at
  `memspec_supersede`. Opt out with `force: true`.
- **Operator-tier records relocate.** Records whose effective
  `source_kind` resolves to `operator` now live in
  `memory/operator/{facts,decisions,procedures}/`. The reader handles both
  paths during the transition (operator-tier wins on collision, with a
  stderr warning); `memspec migrate` relocates existing operator-sourced
  records on `--apply`.

### Done

- **Typed relation edges.** Three new optional frontmatter fields on every
  record: `refines` (this record elaborates on the parent; the parent stays
  valid), `supports` (this record is evidence for the target), `depends_on`
  (knowledge or chronological dependency). All are `string[]` of memory ids
  and sit alongside the existing `supersedes` / `superseded_by` /
  `conflicts_with` edges. No parallel relations store — edges live on the
  record like they always have.
- **`memspec_relate` (new MCP tool, new CLI command).** Wires a typed edge
  from one memory to another after the fact, for when the edge was missed
  at write time. Accepts `refines`, `supports`, `depends_on`, or
  `conflicts_with`.
- **`memspec_export` (new MCP tool, new CLI command).** Dumps the memory
  graph (nodes + edges) as JSONL, GraphML, or DOT to stdout. Active-only by
  default; `--include-superseded` pulls archived records too;
  `--types fact,decision` narrows. Export only — pipe to Gephi, Cytoscape,
  or graphviz for visualization; no built-in renderer.
- **`memspec_get` walks the relation graph.** Lineage now follows `refines`,
  `supports`, and `depends_on` chains alongside the existing supersede DAG.
  Depth-capped at 3, cycle-safe.
- **`memspec_search` surfaces relation edges** on result objects, parity
  with `conflicts_with`.
- **`memspec_remember` write-path neighbour-walk.** Mid-band similarity
  (below the refusal threshold, above noise — matching the v0.3
  conflict-inference rule) now auto-attaches a suggested `conflicts_with`
  edge to the closest candidate. High-band still refuses. Operator-tier
  candidates are excluded from agent auto-attach so the operator's record
  isn't silently amended by an agent write.
- **Operator-tier path segregation.** Active claims whose effective
  `source_kind` is `operator` write to and load from
  `memory/operator/{type}s/<id>.md`. Observations and archived records are
  tier-agnostic and stay put. The reader accepts both paths;
  operator-tier wins on collision with a stderr warning.
- **`memspec migrate` v0.4.** The one-shot migrate CLI now hops v0.2 or
  v0.3 stores straight to v0.4. The pre-migration report adds an
  `Operator-tier relocations` block (listing every record that would move,
  with source string), a `Schema field migrations` roll-up counting each
  legacy → v0.3 rename across the store, and a `v0.4 additions` reminder.
  Idempotent; partial runs resume cleanly. Resume protocol documented in
  MIGRATION-v0.3.md.
- **Generated `SCHEMA.md`** at repo root, regenerated by `npm run schema`
  from `src/lib/schema.ts` via Zod introspection. `npm run check` includes
  `schema:check` to fail on doc drift.
- **`inference.ts` extracted** as a shared module so the conflict-inference
  rule has a single source of truth used by both search (read-time) and
  remember (write-time).
- **`lineage.ts` walker generalized** to handle the new typed relation
  types.
- **Operator scripts updated** to v0.4 schema and vocabulary
  (`~/.memspec/bin/digest`, `~/.memspec/bin/dream` — operator-side change,
  out of this repo).

### Not in this release

- `memspec_unrelate` — removing edges remains out of scope until v0.5.
- Built-in graph visualizer — export only; pipe to Gephi, Cytoscape, or
  graphviz.
- Float-typed edge weights or per-edge metadata — edges are simple ids.
- Embedding-based neighbour-walk extension — lexical only; matches the
  v0.3 inference rule.

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
