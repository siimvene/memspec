# memspec — simulated-memory benchmark (version per row)

Each row is a released version, pinned to its git tag, running its own `memspec_search`
against the **same committed simulated corpus** (`scripts/sim/fixture/`, ~190 records).
Identical data on disk; only search capability varies. Built from a non-circular
dataset: queries use user-language phrasing with a deliberate lexical gap from the
answer, and every probe carries a near-miss distractor, so keyword overlap is not
rewarded. See `scripts/sim/README.md`.

Two lenses are reported. **Reached** = the intended answer appears anywhere in the
top 15 (does the version's retrieval path *get there at all*). **Served** =
it appears in the working set a caller actually reads (top-5 / rank-1 / cluster
completeness — the pattern's natural metric). The gap between them is ranking headroom.

## Reached — answer surfaced at all (top 15)

| Version | direct | edge-walk | temporal | archive-chain | multi-answer | conflict | precision | paraphrase-hard |
|---|---|---|---|---|---|---|---|---|
| v0.4 (`v0.4.0`) | 1.00 | 0.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| v0.5 (`v0.5.0`) | 1.00 | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| v0.6 (`v0.6.3`) | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| v0.7 (`v0.7.0`) | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |

## Served — answer in the working set (pattern's natural metric)

| Version | direct | edge-walk | temporal | archive-chain | multi-answer | conflict | precision | paraphrase-hard |
|---|---|---|---|---|---|---|---|---|
| v0.4 (`v0.4.0`) | 1.00 | 0.00 | 0.33 | 0.00 | 0.33 | 1.00 | 0.00 | 1.00 |
| v0.5 (`v0.5.0`) | 1.00 | 0.00 | 1.00 | 0.00 | 0.33 | 1.00 | 0.00 | 1.00 |
| v0.6 (`v0.6.3`) | 1.00 | 0.00 | 1.00 | 0.00 | 0.33 | 1.00 | 0.00 | 1.00 |
| v0.7 (`v0.7.0`) | 1.00 | 0.00 | 1.00 | 0.00 | 0.33 | 1.00 | 0.00 | 1.00 |

Metrics per pattern: direct / edge-walk / archive-chain / paraphrase-hard = recall@5; temporal / precision = top1-correct; multi-answer / conflict = multi-recall@10.

## What this shows

**Capabilities that unlock with version** (measured, not asserted — each row runs that version's own code in an isolated process):

- **v0.5 unlocks edge-walk** (Reached 0.00 → 1.00). `expand_edges` surfaces an answer reachable only through a `depends_on` edge — a record BM25 misses entirely (absent without expansion, present with it).
- **v0.6 unlocks archive-chain** (Reached 0.00 → 1.00). `include_superseded` lets search reach a superseded predecessor via the `supersedes` edge. v0.5's expansion excludes superseded targets, so it stays 0 until v0.6.
- **v0.5 unlocks temporal** (Served 0.33 → 1.00). `as_of` ranks the era valid at the query time to #1; without it all eras return and the right one wins only by luck (~1/3).

**Headroom no version addresses yet** (flat across every row — the improvement backlog):

- **Edge-walk & archive-chain "Served" stay 0.00.** Expansion *recovers* the record but appends it below every BM25 seed, so it lands outside a top-5 working set. Ranking/interleaving expansion hits is the highest-value fix.
- **Precision stays 0.00.** A near-miss lexical twin outranks the correct answer ("runs low on memory" pulls the OOM record over cache-eviction). Needs a signal beyond raw BM25.
- **Multi-answer stays 0.33.** Paraphrased cluster queries pull the wrong cluster when the right records share no rare terms with the query.

The gap between the two tables is ranking headroom: v0.5/v0.6 made the answers *reachable*; getting them into the working set is unfinished.
