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

**Sample size:** 20 per dataset slice (random sample, seed=42). Only the LongMemEval-S Knowledge-Update slice was evaluated in this run; v0.5-temporal was skipped to stay within the time box.
**Generated:** 2026-06-29T21:54:14Z
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

## Observations

- **Retrieval metrics are saturated.** All five conditions score Recall@5 / Recall@10 / MRR = 1.000. The LongMemEval-S Knowledge-Update slice is too easy for this protocol: the ground-truth session id is prefixed `answer_*` (lexically distinctive vs other haystack ids like `sharegpt_xxx`), and the session content itself is the most BM25-relevant to the question by construction of the dataset. The dedup guard also drops near-duplicate sessions, so the candidate pool seen by the search is often only 1–10 items wide. None of this differs across conditions, so the comparison is fair — it just doesn't have headroom to distinguish them on recall.
- **v0.5-graph and v0.5-integration do not regress baseline retrieval.** Identical recall, MRR within noise. This is the primary safety claim the bench can support given current saturation.
- **Edge expansion adds ~5 ms p50 / ~5–10 ms p99 of latency.** The expand-edges code path runs even when the frontier is empty (no edges in these tmp stores), so this is the cost of the BFS bookkeeping itself, not the cost of actual traversal. Acceptable.
- **Edge expansion's retrieval value is unmeasured here.** The harness ingests independent session-facts with no `refines/supports/depends_on/conflicts_with` edges — so `expand-edges` walks a zero-hop frontier. A meaningful graph-traversal evaluation needs a dataset whose memories carry edges (or a harness step that synthesises them, e.g. by chaining sessions within a conversation). Out of scope for this run.

## Caveats

- n=20 per condition. p99 latency at this scale is noisy and dominated by tail variance.
- Title heuristic is the first 120 chars of each session — biases FTS toward whatever happens to start the session. Real-world memory titles would be different.
- Ground-truth matching is exact-tag match against `answer_session_ids`. Substring / semantic match not tested.
- LoCoMo and v0.5-temporal not evaluated in this run; would need a follow-up.

See `scripts/bench-README.md` for methodology details and rerun instructions.
