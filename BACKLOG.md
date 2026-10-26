# Memspec Backlog

Defects and improvements observed in real agent use. Newest first.

## Open

### 5. Anchors are file-grain; most drift alarms are false on an active repo (HIGH)

**Measured 2026-10-25/26** (`scripts/bench-wrongness`, Hono 367-commit replay):
whole-file anchors flag 87% of still-true facts by the last checkpoint
(`package.json` changes every release); a symbol-grain counterfactual drops
that to 23% with stale-served still 0% on code facts. On a real personal store
16 of 30 drifted claims were still true. Build symbol-level anchors (anchor to
the enclosing top-level declaration's text hash, keep the blob SHA as
fallback) and measure with the bench's symbol-grain row as the target.
Cross-file facts (a symbol used from another file) are the stale-served hole:
25% of changed `usage` facts slip through with subject-file anchors.

### 6. `memspec check` pairs by topic, not by contradiction (MEDIUM)

Same bench, Part B: 86-95% of anchored contradictions are paired with their
target, but compatible claims are flagged 72-89% of the time. It is a
"same topic changed, review it" gate. Telling contradictions apart needs a
value comparison (same subject identifier, different value token) before
pairing; the bench's controls are the acceptance test.

### 7. Recency term is a same-day cliff (MEDIUM)

Ranking uses `1/(1+ageDays)` at default weight 0.3. On a store that gains
dozens of records a day, same-day records crowd the top ranks: the same build
scores paraphrase R@1 0.06 or 0.27 depending only on the clock (real store,
2026-10-25 vs -26). Consider a slower decay (e.g. half-life in weeks) and
measure with the clock pinned.

### 8. Rejected-value check: known lexical residuals (LOW-MEDIUM)

Best-effort guardrail by design (SPEC.md §4.2.2). Open cases from the
2026-10-26 probe rounds, all over MCP with no override log:
- A correction whose own text mentions the old value ("15 minutes, was 30")
  leaves `removedValues` empty; a `supersede` of it restating the old value
  plus "(was 15)" ties on tokens and passes the margin. Proposed fix: judge
  removed values on title identifiers (R.titleIds ∩ incoming.titleIds −
  S.titleIds) and refuse a supersede-of-S whose token set ties S.
- A diluted holder naming both values (similarity ~0.10 to both) absorbs S via
  `merge_from` and the old value becomes the chain's active end.
- "X=2 (read by `useCallback`)" written next to an active "X=2" survives a
  later correction of X (pre-positioning).

### 9. Dependency CVEs in the lockfile (MEDIUM)

Trivy, 2026-10-25: `@modelcontextprotocol/sdk` 1.30.0 (3 high, 2 medium),
`zod` 4.4.3 (high), `body-parser` 2.3.0 (high), plus medium/low in
`ip-address`, `fast-uri`, `hono`. Bump through the supply-chain rules (age
gate, lockfile review) in its own PR.

### 3. `anchor` input silently dropped on MCP `memspec_remember` (MEDIUM)

**Observed 2026-08-08**: two `memspec_remember` calls passed `anchor` as a
JSON-encoded string of paths (`'["src/a.py", "src/b.py"]'`). Both results
came back `anchors: []`, `anchor_warnings: []`, `verified_with: "assertion"`
— the anchor was ignored with no error and no warning, and the records
silently lost their strongest witness tier. Whatever the expected input
shape is (real array vs string), a non-conforming `anchor` value must
either be coerced or produce a loud `anchor_warnings` entry — a silent
downgrade from `anchor` to `assertion` witness defeats the witness chain.

### 4. Release-gate panel leftovers (2026-09-16, MEDIUM, deferred to 0.11.x)

Cross-vendor panel on the 0.10→0.11 diff; verified against code, not fixed
in 0.11.0:

- **Layer-owned usage receipts are read only from the primary store.**
  `recordSurfacedHitsByLayer` appends the receipt to the owning layer, but
  `computeUsageStats`/`memspec_get`/context's usage boost read `store.root`
  only, so a team-layer hit never gains `last_referenced`/`sessions`.
- **Outcomes for layered records land in the primary, receipts in the owner.**
  `status` on the owning store sees the sessions but not the `dead_end`, and
  may list the record as a promotion candidate. Decide one home for both.
- **Session-start hook ignores `.memspec.yaml` pointers.** `findMemspecRoot`
  walks for `.memspec/` only; a pointer-only repo gets `~/.memspec` context
  without the team layer. Mirror `registry.findPointer` in the hook.
- **`remember --answers-question` resolves the question in the write layer
  only.** A question in another layer reads "Question not found" although
  `memspec question <id> --add` resolves its own layer.
- **Schema: `resolved_by` not validated against `state`.** A resolved question
  without `resolved_by` (or an open one with it) passes; require it for
  resolved, forbid for open, and require membership in `answers`.
- **Anchor write form differs by input spelling.** For a file in a git repo
  nested under a non-repo project root, an ABSOLUTE input becomes
  `{repo, file}` while the same file given RELATIVE stays project-relative
  (the form reconcile's nested-repo rename detection relies on). Pick one;
  the relative form is the tested one.

## Done

### 1. False `conflicts_with` auto-attach from mid-band similarity (HIGH)

**Fixed in 0.10.0 (2026-08-19):** conflict inference is suggestion-only. A
write never attaches `conflicts_with` on its own; lexically similar records
come back as `suggested_conflicts` for the caller to confirm.

**Observed 2026-08-08** (Therin, kvart sessions) — two false positives in one day:

- A "feature shipped" fact got `conflicts_with` auto-attached against the
  "LLM provider swap shipped" fact it actually *depends on* (the swap
  unblocked the feature). Correct edge was `depends_on`.
- A 3-tier memory-architecture decision got `conflicts_with` against a
  completely unrelated same-day voting-rights decision.

Root cause: the mid-band auto-attach at write time
(`src/commands/remember.ts` ~L226, predicate in `src/lib/inference.ts`)
treats *similarity* as *contradiction*. Same project + same date + shared
vocabulary lands in the mid band and gets a conflict edge. But similarity
between two true facts is the normal case in an active project, not a
conflict signal.

Why it matters: a false `conflicts_with` is worse than no edge — it tells a
future agent one of two true records is wrong, inviting a bogus supersede.

Fix directions (pick one):
- Require an actual contradiction signal (negation, mutually exclusive
  values, temporal supersession shape) before emitting `conflicts_with`;
  plain mid-band similarity emits nothing or a neutral `related` edge.
- Demote write-time auto-attach to a *suggestion* surfaced in the weekly
  dream pass / `memspec_reconcile` for confirmation, instead of committing
  the edge silently.
- Let the LLM caller confirm: return the candidate as
  `suggested_conflict` in the remember result rather than `auto_attached`.

### 2. No way to retract an edge (MEDIUM)

**Fixed in 0.10.0 (2026-08-19):** `unrelate` (CLI + MCP) removes an edge and
logs the removal into `ext.edge_removals`.


`memspec_relate` can only add edges and dedupes silently; there is no
`unrelate`/edge-removal surface (MCP or CLI). Consequence of #1: the false
`conflicts_with` edges from 2026-08-08 are still in the store — the correct
`depends_on` edge could be added alongside, but the wrong edge cannot be
removed without hand-editing the record file. Add an edge-removal operation
(and have supersede clean dangling edges).
