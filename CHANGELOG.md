# Changelog

## Unreleased

Measured against a 2,366-record real store and a new wrongness benchmark; numbers in BENCHMARK.md.

### Security

- **Write authority comes from the channel (#12).** No MCP path can create, modify, re-anchor, re-witness, merge into or retract an operator-tier record (`remember`, `supersede` in every branch, `verify`, `anchor`, `reconcile` apply, `relate`, `question`; `unrelate` already refused). `override_operator` is removed from the MCP schema. An operator-looking `source` over MCP (`siim`, `user...`, `human:...`) is stored as `mcp:<source>` at agent tier with the claim kept in `ext.claimed_source`. **Behaviour change:** an agent relaying "the user says X" now writes an agent-tier record; operator records come from the CLI.
- **OKF import re-derives trust (#10).** A bundle cannot grant operator tier, `pinned`, a strong witness or a future `last_verified`; `--trusted` keeps them for your own backups.

### Features

- **Tiered matching (#9).** Records carrying every query term rank first; a short page is topped up with partial matches below them. A query with one word the right record lacks no longer drops it (real store: R@10 0.95 -> 1.00).
- **Calibrated coverage (#9).** With no full-term hit, coverage is `weak` unless the best hit carries 3/4 of the content terms (paraphrase misses read `weak` 32/41 times, was 0/41).
- **Near-duplicate and rejected-value refusals (#12, #13).** `remember` refuses a claim with the same identifiers and wording as an active one (was exact title only); claims that name different identifiers (symbols, paths, numbers, quoted literals) are different claims, so templated facts about different symbols are written. Over MCP, re-asserting a value a supersede replaced or retracted is refused across types, scopes and store layers unless the claim is measurably closer to the current value. Merges are consolidation, not rejection. CLI `--allow-rejected` overrides with a log. Lexical and best-effort; limits listed in SPEC.md.
- **`verify --reanchor` (#12)** re-baselines anchors on a claim that still holds, keeping the old SHAs in `ext.anchor_history`.
- **OKF v0.2 export/import (#10).** `export --format okf --out <dir>`, `import --format okf <dir>`; lossless round trip, evidence blobs travel with the bundle.
- **Wrongness benchmark (#11)** in `scripts/bench-wrongness/`: stale-served and false-alarm rates on a 367-commit Hono replay, plus a planted-contradiction test of `memspec check`.

### Fixes

- **Search is ~7x faster on large stores (#9).** Parsed records are cached per file; 0.13.0 re-read and YAML-parsed every record on every query (295 ms -> 38 ms warm at 2,366 records). The 0.11.0 latency step (coverage reading back every hit token) is gone.
- **Worktree anchors (#12)** record the main repository, not the worktree folder name (they read `repo_unavailable` once the worktree was removed), and warn when anchoring an unmerged change.
- `min_confidence` removed (retired in v0.3, never read); old configs still load.
- **MCP input limits (#13):** titles <= 1,000 characters, bodies and observation text <= 20,000; claim tokenizing is linear-time (a quadratic trim regex reachable from any MCP body took 38.5 s on 200,000 characters).
- Release tarballs no longer committed.

## 0.13.0 — 2026-10-19

### Security

- **Front matter is YAML only; `---js` no longer executes code.** gray-matter's defaults evaluate non-YAML front matter with `eval`: a record file opening with `---js` / `---javascript` (any case, `--- js` with whitespace too) ran its block as JavaScript the moment memspec parsed it. That affects **every earlier version** (all used gray-matter's defaults): any store a session, hook, MCP server or CI job read could execute code as that user, and in `memspec check` a `process.exit(0)` payload turned the gate green. Every parse now goes through one wrapper (`src/lib/safe-matter.ts`: store load, `parseMemoryFile`, `check`'s base-version parse, `status`, `migrate`, brownfield import, `config.yaml` and pointer files; the two `bin/repair-*.mjs` scripts carry a replica): any language tag other than empty, `yaml` or `yml` is refused with an error, and gray-matter's `javascript`/`js`, `coffee` and `json` engines are replaced with ones that throw, so a detection mismatch cannot reach `eval` either. JSON front matter is refused too (memspec never wrote it). The store loader turns the refusal into a load warning: other commands skip the file with a warning, `check` reports it as `invalid`. Serialisation no longer re-parses the body (`matter.stringify(str)` parsed `str` with the default engines first, so `migrate` evaluated a record BODY that opened with `---js`).

### Fixed (review panel, before release)

- **The frontmatter-only skip could be gamed.** A changed record is skipped only when its base version was an active claim, its claim content matches (the content key now also covers `type`, `valid_from`, `valid_to` and `scope`), and no acknowledgement or `conflicts_with` it carried to a still-active claim was removed (dropping a declared conflict re-checks the pair instead of hiding it). Reviving an archived or retired record, or `unrelate`-ing an acknowledgement, is now checked. A question group that is changed or deleted puts every answer it no longer files (and that is still active) into the checked set; a deleted claim file whose id still loads from another copy without the acknowledgement it carried puts those targets in too (acknowledgements and declared conflicts alike). Deletions are read with a second `git diff --diff-filter=D`. Base versions are looked up only under `memory/`, `observations/` and `archive/` (a `<id>.md` under `evidence/` is not one).
- **Declared conflicts count in both directions.** A changed record that an unchanged active record lists in `conflicts_with` is a `declared_conflict` too, unless one question group files both.
- **Contradictory edge lists are findings.** A record that names the same target in `distinct_from` and in any other edge list (`refines`, `supports`, `depends_on`, `derived_from`, `conflicts_with`, `supersedes`; writers refuse it, a hand edit or import can still carry it) is `invalid`, with the edge kinds named, and its edges to that target acknowledge nothing. Git mode reports it for changed files, `--all` for every record.
- **Duplicate record ids are findings.** The loader keeps one copy (operator path wins, else the first file read, which depends on directory order); `MemspecStore.duplicateIds` now lists every id carried by more than one file (files sorted). Every duplicate set is `invalid` (every file listed), in git mode and with `--all`, whether or not the change set touches it: the copy the loader discards could be the one a new record overlaps. Independent of which copy the loader kept. Not a load warning, so other commands' output is unchanged.
- **Symlinks cannot hide records.** Git mode refuses (exit 2) a store whose root, or anything under `memory/`, `observations/` or `archive/`, is a symlink (`memory -> ../notes` made every record behind it invisible to the diff), and reports any other changed symlink under the store as `invalid`. `invalid` now covers changed `.md` files under all three record directories (questions live in `observations/`), not only `memory/`.
- **`supersedes` is no longer an acknowledgement.** A changed active record whose `supersedes` names a record that is still ACTIVE (or an active survivor naming a changed record) is an `unapplied_supersede` finding: the supersede was never applied to the target. In a team store this is the promote PR that copies a local survivor without archiving the target it replaces. Fix: move the target to `archive/` with `state: superseded` and `superseded_by`, or let `memspec supersede` do it in that store.
- **A store git never tracks is exit 2.** When the store has record files but none of them is in the index (gitignored, or `--store` pointing at an untracked copy), git mode fails closed instead of reporting "0 checked, ok". Untracked new files in a tracked store still count as changed.
- **Title tokenising is linear.** The edge-punctuation trim backtracked quadratically (a 200 KB punctuation title took 17 s); it is an index scan now, and only the first 500 characters of a title are tokenised.
- **`distinct_from` exclusion holds in both directions.** `relate` refuses `distinct_from` when either record lists the other on any other edge (`supersedes` included), and any other edge when either record lists the other in `distinct_from`; `remember` runs the same shared check (`distinctFromExclusion`) against each target.
- **`supersede --merge-from` drops the survivor's `distinct_from` to every id it now supersedes.**

Contradicting records were merging into team stores silently. One file per record means git never conflicts, and `remember`'s near-duplicate refusal and `suggested_conflicts` are same-type and only see the writer's local view. The motivating pair: an unanchored `fact` (charges apply only to units with an explicit row; its body names the billing module) and a later `decision` anchored to that same module (no rows at all means every unit is charged). Different type, different title, both active, merged a week apart.

### Added

- **`memspec check`: merge-time contradiction check.** `memspec check [--base <ref>] [--all] [--store <dir>] [--json]` fails when a change set adds or edits an active claim that plausibly overlaps another active claim in the same store (any type) with no recorded relation between them. Exit 0 = clean, 1 = findings, 2 = usage or git error (fail closed: CI never reads an error as a pass, and a typo in the invocation is 2 too). Library: `runCheck` / `renderCheckText` in `src/commands/check.ts`. No MCP tool in this version.
  - **Change set.** Git mode diffs the WORKING TREE against `git merge-base <base> HEAD` under the store (`--no-renames`; deletions read separately, see Fixed above) plus untracked files, so uncommitted edits count. `--base` defaults to the remote default branch (`origin/HEAD` → `origin/main` → `origin/master`, local refs only); unresolvable base, no merge-base, or a store outside a git working tree is exit 2. `--all` audits every active claim and needs no git. Single store only (`MemspecStore`), never the layered view: the check is about the files in this repo.
  - **Content-changed only.** A record joins the checked set only when it is new at the merge-base, was not an active claim there, lost an acknowledgement, or its claim content (normalised title, body, the set of anchored files without their shas, type, validity window, scope) differs from the base version, found by record id rather than path, so a record moved between directories is still the same record. Frontmatter-only edits (verify, check_by, tags, anchor sha refresh, added edges) do not: a triage PR re-verifying thirty records must not light up every pre-existing pair they touch. The count is reported as `skipped_unchanged_content`.
  - **Pair signal.** Title terms are the title's words minus short words and stopwords (the search-coverage list, now `src/lib/stopwords.ts`), tokenised in one pass with the index tokenizer, minus tokens with digits, and in a store of at least 40 active claims minus tokens in more than 5% of titles. A pair is flagged when it shares an anchored file or one record's text names a file the other is anchored to (paths of 5+ characters) AND it shares 2+ title terms, or when it shares 3+ title terms with overlap (shared / smaller set) of at least 0.5. Thresholds are exported constants. On the 227-record team store that motivated this, the rule flags roughly 27-45 pairs store-wide (under 0.5 neighbours per record) and catches the motivating pair.
  - **Acknowledgement.** A pair passes when either record lists the other in `refines`, `supports`, `depends_on`, `derived_from` or `distinct_from`, or a question group lists both as answers (`supersedes` to a still-active record is an `unapplied_supersede` finding instead). `conflicts_with` does not acknowledge: two active records with a declared conflict are a known contradiction about to sit in the store, reported as `declared_conflict`. That applies to any changed record FILE (frontmatter-only edits included) carrying `conflicts_with` to an active record, signal or not; it clears by superseding one side or filing both in a question group.
  - A changed record file under `memory/`, `observations/` or `archive/` that fails to load (or whose id duplicates another file's) is an `invalid` finding. Output: one block per finding, a resolution menu with the first finding's ids filled in (supersede / relate / question / `relate --type distinct_from`), and a summary line; `--json` emits `{ ok, mode, base?, merge_base?, store, checked, skipped_unchanged_content, pairs, invalid }` with paths relative to the repo top. Writes nothing (no usage receipts, no FTS cache; tokenising uses an in-memory table). Git runs without a shell, with the repo-locating `GIT_*` variables stripped, through a new uncached `gitRaw` helper in `git-state.ts` (30 s timeout, untrimmed output).
- **`distinct_from` relation.** New optional frontmatter array: the writer compared this record with each target and they are independent claims (neither contradicts, refines, supports nor depends on the other). It is the honest way to clear a `memspec check` finding that is a false positive. Writable via `relate`/`unrelate --type distinct_from` (CLI, MCP `memspec_relate`/`memspec_unrelate`; `unrelate` logs into `ext.edge_removals` like every edge) and at creation via `remember --distinct-from` / MCP `distinct_from` (targets must exist; counted in the neighbour-window widening and excluded from `suggested_conflicts` like the other declared edges). Mutually exclusive with every other edge between the same two records, whichever record carries either edge, and in a single `remember` call. Not a retrieval edge: search expansion and lineage do not follow it, and search results are unchanged. Export emits it (DOT: gray, dotted); `memspec_get` echoes it when present; `supersede` does not carry it to a replacement, same as the other edges. SCHEMA.md, `context.jsonld` (`memspec:distinctFrom`) and SCHEMA-LD.md updated.

## 0.12.3 — 2026-10-18

- **`init` honours `CLAUDE_CONFIG_DIR`.** Hooks were always copied to `~/.claude/hooks` and registered in `~/.claude/settings.json`, so sessions running Claude Code from another config directory never loaded them. `init` now installs and registers into `$CLAUDE_CONFIG_DIR` when it is set, with the hook command as an absolute, single-quoted path because such directories often contain spaces. `~/.claude` keeps the portable `node "$HOME/.claude/hooks/<file>"` command, so existing installs match. The value must be absolute, as Claude Code requires (it does not expand `~`); a relative or `~` value is reported and the install skipped, and so is a directory that does not exist.
- **Registration is recognised by what the entry runs.** `$HOME`, `${HOME}`, `~/` and shell quoting are understood, and exec-form entries (`command` plus `args`) are read too, so an existing exec-form registration is no longer duplicated. In a non-default directory, an entry that is exactly `node <the ~/.claude copy>` is repointed to the directory's own copy instead of adding a second entry; a wrapper, a chained command or any other path is left as it was.
- **The claims-check hook looks in the same directory.** `memspec-claims-check.js` checks `$CLAUDE_CONFIG_DIR` (else `~/.claude`) for the session hook, names the directory it read, and warns on a non-absolute value. `runClaimsCheck(home, env)` takes the environment as a second argument. Known limit: with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` the variable does not reach the hook, so the check reads `~/.claude`.
- **`memspec init <path>`.** The project root can be given positionally, same as `--cwd`; both with different values is an error. `memspec init ~/.memspec` initialises that directory as the store (a `.memspec` path is the store itself, as everywhere else), and re-running it is no longer refused as a nested store.
- **Tests no longer write into the developer's Claude config.** `runCli` points `CLAUDE_CONFIG_DIR` at a path that does not exist, under a directory the test process creates (unique, mode 0700), unless a test sets its own; the claims-check tests pass an explicit environment. Before, `init` tests installed hooks into the real `~/.claude`.

## 0.12.2 — 2026-10-17

- **`verify` agrees with the read path.** It now judges anchors the way search/get/context/status do since 0.12.0: an anchor holds when its recorded blob matches the working tree OR origin's default branch. Before, `verify` hashed only the working tree, so a record anchored to main (for example from a separate checkout via `--anchor-root`) verified as NEEDS REVIEW from any checkout sitting on another branch while search showed it clean. `reconcile` keeps working-tree semantics (it answers "what did this checkout change"). Its message names any anchor that held only on the default branch ("matched origin/main only (this checkout's copy differs)"); README and SPEC §13.3 updated to the either-side rule.

## 0.12.1 — 2026-10-17

- **Security:** transitive `proxy-addr` 2.0.7 → 2.0.8 (via `@modelcontextprotocol/sdk` → `express`), clearing CVE-2026-90711 flagged by Trivy. Lockfile-only; no other package moved.

## 0.12.0 — 2026-10-17

Stop presenting old, unverified records as current truth. Origin: a team-store decision imported with legacy `decay_after: never`, no anchors, witness `assertion`, last verified months earlier, kept ranking `stale: false` after the auth system and vendor price it cited had changed; an agent repeated it as fact, a stale-record cleanup never saw it, and a local correction could not displace it because the team layer is read-only.

### Changed

- **Legacy `decay_after: never` no longer means never.** When a record carries `decay_after: never` and no explicit `check_by`, normalisation (`normalizeLegacyFrontmatter`, new `legacyNeverCheckBy`) gives it the type's TTL from `last_verified`, else `created`, so the read-time stale flag applies. The TTL is the store's `config.yaml` `decay:` value for that type (store load and `memspec migrate` pass it; new `decayDaysByType`), else `DEFAULT_DECAY_DAYS`. Read-time only: search/get rewrite nothing. `memspec migrate` persists the same date instead of writing `check_by: never`. A legacy dated `decay_after` maps as before, and an explicit `check_by: never` (`verify --check-by never`, event records) stays honoured. This applies to operator-sourced legacy records too; re-pin one with `verify --check-by never` if `never` was deliberate.
- **`supersede` of a read-only-layer record with a replacement body now takes effect locally.** When the read view has exactly one writable layer, the replacement is written there with `supersedes: [<target>]`, the read-only file is untouched, and the result carries `pending_promotion: { layer, target_id }` (CLI text says so; MCP `memspec_supersede` returns the field). Retraction, merge, and an ambiguous writable layer keep the existing refusal. The "already superseded in this view" check and the write run under an exclusive per-target lock (`local/locks/supersede-<target>.lock` in the writable layer, created with `wx`, removed in `finally`; one older than 30 s is a crashed writer's and is reclaimed), so two concurrent supersedes of one read-only record cannot both write a replacement; the loser gets "another supersede … is in progress" or "already superseded".

### Added

- **Aging signal.** Search hits (CLI text/JSON, MCP `memspec_search`) and `memspec_get` carry `aged: true` + `unverified_days` for an active claim witnessed only by `assertion` and unverified for longer than `aging_days` (new top-level `config.yaml` key, default 90, `0` disables; a non-integer or negative value is a config error). Independent of `check_by`; never set on explicit `check_by: never` pins or on records already `stale: true`. Text renderers print `[UNVERIFIED <N>d — check before relying]`. Ranking is unchanged. `memspec_get` now also reports `stale`.
- **Superseded-in-view.** In a layered view, a read-only-layer record superseded by an active writable-layer record (written by `supersede` or by hand) is dropped from active search results and boot context (`CompositeStore.loadActive`/`search`), served from `loadAll` as superseded, and reported by `memspec_get` as `state: "superseded-in-view"` with `superseded_by` and `layer`. A local correction of the replacement inherits the claim; a chain ending in a retraction withdraws it.
- **`memspec status` pending promotions.** New `pending_promotions` array in the status report (MCP JSON) and a `Pending promotions` text section: local record id, target id, target layer, the input for the promotion PR to the team repo. When two live local records supersede the same target, the lowest id holds it in the view and the others are listed as `conflicting_ids` (text: `CONFLICT: also superseded by …`), so the result no longer depends on file order. `CompositeStore.pendingPromotions()` is memoized per view, keyed by each layer's presence and write generation (new `MemspecStore.writeGeneration`), so one search parses the layers once instead of up to four times.
- **Stale layer checkouts are reported (`layers_stale`).** A configured store layer whose directory sits in a git checkout that is behind its remote default branch (at least one commit not reachable from HEAD) is listed as `{ name, path, branch, default_branch, behind }` on search payloads, record and `type: question` searches alike (CLI `--json`, MCP `memspec_search` structuredContent, present only when non-empty). Being on another branch, or detached, does not count by itself: a detached CI checkout at origin/main, or a branch containing main, reads everything merged. (The question search path now carries `layers_unavailable` too.) Also reported as a `Warning: store layer '<name>' reads branch '<branch>', N commit(s) behind origin/main as of the last fetch; its records may be outdated` line under `Coverage:`, and as a `layers_stale` field + `## Layers stale` section in `memspec status`. Default branch from local refs only: `origin/HEAD` when it resolves, else `origin/main`, else `origin/master` (an `origin/HEAD` left pointing at a pruned ref falls through; `git remote set-head origin -a` repoints it after an upstream rename); none resolves → the layer is skipped. Detached HEAD reports the short sha as `branch`. Never fetches, never throws (git missing / not a repo / error → skipped); git runs without a shell, with a 2 s timeout and the repo-locating `GIT_*` variables stripped, and repo state is cached per process for 10 s so a long-lived MCP server does not spawn git per query but notices a checkout switch or fetch. Only declared layer sets are checked, not the unlayered single-store fallback. Origin: a read-only team layer's checkout sat on a merged branch, 46 commits behind main, for a month while every session read its records unwarned.

### Changed (anchor drift)

- **Read-path anchor drift also consults the remote default branch.** `search`, `memspec_get`, boot `context` attention, and `status`'s drift count (new `compareAnchorReadPath`) treat an anchor as drifted only when its recorded sha matches NEITHER the working-tree blob NOR the blob at `origin/<default>` (`git rev-parse <sha>:<path>`). So a checkout on a feature branch no longer marks records anchored to main as drifted, and a record anchored on that branch is not drifted either: `verify`, `reconcile` and `anchor` hash the working tree, and the read path can no longer flag a fresh anchor they would call unchanged. `missing` when the file is absent from both. The working tree alone decides when the repo has no remote default ref, the anchored file is gitignored, or git fails. Each per-file `drift` entry carries `compared_to: "worktree+<ref>" | "worktree"` (absent on `repo_unavailable`). A symlinked anchor (or one under a symlinked directory) is looked up on the ref by its resolved target path, like for like with the working-tree hash that follows the link. `status`'s drift count now passes `anchors.repo_search_paths` as search does. Blob lookups are memoized per (repo, ref commit sha, path); the gitignored check behind them follows the 10 s TTL, since ignore rules live in the working tree. `checkAnchors` gains `compareTo: 'worktree' | 'default-branch'` (default `worktree`). Consequence to know: a change that landed on main is not drift while the checkout still holds the recorded file; it shows once the checkout moves.

## 0.11.0 — 2026-09-11

### Security (release gate, 2026-09-16)

- **Evidence attachments default-deny secret-shaped sources.** `--evidence` / `evidence` / `evidence_file` copy into the committed `evidence/` dir, and the path is attacker-controlled on the MCP surface (a prompt-injected agent could attach `~/.ssh/id_rsa` and the next store sync would push it). `validateEvidenceSource` now also refuses: any hidden (dot-prefixed) path component outside the store itself (`MEMSPEC_EVIDENCE_ALLOW_HIDDEN=1` lifts only this rule, for a deliberate CLI run), secret-by-convention file names (`.env*`, `.netrc`, `.npmrc`, ssh key names, `credentials*`, `*.pem/.key/.p12/.pfx/.jks/.keystore/.kdbx/.ppk`), and content carrying a private-key block or a well-known access-token format (AWS, GitHub, Anthropic, OpenAI-style, Slack, npm, GitLab). Decided before any byte is copied, like every other refusal. Blind security side-pass finding.
- **Trusted-pointer check rejects foreign-group-writable directories.** `.memspec.yaml` redirects reads and writes; a pointer in a directory writable by a group other than the caller's is now ignored like a world-writable one (shared project groups could plant it).

### Fixes from the release-gate consort panel (Codex gpt-5.6 + Gemini 3.1 Pro, 2026-09-16)

- **`observe` resolves its write target like `remember`.** It built `new MemspecStore(cwd)` directly, so in a `.memspec.yaml`-bound repo it created a phantom `<cwd>/.memspec` and it could write past a layer's `writable: false`. Both commands now share `CompositeStore.resolveWritableWithDefaults` (both legs found this).
- **Unavailable layers are disclosed.** `layersUnavailable` was computed but consumed nowhere: a missing team checkout read as `coverage: none`. `search`/`memspec_search` now carry `layers_unavailable` (name, path, writable) when non-empty, the text renderer prints a `Warning: store layer '<name>' … is not available at <path>` line under `Coverage:`, and `status` gains a `## Layers unavailable` section (`layers_unavailable` in JSON).
- **Evidence destination is checked no-follow.** A synced store can carry `evidence/` or `evidence/<sha>` as a symlink; the lexical containment check passed and the copy followed it out of the store. Symlinked evidence root/shard/file are refused and the real destination is verified against the real evidence root after `mkdir`.
- **Outcome-only writes keep `.gitignore` current and report loss.** `appendOutcome` (CLI `outcome`, MCP `memspec_outcome`, `supersede`) now calls `ensureStoreGitignore` first — on a pre-0.11 store the first outcome used to create `outcomes.jsonl` un-ignored — and returns `false` instead of swallowing a write failure; `memspec outcome` then errors instead of printing "Recorded".
- **`relate` finds cross-layer targets.** The edge is written onto `--from` only, so `--to` may live in any layer of the read view (a read-only team record included), matching what `remember --supports/--refines` already accepted. Previously "Memory not found".
- **Session-start hook parses the documented scope forms.** Inline lists (`kleidia: [~/git/kleidia, ~/git/kleidia-docs]`) and quoted entries resolved to no scope, so the hook ran `context` unscoped. Comments and blank lines inside `scopes:` are skipped.
- Dismissed after verification: "relative anchor paths under the project root bypass the cross-repo check" — the project-relative form for a git repo nested under a non-repo store root is the tested contract that lets `reconcile` detect renames inside that repo (`test/reconcile.test.ts`); the absolute-path branch's cross-repo conversion is the inconsistency to revisit, logged in BACKLOG.md.

### Features

- **Read-path anchor drift.** `search` / `memspec_search` now flag an active anchored record whose code has changed since it was last anchored, without a separate `reconcile` run. CLI text prints a `[DRIFTED]` marker next to the stale marker; the JSON/MCP result carries `drifted`, `anchor_unchecked` (repo not checked out, so drift could not be checked), and a per-file `drift` list. `memspec_get` carries the same fields. The check never mutates files, never throws, memoizes blob SHAs per process (keyed by path+mtime+size) so a long-lived MCP server does not re-hash stable files per query, and only runs for active anchored records. Boot context is unchanged.
- **Search coverage disclosure.** Every search result now carries `coverage: none | weak | ok` plus a one-line `coverage_note`, so an agent can tell "the store has nothing on this" from a low-ranked hit instead of reading meaning into rank. `none` = zero active matches; `weak` = fewer than half the distinct query terms occur in the best-covered hit in the result set — not just the top-ranked one, since a layered store's rank-1 hit can be an OR-fallback row while the exact match sits at #2 — matched whole-token against the index's own tokenizer (`tariffs` ≡ `tariff`, `gate` ≠ `gateway`) with a small stopword list ignored, so a natural-language question doesn't read as covered because it shares "does"/"the"/"use" with a hit (the note names which content terms matched nothing); or the best hit is a title/tag-only match (no query term in its body); or it is barely above the BM25 floor; `ok` = a genuine match. The term-coverage component stops a mostly-absent multi-term query ("zebra quantum flamingo tariff") from reading as `ok` just because one term hit a record. A companion `coverage_witness` names the strongest witness among the hits (anchor > operator > evidence > assertion), so "the store claims this but only as an unverified assertion" is mechanical. A derived hit (any `derived_from` edge) counts one tier weaker than its own `verified_with` for this computation — an inference is only as strong as its premises, not as strong as how the inference step itself was checked — so an evidence-witnessed derived record reads as `assertion`; `assertion` is already the floor and stays `assertion`. CLI prints a final `Coverage:` line; MCP exposes the fields at the top of the search payload, and the `memspec_search` tool description tells agents to trust `coverage` over rank.
- **`--anchor-root` / `anchor_root`.** New option on `remember` and `anchor` (CLI `--anchor-root <dir>`, MCP `anchor_root`) naming the checkout a repo-relative anchor path belongs to when the file lives outside the store's project root. Recorded as a cross-repo anchor.
- **Usage receipts with outcomes.** `usage.jsonl` rows now carry `query` (truncated 200 chars), `session` (`MEMSPEC_SESSION_ID` > `CLAUDE_SESSION_ID` > the MCP server's own `mcp:<pid>` label; absent entirely on a bare CLI invocation — see the session-id Fix below for why there is no per-process fallback), `rank`, and `surface` (`cli` | `mcp` | `context`) alongside the existing `id`/`retrieved_at` — old rows without the new fields still read fine. A new append-only `outcomes.jsonl`, written by the new `memspec outcome <id> <useful|dead_end|corrected> [--note] [--source]` command and `memspec_outcome` MCP tool, records what happened after a memory was retrieved without ever mutating the record itself; `supersede` now writes a `corrected` outcome automatically for every id it collapses (replace, retract, and merge branches all covered). A new `src/lib/usage-stats.ts` derives, per id, `last_referenced`, distinct `sessions`, and outcome counts from the two logs — never written back to frontmatter — and surfaces them on search hits and `memspec_get` (`last_referenced`/`sessions`, present only when known). `status` gains two sections built on top: `## Cold` (active records created > 30 days ago that were never retrieved, or not retrieved in 60+ days) and `## Promotion candidates` (active observations, and assertion-witnessed facts created < 14 days ago, retrieved in 2+ distinct sessions with zero `dead_end` outcomes — "candidates only, nothing auto-promoted"). Both surface as `cold` / `promotion_candidates` arrays in the MCP `memspec_status` JSON.
- **Scope enforcement (`scopes_require`).** New top-level `config.yaml` key, default `false`. When `true`, a `remember`/`observe` write that resolves no scope at all (no `--scope`, cwd matches no `scopes:` pattern) is refused — same shape as the existing ambiguous-store refusal, naming the known scopes (declared config keys ∪ scopes already stamped on records) and the flag to pass. `--scope universal` remains the explicit, always-available opt-out.
- **`bin/repair-scope-backfill.mjs`.** One-shot backfill for records with no `scope:` field: derives a scope from a caller-supplied ordered tag→scope map (`--map plg:plg,piletilevi:plg,...`, case-insensitive, comma-separated). A record whose tags resolve to two different scopes is left untouched and reported ambiguous; a record matching nothing is left untouched and counted. Dry-run by default; `--apply` writes atomically with an undo journal (same pattern as `bin/repair-inferred-conflicts.mjs`); operator-sourced records are skipped unless `--include-operator`.
- **`verify --check-by` / `memspec_verify check_by`.** A clean verification can now set `check_by` explicitly (ISO 8601 or `"never"`) instead of always resetting it to the type default — how an operator pins an identity/event-shaped fact so it never comes up for review again. Ignored on a `needs_review` result, which never mutates the record regardless.
- **`sweep --answers <file>`.** Non-interactive alternative to the stdin prompt loop: reads one `<id>\t<y|n>` line per stale candidate (ids missing from the file default to `n`), prints the same per-item lines and retire count as the interactive path. `--dry-run` is unchanged and still lists candidates without prompting or reading answers.
- **Store resolution walks up to `$HOME`.** `--cwd` (or the process cwd) now resolves the nearest store by walking parents up to and including `$HOME` for a `.memspec/` directory (or a `.memspec.yaml` pointer), so a session in a subdirectory — or a repo with no store of its own — reaches the real store instead of a phantom empty `<cwd>/.memspec`. The walk is fenced: inside `$HOME` it stops at `$HOME` (nothing above is consulted); outside `$HOME` it walks to the filesystem root exactly as pre-0.11 `findRoot()` did (a repo at `/srv/app` resolves from any subdirectory); `MEMSPEC_NO_WALK=1` disables it (cwd only); a nearer `.memspec/` directory beats a farther `.memspec.yaml` pointer; an explicit `.memspec` path is used verbatim. The `.memspec.yaml` pointer walk shares the SAME fence and the same opt-out, and additionally ignores an untrusted pointer (world-writable directory such as `/tmp`, or owned by another uid) with a stderr note — a pointer redirects writes, so it has to be yours. Scope still derives from the ORIGINAL cwd (not the resolved store), so a subdirectory session is scoped correctly. `init` refuses (exit 1, naming the parent store) when it would nest a store inside an existing one — `~/.memspec` included — unless `--force` (see the `init --force` Fix below for why that flag needed its own fix to actually exist).
- **Read-only store layers (`writable: false`) and the `layer` field.** A `stores:` layer marked `writable: false` is included in every read but refuses every write: a default (no `--store`) write never selects it, an explicit `--store <name>` write to it refuses, and an in-place edit of a record it owns (`supersede`, `relate`/`unrelate`, `verify`, `anchor`) refuses, naming the layer. `remember`/`observe` always land in the writable primary. Search hits and `memspec_get` results served from a non-primary layer now carry `layer: <name>` (JSON) and a `(layer: <name>)` suffix (CLI/MCP text); primary-layer hits carry none, so single-store retrieval stays byte-identical. This is how a personal store layers a shared team store it should read but never mutate.
- **Actuation boundary (`requires_human`).** New optional frontmatter on `type: procedure` records — a list of step labels a human must perform. `remember procedure --requires-human "<text>"` (repeatable; `requires_human: [...]` over MCP) records them; the field is a schema error on facts/decisions and on non-procedures. `memspec_get` and the remember result echo it, and CLI text prints `Requires human: …`. An unattended runner can read it and refuse those steps rather than executing them. Backward compatible: existing procedures without the field are unchanged. `search`/`memspec_search` hits now echo it too (JSON `requires_human`, present only when non-empty; CLI/MCP text prints a `requires human: …` line under the hit).
- **Derived vs observed (`derived_from`).** New positive edge kind: `X derived_from Y` records that X was *inferred* from Y, not observed directly. Wired everywhere the other positive edges live — schema/types, `relate`/`unrelate --type derived_from`, `remember --derived-from <ids>` (MCP `derived_from`), graph-walk expansion and lineage (`derived_from_chain`), export, and the 0.10 rule that a target cannot be both a conflict and a positive edge. A record with any `derived_from` edge carries `derived: true` in `memspec_get`/remember JSON; a new `isDerived()` helper in `graph-walk.ts` exposes the same predicate for `search` to consume on its coverage line. `search`/`memspec_search` hits now carry the same `derived: true` (via `isDerived()`) plus a `(derived)` marker in the CLI/MCP text header, and `coverage_witness` counts a derived hit one tier weaker (see the Search coverage disclosure entry above).
- **Committed evidence attachments (`--evidence`).** `remember --evidence <path-or-url>` (repeatable; MCP `evidence: string[]`) and `verify --evidence-file <path-or-url>` attach proof to a claim. A local file is copied, content-addressed, into `<store>/evidence/<sha256[:12]>/<basename>` (refused over 5 MB, or from the machine-local `local/` subtree; same sha reuses the dir; the copy is contained to `evidence/`); an `http(s)` URL is recorded as `{url, captured_at}` and NEVER fetched (no network in the write path). Frontmatter `evidence: [{sha256, name, path, source, captured_at} | {url, captured_at}]`. A file-backed entry with no anchors upgrades the witness to `verified_with: evidence` (the free-text `verify --evidence` path still works too). `status` counts evidence-backed records. The `evidence/` directory is committed on purpose (public/derived artifacts only — secrets belong in the untracked `local/`, which `--evidence` refuses to copy from).
- **Question groups (`kind: question`).** A new record kind under `memory/questions/` names a question and lists competing answer records: `answers: [ids]`, `closed: true|false`, `state: open|resolved`, `resolved_by: id?`. `memspec question "<title>" --answers <ids> [--closed]` creates one; `memspec question <id> --add <ids>` / `--close` / `--open` / `--resolve` edits it; `memspec_question` mirrors both. An answer must exist and be active or superseded. For a CLOSED question, once exactly one answer is still active `status`'s new `## Questions` section reports `resolved by elimination — survivor <id>` — reporting only, never auto-resolving; `--resolve` sets `state: resolved` + `resolved_by`. An OPEN question is reported `open — N candidate(s)` and never resolves by elimination. `remember --answers-question <qid>` files a fresh record into a group in one call. A question group is the preferred form for ≥2 competing answers to one named question; pairwise `conflicts_with` still works. Export includes question nodes and `answers` edges. `search --type question` / MCP `type: "question"` is now the dedicated retrieval path for question groups: a question never carries `state: active`, so the normal FTS pipeline can never surface one regardless of type filtering — this path lists them directly instead (open groups first, then resolved, each newest-first; a query filters by a case-insensitive title substring match), and hits carry `closed`, `answers`, `state`, and `resolved_by`. A default (untyped) search continues to exclude question groups entirely — the chosen rule, simpler than ranking them into mixed results. `memspec_status`'s existing `## Questions` section was already present in the MCP JSON as a `questions` array (`buildStatusReport`'s `StatusReport.questions`); confirmed, no change needed there.

### Fixes

- **Coverage term test tokenises like the index, ignores function words, and judges the best-covered hit.** Three adversarial findings against the 0.11 coverage classifier (see the Search coverage disclosure feature above for the resulting behavior), all reproduced on the live store: (a) punctuation and quotes in the query flipped a full AND match to `weak` (`remootio, hubitat, gate` reported `1 of 3 matched (unmatched: remootio,, hubitat,)`), because the JS term test compared raw words by substring while FTS5 had stripped the separators; (b) a natural-language question about an absent topic read `ok` because `does`, `the` and `use` counted as matched terms; (c) in a layered store the verdict was taken from `seeds[0]`, so a one-token OR-fallback hit from the higher-priority layer (RRF rank-1 tie broken by layer priority) masked an exact match sitting at #2. Fixed via a throwaway FTS5 table using the index's own `porter unicode61` tokenizer (`tokenizeLikeIndex()` in `fts.ts`). Weak/ok notes name the active scope when one is set (`at least one genuine match in scope kvart`). When a narrowing type filter (`--type`, or a profile `types:` that leaves a claim type out) is active and coverage is none/weak, the note names the filter and one extra unfiltered FTS pass reports how many records of other types match (`no active fact record matches ...; 1 record(s) of other types match — retry without the type filter`), so an agent does not read a filter miss as "nothing here".
- **`coverage_witness` no longer reports `anchor` for a drifted or unchecked anchor.** An anchored hit whose anchor is `drifted` (code changed) or `anchor_unchecked` (repo not checked out here) counts as `evidence` for the summary; when that downgrade decides the value the payload carries `coverage_witness_note: "drifted" | "anchor unchecked"` and the text line reads `best witness: evidence (drifted)`, so the summary can no longer outrank the row's own `[DRIFTED]` warning. The derived tier-down applies on top as before. `coverage_witness_note` rides in `search --json` and the `memspec_search` MCP tool's `structuredContent` alike (it had been missing from the latter).
- **`search --json` emits the same payload object as `memspec_search`** — `{query, profile, count, full, results, coverage, coverage_note, coverage_witness}` — instead of a bare results array (and the literal `[]` on zero hits), which carried none of the coverage fields the README promised and made "no results" indistinguishable from "weak". **Breaking for `--json` consumers:** read `.results` for the rows. No script in this repo, in `hooks/`, or in the operator's `bin/` parsed the old array shape; the in-repo tests were adapted.
- **`sweep --answers` splits on any whitespace and reports what it could not use.** The parser accepted only a literal TAB between id and answer, so a space-separated `<id> y` file parsed every id as `<id> y`, matched nothing, and retired zero items with no hint. Lines that are not exactly `<id> <y|yes|n|no>` and ids that match no stale candidate are now printed as `WARNING:` lines ahead of the per-item listing.
- **`bin/repair-scope-backfill.mjs` normalises legacy states and accounts for every scanned record.** Pre-0.3 `state: captured` / `corrected` records (which the runtime maps to `active` / `superseded` on read via `LEGACY_STATE_MAP`) were skipped as having no usable state and silently stayed unscoped; the script now applies the same map before the eligibility check (stamping `scope` only — the state itself is left for the runtime to normalise) and the report prints the count of records in a non-claim state (questions, retired, open/resolved) that were not eligible.
- **Docs: SPEC §8.2 lists fourteen MCP tools** (adds the `memspec_question` bullet and `derived_from` on `memspec_relate`); README Features says fourteen tools (was "Eleven") and the `init` row no longer mentions configuring search.
- **Store `.gitignore` covers every telemetry file.** The `init` template now lists `outcomes.jsonl` (auto-written by `supersede` since 0.11), `local/` and `logs/` alongside `usage.jsonl`. **Existing stores get the missing lines appended automatically on their first 0.11 write** (`init`, any `remember`/`observe`/`supersede` record write, outcome append) via the new idempotent `ensureStoreGitignore(storeRoot)` in `store.ts` — only absent entries are added, under a short comment, and an existing `local` without the slash counts as present. Before this, the first `supersede` on a git-synced store created an untracked `outcomes.jsonl` (session ids, free-text notes) that the next `git add -A` would have committed.
- **Relative `stores:` paths resolve against the declaring store.** `CompositeStore.forCwd` resolved a relative layer `path:` (the documented default `path: .memspec`) against the caller's cwd, so a session in `repo/service/api` whose walked-up `repo/.memspec/config.yaml` declared layers read from a phantom `repo/service/api/.memspec` and saw nothing. Layer paths now resolve against the directory holding the config (or pointer) that declared them.
- **Writes honour the resolved store's `stores:` block.** New `CompositeStore.resolveWritable(cwd, storeName?)` / `writableFor(cwd, storeName?)` pick the write target through the same layer set the read path uses (pointer → `stores:` block → the store itself): exactly one writable layer, or the one named by `--store`; zero writable layers, an unknown name, a `writable: false` name, or several writable layers without a name refuse with the layer list. Before, a write from a repo whose store declared `stores:` landed in that store even when it was not a layer of the read view, so the record was unsearchable from where it was written.
- **`memspec question` / `memspec_question` resolve the store like `remember` and never `init()` implicitly.** They used `new MemspecStore(cwd).init()`, which in a pointer-file repo created a phantom `<repo>/.memspec/` (even when the call then failed); because a nearer `.memspec/` beats the pointer, every later read and write silently landed in the phantom instead of the declared layers. Editing a question that lives in a `writable: false` layer now refuses, naming the layer.
- **Unavailable layers are reported.** A configured layer whose store directory is absent on this machine is still skipped for reads, but `CompositeStore` now exposes `layersUnavailable: string[]` (+ `unavailableLayers()` with paths) and emits one `LoadWarning` per missing layer in `warnings`, so search/status can say "team layer not available at <path>" instead of reporting an empty store.
- **`init --force` exists on the CLI.** The refusal message told you to re-run with `--force`; the option had never been registered, so that command failed with `unknown option`. On any machine with `~/.memspec`, every `memspec init` under `$HOME` hit this.
- **Anchors written over MCP no longer silently fail** (root cause of only 94/1339 records being anchored in the personal store). The write side resolved every anchor path against the store's project root, so a repo-relative path sent by an agent working in another repo — the normal case for a home-rooted personal store, where the project root is `$HOME` — was "not found", warned, and the record degraded to witness `assertion`. The write side now mirrors the read side: absolute paths are recorded against their own git repo (repo-less when inside the store's project root); repo-relative paths are resolved under an optional `anchor_root`, then as a sibling repo (`repo:path` / `repo/path`), then under each `anchors.repo_search_paths` entry; the recorded `{repo, file}` round-trips through `verify` / `checkAnchors`. Paths that resolve nowhere produce an actionable warning ("pass an absolute path or anchor_root") instead of a bare "not found", and the `memspec_remember` / `memspec_anchor` tool descriptions now tell agents to pass absolute paths. Containment from the 0.10 hardening is preserved: a `..`, absolute, or symlink escape out of the resolved repo is treated as not found.
- **Anchors on a home-rooted store record the `{repo, file}` form, and it resolves without configuration.** Two adversarial findings against the write-side resolver above. (1) An absolute path inside the project root was always recorded repo-less and project-relative — on the personal store (project root `$HOME`) that produced `git/kvart/src/x.ts`, which read as `drifted` on any machine whose repos live elsewhere. A file inside a git repo other than the project root's own is now always recorded as `{repo: <basename>, file: <repo-relative>}`, even when it also lies under the project root; same-repo and no-repo files keep the repo-less form. (2) The `{repo, file}` form written by `anchor_root` (and now by absolute paths) could never be resolved on a store with no `anchors.repo_search_paths` — verify said `repo_unavailable`, search said `anchor_unchecked`, drift was never detected. `resolveRepoRoot` now falls back to `~/git` when the config names no search paths (`~` alone is also accepted as an entry), and every `{repo, file}` write is checked against the writing store's own read-side lookup: when it would not resolve, the anchor is still recorded but the result warns with the exact directory to add to `repo_search_paths`.
- **Anchor `repo` must be a bare directory name.** A record carrying `repo: /etc` (or `../../etc`, `a/b`, `.`) resolved to that directory and handed whoever could plant a record — a shared or read-only layer included — a content-hash oracle over files outside every repo, with a genuine `anchor` witness. `resolveRepoRoot` now rejects anything that is not a bare name; `checkAnchors`/`verify` report `repo_unavailable` (with a stderr note) and `search` reports `anchor_unchecked`, never `unchanged`.
- **Evidence `local/` guard compares real paths and refuses symlinked sources.** The guard compared the lexical path, so `ln -s <store>/local/secrets.env ./notes.txt` (or a symlinked parent directory) copied a `local/` secret into the committed `evidence/` dir. Both sides are now canonicalised, and a source that is itself a symlink is refused outright. The frontmatter `source` field no longer stores the absolute path of the copied file (it leaked usernames and directory layout into a committed, possibly shared file): it is `~/…` for a file under the home directory, `<repo>:<path>` inside a git checkout, otherwise omitted (`name` already carries the basename).
- **Evidence is copied only after every other input has been accepted.** `remember` copied evidence files before validating `valid_from`/`valid_to`, `--conflicts-with` targets, later `--evidence` paths and the `--answers-question` id, so any of those failing left an orphan under the committed `evidence/`. Validation of every input now runs first (`validateEvidenceSource` decides all evidence refusals without copying); the copy is the last step before the write. `verify --evidence-file` likewise validates up front but copies only on the clean path — a `needs_review` result really does leave the store untouched.
- **`remember` validates its edge and question inputs before writing.** `--answers-question <bad id>` wrote the record and then failed in `addAnswers`, leaving an orphan claim the retry then refused as a near-duplicate; the question is now loaded (and checked to be a question) before `writeItem`. `--derived-from` / `--refines` / `--supports` / `--depends-on` targets are validated to exist, mirroring `--conflicts-with` and `relate`; targets are looked up in the write target and the read views of both the store-selection cwd and the working cwd. Adding a new active answer to a *resolved* question (via `remember --answers-question` or `question --add`) now reopens it — `state: open`, `resolved_by` cleared — and both commands say so (`remember`: "REOPENED"; `question --add`: "reopened"); re-adding a listed or superseded answer changes nothing.
- **`relate` / `unrelate` refuse a question record as `--from`.** Question groups carry `answers:`, not claim edges; the other in-place mutators already refused non-active records. Pointed at `memspec question <id> --add`.
- **`supersede --body` carries `requires_human` and `evidence` to the replacement.** The fixed field list minted the replacement without them, silently removing the actuation boundary from a revised procedure. The union of `requires_human` steps and of `evidence` entries (deduped by sha256/url) across the target and every `merge_from` record now rides along, and the message names what was carried.
- **`--store <layer>` is honoured for `config.yaml`-declared layers.** Only the `.memspec.yaml` pointer branch consulted the flag, so `--store team` on a layered personal store wrote to the personal store and exited 0. `remember` now goes through `resolveWritable` (see the "Writes honour the resolved store's `stores:` block" Fix above) instead of routing around it. On top of that shared mechanism, `remember` adds one more default: with no `--store` and several writable layers declared in the walked-up store's own `config.yaml` (the documented default: `project` + `global`), the write defaults to the layer that IS the declaring store — where every pre-0.11 write landed, and a layer of the read view — while a `.memspec.yaml` pointer repo keeps the strict "name it or be refused" rule. `--store global` with no layer named `global` keeps meaning `~/.memspec`; an unknown `--store` on a store with no layers at all is now an error instead of a silent write into it. `question` (which has no `--store` flag of its own) adopts the same declaring-store default, so it can create a question under the documented default template without throwing "ambiguous write target".
- **Session ids are real sessions, not invocations.** `usage.jsonl` / `outcomes.jsonl` rows fell back to a fresh per-process uuid when neither `MEMSPEC_SESSION_ID` nor `CLAUDE_SESSION_ID` was set, so two `memspec search` calls in one agent turn counted as two sessions and a young assertion fact reached `## Promotion candidates` on its own. The fallback is gone: the MCP server labels its rows `mcp:<pid>` (one process per client connection, so the process is the session); a bare CLI call records no `session` at all (the parent pid is the harness's per-call shell, no better than a uuid). Rows without a session never count towards `sessions`; the `status` Promotion section states the rule.
- **Usage receipts reach the owning layer, and boot context logs what it surfaces.** `memspec context` (the session-start hook) now records every surfaced record with `surface: "context"`, so a pinned identity record that boots every session is no longer reported `## Cold`. New `recordSurfacedHitsByLayer` writes each row into the store layer that owns the record (its read-time `layer` stamp), so a read-only team layer read only through a personal store's layered view accumulates its own receipts. Both `context` and `search` (its normal and `--type question` paths) now use it, so a team-layer search hit is logged into the team store's own `usage.jsonl`, not the primary's.
- **MCP tool descriptions name `derived_from` and the v0.11 status sections.** `memspec_relate` / `memspec_unrelate` (description and `type` parameter), `memspec_search`'s `expand_edges` list and `edge_types` default ("all seven") now include `derived_from`; `memspec_status` describes `cold`, `promotion_candidates`, `questions` and `evidence_backed`; `memspec_remember` explains the `{repo, file}` recording rule and the `~/git` default. The plain CLI `--help` text lagged the same fix: `relate`/`unrelate`'s description and `--type` option still listed only `refines | supports | depends_on | conflicts_with`, missing the edge kind that had shipped since the "Derived vs observed" feature above — now both list `derived_from` too.

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
