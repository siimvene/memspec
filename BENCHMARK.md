# memspec — Benchmarks

**Methodology:** Homegrown retrieval-only harness. Per-question fresh tmp store. `memspec_remember` per haystack session (one memory per session, tagged with session id), `memspec_search` for the question, score top-K results against ground-truth session ids via tag match. Recall@5/10 + MRR. No LLM in the loop (retrieval quality only).

**Datasets:**
- LongMemEval-S Knowledge-Update slice (sha256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`)
- LoCoMo category-2 Temporal slice (sha256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`)

**Conditions:**
- v0.4 baseline — `main` (`5e26ec2`)
- v0.5-graph — `feat/v0.5-graph` (`d43a9ca`)
- v0.5-temporal — `feat/v0.5-temporal` (`7832636`)
- v0.5-integration — `feat/v0.5-integration` (`52a2e81`)

For v0.5-graph and v0.5-integration we report both **baseline** (no edge expansion — same retrieval path as v0.4) and **expand=1** (BFS over typed edges, depth 1). Edge expansion only helps when the harness creates edges; since the bench ingests independent session-facts with no `--refines/--supports/--depends-on` links, the expansion frontier is empty by construction. The expand=1 column is included to verify *no regression* relative to no-expansion.

**Sample size:** 20 per dataset slice (random sample, seed=42). LongMemEval-S Knowledge-Update was evaluated 2026-06-29T21:54Z; the LoCoMo cat-2 Temporal slice was added in a follow-up run on 2026-06-29T23:00Z (this file). v0.5-temporal was skipped in both runs because the temporal-validity surface (`valid_from` / `as_of` filter) does not change retrieval ranking for cold queries — it gates which rows are reachable, not how they are scored.
**Generated:** 2026-06-29T23:00Z (LoCoMo append)
**Harness:** `scripts/run-bench.mjs`

## Results

### LongMemEval-S Knowledge-Update (n=20)

| Condition | Recall@5 | Recall@10 | MRR | p50 latency | p99 latency |
|---|---|---|---|---|---|
| v0.4 baseline | 1.000 | 1.000 | 1.000 | 38.7 ms | 42.1 ms |
| v0.5-graph (no expansion) | 1.000 | 1.000 | 1.000 | 38.4 ms | 42.7 ms |
| v0.5-graph (expand=1) | 1.000 | 1.000 | 1.000 | 43.6 ms | 52.9 ms |
| v0.5-integration (no expansion) | 1.000 | 1.000 | 1.000 | 39.5 ms | 42.6 ms |
| v0.5-integration (expand=1) | 1.000 | 1.000 | 1.000 | 43.2 ms | 46.4 ms |

### LoCoMo cat-2 Temporal Reasoning (n=20)

Dataset source: `https://github.com/snap-research/locomo` — `data/locomo10.json` (sha256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`, 2 805 274 bytes, 10 multi-session conversations, 321 cat-2 questions total).
Scoring: exact session-id match. Each LoCoMo `evidence` entry has the form `"D{N}:{turn}"`; the unique `D{N}` prefixes form the ground-truth session-id set. Ingestion tags each session memory with `D{N}`; recall@K = a hit in the top-K results carries any ground-truth tag.
Sample: 20 questions from cat-2, seed=42 (out of 321 eligible).

| Condition | Recall@5 | Recall@10 | MRR | p50 latency | p99 latency |
|---|---|---|---|---|---|
| v0.4 baseline | 0.700 | 0.700 | 0.675 | 21.7 ms | 26.0 ms |
| v0.5-graph (no expansion) | 0.700 | 0.700 | 0.675 | 20.5 ms | 23.6 ms |
| v0.5-graph (expand=1) | 0.700 | 0.700 | 0.675 | 22.2 ms | 24.3 ms |
| v0.5-integration (no expansion) | 0.700 | 0.700 | 0.675 | 20.8 ms | 23.4 ms |
| v0.5-integration (expand=1) | 0.700 | 0.700 | 0.675 | 22.7 ms | 33.2 ms |

**Observations:**

- **Not saturated, but flat across conditions.** LoCoMo gives the harness real headroom (recall ceiling well below 1.000 — the BM25 ranker misses 30 % of cat-2 questions on the LongMemEval protocol). Even so, all five conditions produce identical recall and MRR to three decimal places. The 6/20 misses are the *same* 6 questions in every condition.
- **Graph expansion adds zero recall on this slice.** Same null result as LongMemEval, same root cause: the harness ingests each LoCoMo session as an independent memory with no `refines/supports/depends_on/conflicts_with` edges, so the BFS frontier is empty by construction. The expand=1 column measures only BFS bookkeeping cost (~1–2 ms p50, ~1–10 ms p99) — not actual traversal value. A real test of edge expansion needs a dataset that ships with typed edges, or a harness step that synthesises them (e.g. linking turns within a session as `supports`-chains).
- **The 30 % miss pool is BM25-shaped, not connectivity-shaped.** Spot-checking the failed questions: they're temporal-reference resolution (*"When did X happen?"* with the answer expressed as a relative date or implied by session boundaries the bench doesn't expose). The fix surface is temporal indexing + recency boost, not graph traversal — i.e. exactly what v0.5-temporal is about. The temporal branch isn't evaluated here because its surface (`as_of` filter) is gating, not ranking; it would help cases where multiple sessions contain the same fact at different times, which is **not** the LoCoMo cat-2 failure mode.
- **Latency is healthy.** All conditions sit at 20–23 ms p50. The integration expand=1 p99 spike (33 ms) is one outlier in a 20-question sample — not signal.

**Honest read:** Graph expansion shows no movement on LoCoMo, same as LongMemEval, for the same structural reason (empty edge frontier). The bench faithfully demonstrates the v0.5 graph code path *runs without regressing baseline retrieval*; it does **not** demonstrate that graph expansion improves recall, because the harness never constructs the edges expansion would traverse. Closing that gap requires an edges-enabled harness, not a different dataset.

## LongMemEval Observations

- **Retrieval metrics are saturated.** All five conditions score Recall@5 / Recall@10 / MRR = 1.000. The LongMemEval-S Knowledge-Update slice is too easy for this protocol: the ground-truth session id is prefixed `answer_*` (lexically distinctive vs other haystack ids like `sharegpt_xxx`), and the session content itself is the most BM25-relevant to the question by construction of the dataset. The dedup guard also drops near-duplicate sessions, so the candidate pool seen by the search is often only 1–10 items wide. None of this differs across conditions, so the comparison is fair — it just doesn't have headroom to distinguish them on recall.
- **v0.5-graph and v0.5-integration do not regress baseline retrieval.** Identical recall, MRR within noise. This is the primary safety claim the bench can support given current saturation.
- **Edge expansion adds ~5 ms p50 / ~5–10 ms p99 of latency.** The expand-edges code path runs even when the frontier is empty (no edges in these tmp stores), so this is the cost of the BFS bookkeeping itself, not the cost of actual traversal. Acceptable.
- **Edge expansion's retrieval value is unmeasured here.** The harness ingests independent session-facts with no `refines/supports/depends_on/conflicts_with` edges — so `expand-edges` walks a zero-hop frontier. A meaningful graph-traversal evaluation needs a dataset whose memories carry edges (or a harness step that synthesises them, e.g. by chaining sessions within a conversation). Out of scope for this run.

## Caveats

- n=20 per condition. p99 latency at this scale is noisy and dominated by tail variance.
- Title heuristic is the first 120 chars of each session — biases FTS toward whatever happens to start the session. Real-world memory titles would be different.
- Ground-truth matching is exact-tag match against `answer_session_ids` (LongMemEval) or `D{N}` session-id prefixes parsed from `evidence` (LoCoMo). Substring / semantic match not tested.
- v0.5-temporal not evaluated in either run; the `as_of` filter is a row-visibility gate that doesn't affect cold-query retrieval ranking. A meaningful evaluation needs questions where multiple sessions contain conflicting versions of the same fact at different times — LoCoMo cat-2 does not have that structure (it's single-version temporal-reference resolution).

See `scripts/bench-README.md` for methodology details and rerun instructions.
