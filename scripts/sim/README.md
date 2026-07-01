# Simulated-memory dev fixture

A deterministic, committed corpus of a **fictional company's accumulated project
memory** ("Helix", ~190 records over an 18-month simulated timeline) plus a
**labeled query set**, for internal retrieval testing during development.

This is a *development tool for finding and fixing retrieval weaknesses* — not a
marketing benchmark. It is built to **expose headroom**: several queries are
expected to fail on the current ranker, and those failures are the point.

## Files

| Path | What |
|---|---|
| `gen-fixture.mjs` | Deterministic generator — authors the corpus + `queries.json`. |
| `fixture/.memspec/` | The committed corpus (facts / decisions / procedures / archived records, with typed edges, temporal validity, supersede chains, staleness, near-duplicates, conflicts). |
| `queries.json` | The labeled query set: user-language queries + expected target ids + near-miss distractors + per-query rationale. |
| `eval.mjs` | Runs the query set against the **current build** and reports per-pattern scores and the failures. |

## Run

```bash
npm run sim:gen      # generate the fixture (required once — it is gitignored)
npm run sim:eval     # build + evaluate current code against the fixture
```

The fixture (`scripts/sim/fixture/`) is **gitignored, not committed** — it is
regenerable scaffolding, so run `npm run sim:gen` once after cloning (and again
whenever you change the generator). The generator, harness, and the generated
`SIM-BENCHMARK.md` are committed; the ~190 fixture files are not.

`sim:gen` output is deterministic — regenerating without changing the generator
produces a **byte-identical** tree, so the committed fixture diffs cleanly.

### Version sweep (one row per version)

`bench.mjs` runs *every released version's* search against the same committed
fixture and writes `SIM-BENCHMARK.md` — one row per version — so you can see
which version unlocks which capability and where headroom remains.

```bash
node scripts/sim/bench.mjs            # sweep v0.4→v0.7, write SIM-BENCHMARK.md
node scripts/sim/bench.mjs --render   # re-render from cached results
```

Run from a **clean tree**: the sweep checks out each version tag (uncommitted
changes to tracked files would block the checkout). It spawns one fresh `node`
process per version — a same-process dynamic import can't swap a version's
transitive dependencies (they stay cached), which would silently run one version
four times — and self-stages the worker + fixture + queries to `/tmp` first so an
old-tag checkout can't delete them mid-sweep. Your branch is restored at the end.

| File | What |
|---|---|
| `bench.mjs` | Version-sweep orchestrator + renderer. |
| `_worker.mjs` | Single-version worker (spawned once per version). |
| `SIM-BENCHMARK.md` | Generated version-per-row benchmark (local; not shipped). |

## How it avoids being a rigged "highlight reel"

The generator authors the records, the queries, *and* the labels — so the design
actively defends against circularity (a dataset that only proves the ranker
finds what was built to be findable):

- **Lexical gap.** Queries are phrased the way a user would ask, deliberately
  *not* echoing the answer record's wording. (e.g. the answer to "which database
  does the billing service keep invoices in" is a record that never says
  "billing"; the billing record never names the database.)
- **Near-miss distractors.** Most probes include a record that lexically matches
  the query but is the *wrong* answer, so keyword overlap is punished, not
  rewarded.
- **Honest failures.** Patterns that current retrieval can't serve are labeled
  and reported as headroom, not hidden.
- **Off-topic background.** ~170 background records give BM25 real competition
  and are never query targets, so they can't create unlabeled correct answers.

New query/answer pairs should pass the **cold spot-check**: would a human reading
the corpus agree the target answers the query *without* knowing it was wired?

## Query patterns

| Pattern | Metric | What it probes |
|---|---|---|
| `direct` | recall@5 | sanity control — wording overlaps the answer |
| `edge-walk` | recall@5 | answer only reachable via a `depends_on` edge (`expand_edges`) |
| `temporal` | top1-correct | `as_of` must select the version valid at a timestamp |
| `archive-chain` | recall@5 | answer is in a superseded predecessor (`include_superseded`) |
| `multi-answer` | multi-recall@10 | answer spans several records; measures completeness |
| `conflict` | multi-recall@10 | two conflicting active decisions must both surface |
| `precision` | top1-correct | a lexical twin must **not** beat the correct answer |
| `paraphrase-hard` | recall@5 | heavy lexical gap, no edge — headroom for a semantic backend |

## Current headroom (as of writing)

Running `sim:eval` on the current FTS5/BM25 build fails ~4/10 queries. The
findings are constructive leads, not "features broken":

1. **Expansion hits rank below every seed.** `expand_edges` / `include_superseded`
   genuinely *recover* records BM25 misses entirely (edge-walk and archive-chain
   targets are absent without expansion, present with it) — but they're appended
   after all direct matches, so they land outside a top-5 cut. Interleaving
   expansion hits by edge confidence is the highest-value improvement.
2. **Near-miss precision.** A lexically-closer wrong record can outrank the
   correct answer (the "runs low on memory" query pulls the OOM record over the
   cache-eviction record). A ranking/semantic signal beyond raw BM25 would help.
3. **Lexical-gap multi-answer.** Paraphrased cluster queries pull the wrong
   cluster when the right records share no rare terms with the query.
4. **Staleness is not a ranking signal** (diagnostic). `stale` is surfaced as a
   flag; stale records rank identically to fresh ones. Candidate improvement:
   deprioritise (don't drop) overdue-for-review claims. Note: this one diagnostic
   line reads the wall clock (a record is stale once its `check_by` is in the
   past), so its count can shift with the real date — the fixture itself is fully
   deterministic; only this diagnostic is time-relative.

## Extending

Add records and queries in `gen-fixture.mjs`, then `npm run sim:gen` and review
the diff. Keep the anti-circularity rules above. To grow scale, add subsystems
or aspects to the background generator. To probe a new capability, add a core
record cluster + a labeled query with a distractor and a rationale.
