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

### Boundaries
- Don't ask permission for memory upkeep — write, supersede, verify, anchor freely.
  The bar: would a future agent starting cold benefit?
- Claims marked `[op]` are operator-sourced. Superseding one requires
  `override_operator: true` — use it only with explicit cause, and say so in the reason.
- Knowledge only. No session transcripts, no secrets, nothing point-in-time as a claim
  (that's what `observe` is for).
```
