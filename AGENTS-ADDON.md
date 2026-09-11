# Memspec Agent Contract

Add this block to the repo's `AGENTS.md`, `CLAUDE.md`, or equivalent instruction file if `memspec init` cannot patch it automatically.

```markdown
## Memory (Memspec)

This project uses Memspec. `.memspec/` is the canonical store of project knowledge:
claims (facts, decisions, procedures) paired with the evidence that last attested them.
You operate it; the human doesn't curate it.

### Session start
Active memories are auto-injected via the session hook. Every line has an id — you can
`memspec_verify`, `memspec_supersede`, or `memspec_anchor` it directly. If a "Needs
attention" section appears, resolve those items when your work touches their subject.
Fallback if no hook ran: `memspec_search` the task topic.

### Retrieve before assuming
Before acting on an assumption about how this project works — deploys, architecture,
conventions — `memspec_search` it. A recorded claim outweighs what the code appears
to suggest: the claim records *why*, code only shows *what*. Heed the witness shown
with each result: an anchored claim verified yesterday and a never-rechecked assertion
deserve different weight.

### When to write
Write at the event, not at session end:
- Fixed a bug → `memspec_supersede` the claim that was wrong (or `memspec_remember` what you learned)
- Changed architecture/config → supersede stale claims, remember new ones
- Established a workflow → remember a `procedure`
- Discovered something non-obvious → remember a `fact`
- Chose between alternatives → remember a `decision` with the rationale
- Noticed something point-in-time, not yet durable → `memspec_observe` it

If a claim describes code, pass `anchors` in the same `memspec_remember` call.
If `remember` refuses your write as a near-duplicate, that's the system working:
verify the match if it's right, supersede it if it's wrong. Use `force: true` only
when the claims are genuinely distinct.

### Flags are work orders
- A result marked **stale** or **drifted**: re-check it against the world before relying
  on it, then `memspec_verify` (with evidence) or `memspec_supersede`. Unrecorded
  re-verification is invisible.
- A result marked **conflicting**: do not silently pick a side. Resolve it — supersede
  the wrong one (or merge with `merge_from`), verify the right one — then proceed.
- After committing code changes, run `memspec_reconcile` and resolve its candidates.
- A retrieved memory that turned out wrong, irrelevant, or misleading for the task at
  hand: record `memspec_outcome <id> dead_end` (with a `note` on what went wrong). This
  is separate from fixing the record itself — if the claim is actually wrong, also
  `memspec_supersede` it (which records its own `corrected` outcome automatically). If a
  memory genuinely helped, `memspec_outcome <id> useful` is optional but welcome — it
  feeds `status`'s promotion-candidate surface for young, unverified knowledge.

### Structuring knowledge (v0.11)
- **`--derived-from <ids>`**: use when a claim is a *conclusion you inferred* from other
  records, not something you observed directly. It marks the record `derived` so a reader
  knows to trace the basis rather than trust it as a primary source.
- **`--requires-human "<step>"`** (procedures only): flag any step you, running unattended,
  must not perform — a console approval, a physical action, an irreversible production
  change. A runner refuses these instead of executing them.
- **`--evidence <path|url>`**: attach committed proof — a benchmark file, a log excerpt, a
  screenshot (copied into `evidence/`), or a URL to an artifact (recorded, not fetched). A
  file-backed attachment upgrades an anchorless claim's witness from `assertion` to
  `evidence`. Never point `--evidence` at anything secret: `evidence/` is committed. Symlinks
  are refused (pass the real file) and anything under the store's `local/` is refused even
  through a symlinked directory. Attach the same way at verify time with
  `verify --evidence-file` — it copies only when the verification is clean.
- **Question groups** (`memspec_question` / `memspec question`): when two or more records
  answer one named question, group them instead of wiring pairwise `conflicts_with`. Mark it
  `--closed` when the listed answers are the only candidates; then as you supersede the
  losers, `status` reports the survivor and you `--resolve` it. `remember --answers-question
  <qid>` files a new record straight into the group.

### Boundaries
- Don't ask permission for memory upkeep — write, supersede, verify, anchor freely.
  The bar: would a future agent starting cold benefit?
- Claims marked `[op]` are operator-sourced. Superseding one requires
  `override_operator: true` — use it only with explicit cause, and say so in the reason.
- Knowledge only. No session transcripts, no secrets, nothing point-in-time as a claim
  (that's what `observe` is for).
```
