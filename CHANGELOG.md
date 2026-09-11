# Changelog

## 0.11.0 — unreleased

### Features

- **Read-path anchor drift.** `search` / `memspec_search` now flag an active anchored record whose code has changed since it was last anchored, without a separate `reconcile` run. CLI text prints a `[DRIFTED]` marker next to the stale marker; the JSON/MCP result carries `drifted`, `anchor_unchecked` (repo not checked out, so drift could not be checked), and a per-file `drift` list. `memspec_get` carries the same fields. The check never mutates files, never throws, memoizes blob SHAs per process (keyed by path+mtime+size) so a long-lived MCP server does not re-hash stable files per query, and only runs for active anchored records. Boot context is unchanged.
- **Search coverage disclosure.** Every search result now carries `coverage: none | weak | ok` plus a one-line `coverage_note`, so an agent can tell "the store has nothing on this" from a low-ranked hit instead of reading meaning into rank. `none` = zero active matches; `weak` = fewer than half the distinct query terms occur in the top hit (the note names which terms matched nothing), or the best hit is a title/tag-only match (no query term in its body), or it is barely above the BM25 floor; `ok` = a genuine match. The term-coverage component stops a mostly-absent multi-term query ("zebra quantum flamingo tariff") from reading as `ok` just because one term hit a record. A companion `coverage_witness` names the strongest witness among the hits (anchor > operator > evidence > assertion), so "the store claims this but only as an unverified assertion" is mechanical. CLI prints a final `Coverage:` line; MCP exposes the fields at the top of the search payload, and the `memspec_search` tool description tells agents to trust `coverage` over rank.
- **`--anchor-root` / `anchor_root`.** New option on `remember` and `anchor` (CLI `--anchor-root <dir>`, MCP `anchor_root`) naming the checkout a repo-relative anchor path belongs to when the file lives outside the store's project root. Recorded as a cross-repo anchor.
- **Usage receipts with outcomes.** `usage.jsonl` rows now carry `query` (truncated 200 chars), `session` (`MEMSPEC_SESSION_ID` > `CLAUDE_SESSION_ID` > a per-process id), `rank`, and `surface` (`cli` | `mcp`) alongside the existing `id`/`retrieved_at` — old rows without the new fields still read fine. A new append-only `outcomes.jsonl`, written by the new `memspec outcome <id> <useful|dead_end|corrected> [--note] [--source]` command and `memspec_outcome` MCP tool, records what happened after a memory was retrieved without ever mutating the record itself; `supersede` now writes a `corrected` outcome automatically for every id it collapses (replace, retract, and merge branches all covered). A new `src/lib/usage-stats.ts` derives, per id, `last_referenced`, distinct `sessions`, and outcome counts from the two logs — never written back to frontmatter — and surfaces them on search hits and `memspec_get` (`last_referenced`/`sessions`, present only when known). `status` gains two sections built on top: `## Cold` (active records created > 30 days ago that were never retrieved, or not retrieved in 60+ days) and `## Promotion candidates` (active observations, and assertion-witnessed facts created < 14 days ago, retrieved in 2+ distinct sessions with zero `dead_end` outcomes — "candidates only, nothing auto-promoted"). Both surface as `cold` / `promotion_candidates` arrays in the MCP `memspec_status` JSON.
- **Scope enforcement (`scopes_require`).** New top-level `config.yaml` key, default `false`. When `true`, a `remember`/`observe` write that resolves no scope at all (no `--scope`, cwd matches no `scopes:` pattern) is refused — same shape as the existing ambiguous-store refusal, naming the known scopes (declared config keys ∪ scopes already stamped on records) and the flag to pass. `--scope universal` remains the explicit, always-available opt-out.
- **`bin/repair-scope-backfill.mjs`.** One-shot backfill for records with no `scope:` field: derives a scope from a caller-supplied ordered tag→scope map (`--map plg:plg,piletilevi:plg,...`, case-insensitive, comma-separated). A record whose tags resolve to two different scopes is left untouched and reported ambiguous; a record matching nothing is left untouched and counted. Dry-run by default; `--apply` writes atomically with an undo journal (same pattern as `bin/repair-inferred-conflicts.mjs`); operator-sourced records are skipped unless `--include-operator`.
- **`verify --check-by` / `memspec_verify check_by`.** A clean verification can now set `check_by` explicitly (ISO 8601 or `"never"`) instead of always resetting it to the type default — how an operator pins an identity/event-shaped fact so it never comes up for review again. Ignored on a `needs_review` result, which never mutates the record regardless.
- **`sweep --answers <file>`.** Non-interactive alternative to the stdin prompt loop: reads one `<id>\t<y|n>` line per stale candidate (ids missing from the file default to `n`), prints the same per-item lines and retire count as the interactive path. `--dry-run` is unchanged and still lists candidates without prompting or reading answers.

### Fixes

- **Anchors written over MCP no longer silently fail** (root cause of only 94/1339 records being anchored in the personal store). The write side resolved every anchor path against the store's project root, so a repo-relative path sent by an agent working in another repo — the normal case for a home-rooted personal store, where the project root is `$HOME` — was "not found", warned, and the record degraded to witness `assertion`. The write side now mirrors the read side: absolute paths are recorded against their own git repo (repo-less when inside the store's project root); repo-relative paths are resolved under an optional `anchor_root`, then as a sibling repo (`repo:path` / `repo/path`), then under each `anchors.repo_search_paths` entry; the recorded `{repo, file}` round-trips through `verify` / `checkAnchors`. Paths that resolve nowhere produce an actionable warning ("pass an absolute path or anchor_root") instead of a bare "not found", and the `memspec_remember` / `memspec_anchor` tool descriptions now tell agents to pass absolute paths. Containment from the 0.10 hardening is preserved: a `..`, absolute, or symlink escape out of the resolved repo is treated as not found.

### Removed

- **Hybrid/embeddings search engine removed entirely.** Product decision, 2026-09-11: "drop the hybrid search entirely, it's been dead weight since the beginning." `src/lib/embeddings.ts` and its test are deleted; the `search:`/`SearchConfig`/`EmbeddingsConfig` config surface, the `--search-engine`/`--embeddings-*` CLI flags, and the corresponding `memspec init` prompts are gone. Retrieval is and stays FTS5/BM25 only — nothing in the runtime ever actually dispatched on `config.search.engine`, so this removes dead configuration surface, not a live code path. A pre-0.11 `search:` block in an existing `config.yaml` (deployed stores on other machines may still carry one) is ignored rather than rejected: `loadConfig` prints a one-line stderr warning (`memspec: config \`search:\` block is ignored (hybrid retrieval was removed in 0.11)`) once per process and otherwise behaves exactly as if the block were absent.

### Dream

Three v0.12 precursors, shipped ahead of the full dream-cycle proposal (`bin/dream`, `hooks/memspec-session-start.js`; both operator-side scripts, no `src/`/`test/` changes).

- **Detection now runs before the LLM leg, and survives its failure.** `bin/dream` computes a deterministic `## DETECT (deterministic)` section (counts + up to 15 ids each of stale records, drifted anchors, detected conflicts, sweep candidates, plus the newest committed experience digest and its age) from `memspec status`/`sweep --dry-run`/`reconcile --json` output, and writes it into the dream file whether the `claude` call that follows succeeds or fails. A FAILED pass now still tells the operator what the backlog looks like.
- **Proposals carry a disposition tier.** The dream prompt requires every proposal line to start with `[GREEN]` (mechanically safe/reversible), `[YELLOW]` (needs a second independent confirmation), or `[RED]` (human only). Labels only in this version — nothing is auto-applied — and a `## TIER SUMMARY` line (grep -c counts per tier) is appended after a successful run.
- **Session-start hook surfaces a project store's own dream pass, not just the personal one.** `hooks/memspec-session-start.js` still always checks `~/.memspec/dream/`, and now additionally checks the resolved store's `dream/` directory when it differs from the home store — each notice is now labeled `(store: <path>)` so a session with both never confuses which pass is which, with no duplication when the resolved store is the home store.

## 0.10.0 — 2026-08-19

**Conflict-edge integrity.** The lexical conflict-inference rule (same type, one shared tag, two shared title tokens) was measured 8/8 wrong on real attachments: it stamped `conflicts_with` onto records that merely discussed the same topic. Combined with an append-only edge store (no removal path), the store grew from 30 to 177 conflict-bearing records in 12 days, all permanent. This release makes conflict edges caller-controlled and retractable.

### Features

- **Inference is suggestion-only.** `remember` never writes an inferred `conflicts_with` edge. When a lexically similar same-type record exists, the result carries a `suggested_conflicts` list (id, title, one-line rationale) for the caller to act on. The high-band exact-title dedup refusal is unchanged. MCP responses expose `suggested_conflicts`; the old `auto_attached` field is gone.
- **Assert conflicts explicitly.** New `--conflicts-with <ids>` on `remember` (and `conflicts_with` on `memspec_remember`) writes caller-asserted conflict edges at write time. Each target is validated to exist, and a target already declared via a positive edge (refines/supports/depends_on) is rejected as a contradiction.
- **Edge provenance.** Conflict edges written deliberately (via `relate` or `remember --conflicts-with`) are marked `ext.edge_sources[target] = "asserted"`, distinguishing them from the heuristic backlog. Only conflict edges are tracked; the positive edge kinds were never inferred.
- **`unrelate` tool (CLI + MCP).** Removes a named edge of any type from a record: the first edge-retraction path in memspec. Logs every removal into `ext.edge_removals` (who, when, why; reason required); removing an absent edge is a reported no-op. Operator-sourced records are read-only over MCP (an autonomous agent cannot self-authorize edits to operator memory); the CLI keeps `--override-operator` for a human at a terminal.
- **`--drain-inferred` repair mode.** `bin/repair-inferred-conflicts.mjs --drain-inferred` drops the legacy heuristic `conflicts_with` backlog. Because pre-0.10 `relate` wrote deliberate edges with no provenance mark, drainability is reconstructed from git history: only edges present in a record's creation commit (remember's auto-attach) are dropped; edges introduced by a later commit (relate or a hand edit) are spared and listed in a manifest. Marked-asserted edges are always spared; operator records are skipped; a non-git store drains nothing (fail closed). The undo journal is written before any mutation. Same dry-run default and atomic writes as the overlap mode. Dry run against the live store: 205 creation-time edges would drop, 14 operator records skipped, 0 spared as post-creation (this store never used pre-0.10 `relate` for conflicts).
- **`relate` refuses contradictory edges.** A record can no longer both `conflicts_with` and positively relate to (refines/supports/depends_on) the same target. Both repair modes spare asserted edges and delete their `ext.edge_sources` entry when an edge is dropped.
- **Per-repo anchor rename detection and repair.** Rename detection now resolves each anchor to its own git repo (walking up to `.git`, honoring `anchors.repo_search_paths`) instead of assuming the store's parent is a repo, so it fires for home-rooted stores whose anchors point into sibling repos. New `reconcile --repair-renames` (dry-run; add `--apply` to write) re-points anchors whose file moved with byte-identical content. Content-changed anchors stay drifted on purpose: that is the signal to re-verify the claim.

### Fixes

- **Similarity auto-attach no longer overrides caller-declared edges** (foundation for the suggestion-only change): a `conflicts_with` was previously stamped onto targets the caller had already classified with a positive edge.
- **`status` reports the true stale count** by pushing `withLazyStale` into `loadAll` so every read consumer sees current staleness.
- **Hardening (adversarial review):** the drain's operator detector now matches `src/lib/source.ts` exactly (was a looser regex that both missed `human:<name>` operators and over-matched a bare "operator" substring); rename repair advances the reconcile checkpoint only on `--apply`, never on a dry run (a dry run used to skip the `--apply` rerun); rename repair matches anchors by `(repo, file)`, so same-named files in different repos are not both rewritten; anchor paths are canonicalized and contained to their resolved repo, so a `..`, absolute, or symlink escape is treated as unavailable rather than followed; and caller-asserted `--conflicts-with` targets are excluded from the returned suggestions.

### Engineering

- **Crash-atomic build.** `npm run build` compiles into `dist.new` and swaps it into place with renames (dist → dist.old, dist.new → dist, remove dist.old) instead of deleting `dist/` in place and rebuilding. A live MCP-server deployment under `dist/` is never half-written; the absence window is two renames (not the seconds of a compile) and is crash-recovered on the next build (dist.old restored). A `dist.lock` directory makes concurrent builds abort rather than race.
- **Scope routing on read and write** (since 0.9.0): records carry a `scope` matching a `scopes:` config key, enforced on every retrieval and write path; supersede/observe preserve scope; mixed-scope merges refuse to guess.
- **Command-output probe** (since 0.9.0): a stored shell command plus its stdout hash as a mechanical witness kind, re-checked only via explicit `memspec probe`, gated by a machine-local trustfile; `verify` never executes probes.
- **Composite layer rank-fusion** (since 0.9.0): layered stores fuse ranks with max rather than gating.
- **Version bumps** land `package-lock.json` at 0.10.0 (it had drifted to 0.7.2).

## 0.9.0 — 2026-07-27

**Transcript ingestion complete (stages 2-5): distill, reduce, dream diff.**

### Features

- **`memspec distill` command (stage 2).** Per-session LLM pass over normalized trajectories into short memory-formation digests at `<store>/local/digests/<source>/<session>.md`. Incremental by design — runs as sessions close, so a heavy week never becomes one un-fittable batch. Cheap model by default (`MEMSPEC_DISTILL_BIN`/`MEMSPEC_DISTILL_ARGS`, default `claude --model haiku -p`; falls back to `MEMSPEC_LLM_BIN`). Skip-rules for trivial sessions, per-run cap (`--limit`, default 25), 3-strike failure watermark, prompt budget (~400k chars) that keeps head+tail of giant sessions and elides the middle. Secret redaction (key/token/JWT/private-key shapes) applied to both prompt and digest.
- **`memspec reduce` command (stage 4).** Deterministic merge (zero LLM tokens) of fresh per-session digests into a committed experience digest at `<store>/digests/<date>-<hostname>.md` — hostname keeps multi-machine stores conflict-free. Self-gates to >= 6 days since last reduce (`--force` to override); raw trajectories and per-session digests stay local, only the redacted reduce output is committed.
- **Dream diffs digests against memory writes (stage 5).** `scripts/dream.sh` now feeds recent experience digests into the prompt and adds an `UNRECORDED WORK` section: work that demonstrably happened per the digests but produced no memory record — recognition failures write-time discipline structurally misses — each with a ready-to-run `memspec remember` proposal.

Scheduling (stage 3) is deliberately wall-clock-free: run `normalize` + `distill` + `reduce` from any wake-driven daily job (macOS launchd fires missed slots on wake; reduce and distill self-gate). Tests in `test/distill.test.ts`.

**Multi-store: pointer files + scope claims (anti-pollination).**

- **`.memspec.yaml` pointer file.** A repo without its own store can declare its store layers (same `stores:` schema as config.yaml, paths resolved against the pointer's directory) — this is how a service repo binds to a sibling team store while keeping a personal store as a read layer. A `.memspec/` directory closer to cwd always wins. Honored by retrieval (`search`/`context`/MCP via `CompositeStore.forCwd`) and writes.
- **Ambiguous writes refuse.** In a pointer-file repo with more than one writable layer, `remember` without `--store <name>` errors with the candidate list instead of guessing — a silently-guessed store is how team knowledge leaks into the personal store and vice versa. Single writable layer keeps working flag-free; non-pointer repos are unchanged.
- **`claims:` in store config + claim-routed reduce.** A store's config.yaml can declare the cwd patterns whose knowledge it owns (`~/git/kleidia`, `~/work/**`). `memspec reduce` routes each session digest to the highest-priority claiming store; sessions nobody claims are **held local** and never cross a sync boundary — they stay uncovered and route automatically once a claim appears. No claims configured anywhere = legacy single-store behaviour, byte-identical. Tests in `test/registry.test.ts`.

## 0.8.0 — 2026-07-27

**Transcript ingestion, stage 1 + dream-pass surfacing.**

### Features

- **`memspec normalize` command.** Normalizes harness session logs into trajectory-v1-shaped records (roles `meta/user/reasoning/assistant/tool`, after Letta's Trajectory format; own implementation, no dependency). Tool-agnostic core + per-harness adapters — shipped: `claude-code` (`~/.claude/projects/*/*.jsonl`; pairs `tool_use`/`tool_result` by id since results arrive as user-role lines) and `codex` (`~/.codex/sessions/**/rollout-*.jsonl`; drops `developer` boilerplate and `event_msg` duplicates). Output is LOCAL ONLY under `<store>/local/trajectories/` (`local/` must be gitignored — transcripts carry secrets and full file contents). Deterministic, zero LLM tokens; idempotent via a mtime+size watermark in `<store>/local/state.json`. Truncation: tool input 500 / output 1500 / thinking 2000 / text 10000 chars. Verified on 102 real sessions across both harnesses (113MB → 9MB). Tests in `test/normalize.test.ts`.

- **Dream-pass surfacing in the session-start hook.** `hooks/memspec-session-start.js` now reports unreviewed dream passes (`<home store>/dream/YYYY-MM-DD.md` without a `_Reviewed:` line): section counts, open questions, and review instructions are appended to the session-start context. Always checks the personal store, even when a project store wins resolution. Review marker is a `_Reviewed: <date> — <summary>` line under the title, git-synced across machines.

## 0.7.2 — 2026-07-14

**Bugfix: MCP/CLI store-root parity.** The MCP server read an empty phantom store while the CLI read the real one, whenever `MEMSPEC_ROOT` (or `--cwd`) pointed at a `.memspec` directory itself.

### Fixes

- **Idempotent `.memspec` resolution in `MemspecStore`.** The constructor appended `.memspec` to any path it was given, so a root that already ended in `.memspec` (e.g. `MEMSPEC_ROOT=~/.memspec`) doubled to `~/.memspec/.memspec` and resolved to a non-existent, empty store. The MCP server (`memspec_search`, `memspec_status`, …) hit this via `CompositeStore.forCwd`, returning 0 results against a populated store, while the CLI dodged it through `--store global` → `homedir()`. Resolution is now idempotent: a path whose basename is `.memspec` is used as-is; otherwise `.memspec` is appended. CLI and MCP now resolve to the same store. Regression tests in `test/store-root.test.ts`.

## 0.7.1 — 2026-07-07

**Linked-data projection + repo cleanup.** No runtime or storage changes; the CLI/MCP behaviour is identical to 0.7.0.

### Features

- **JSON-LD context + linked-data schema doc.** New `context.jsonld` maps every frontmatter field to standard vocabularies (Dublin Core, PROV-O, SKOS) where they exist and memspec-specific terms where they don't, enabling projection of a store to RDF via YAML-LD / JSON-LD. `SCHEMA-LD.md` is a human-readable companion with rationale per field, complementary to the auto-generated `SCHEMA.md`. Verified against a live 257-record store; class + concept vocabularies match the `src/lib/schema.ts` enum surface.

### Engineering

- Removed benchmarking and simulation tooling from the repo.
- Bumped `package-lock.json`, which had been left at 0.6.3 across the 0.7.0 release.

## 0.7.0 — 2026-06-30

**Dream pass.** First-party periodic reflection over the store. Plus a README pivot to lead with verification and drift detection, an explicit comparison against `AGENTS.md`, two documented trust profiles, and a relaxed Node engine floor.

### Features

- **`memspec-dream`** (new bin). Reads the last N days of memspec writes + git log, asks a headless LLM CLI to surface stale memories, supersede / merge candidates, verify candidates, missing typed relations, and behavioural rules worth promoting to your agent instruction file. Output is review material, never auto-applied. Defaults to `claude -p`; override with `MEMSPEC_LLM_BIN` / `MEMSPEC_LLM_ARGS` to use any other headless CLI. Optional autocommit behind `MEMSPEC_DREAM_AUTOCOMMIT=1`. Designed to run weekly via cron. Inspired by Aaron Fulkerson's Exo and the `dream-skill` prior art.

### Docs

- **README opener rewritten.** Leads with "Git-backed project memory for AI coding agents, with verification and drift detection." Anchors + drift detection + claim governance are the differentiators; the previous opener buried them under generic "structured memory" framing.
- **Quick start restructured** to demonstrate the `anchor → reconcile → verify | supersede` loop — the killer flow, not generic CRUD.
- **New "Why not just AGENTS.md?" section** with a five-row comparison table covering `AGENTS.md` / `MEMORY.md` scratchpads, vector DBs, hosted memory APIs, and memspec. Explicit "if your memory fits in one paragraph, don't use memspec" framing.
- **New "Trust profiles" section.** Two reference policies: *operator solo* (default, friction-free, suits single-operator setups) and *team review* (anchor-required facts, human-merged decisions, never-stored secrets). Memspec doesn't enforce; the instruction file does.
- **Dream pass documented** with usage, env vars, and a cron example.

### Engineering

- **Node engine floor dropped to `>=20.0.0`.** The `>=22` requirement was self-imposed — the source code uses only stable APIs available since Node 18, and the dependency tree's real floor is Node 20 (driven by `commander@14` and `better-sqlite3@12`). Pinning to 22 in early 2026, while Node 20 was still the current LTS, blocked teams on otherwise-supported environments for no technical reason.

### Bug fixes

- **`memspec-consolidate` hook prompt no longer instructs the agent to call removed commands.** The shipped hook at `hooks/memspec-consolidate.js` was telling agents to run `memspec add` and `memspec correct` — both deleted in v0.4. Any agent that followed the prompt got CLI errors and had to guess the replacements. Prompt now uses the current surface: `memspec remember` (with `--anchor` inline), `memspec supersede` (with `--merge-from` for collapses), `memspec verify`, `memspec anchor`, `memspec reconcile`, `memspec status`.

### Docs

- **SPEC.md caught up to shipping reality.** Title bumped `v0.5 → v0.7`. New "Changes in v0.6" and "Changes in v0.7" sections at the top. §5.1 documents the `include_superseded` query parameter (v0.6+). §8.2 drops the "v0.4 exposes" label (no new tools since v0.4). §8.3 adds the `relate` / `export` CLI surface and a pointer to `memspec-dream`. §4.1 drops the stale "(planned)" qualifier on `merge_from` (it shipped in v0.3). §12.4 calls out the known gap in retrieval-path auto-detection of `~/.memspec/` (tracked since v0.6.1).
- **BENCHMARK.md** gets a one-paragraph carry-forward note: v0.5 baselines hold for v0.6 / v0.7 because none of those releases touch the retrieval ranking path. Vocabulary in the body still says "graph expansion" — pinned to v0.5 branch tips; aliased to "linked-note following" in the header note.

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
