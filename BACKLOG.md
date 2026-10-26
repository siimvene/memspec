# Memspec Backlog

Defects and improvements observed in real agent use. Newest first.

## Open

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
