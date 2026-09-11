# memspec — Benchmarks

**Methodology:** Homegrown retrieval-only harness (`scripts/run-bench.mjs`). Per-question fresh tmp store. `remember` per haystack session (one memory per session, tagged with session id), `search` for the question, score top-10 results against ground-truth session ids via tag match. Recall@5/10 + MRR. No LLM in the loop — retrieval quality only.

The original multi-condition harness (v0.4 vs v0.5 branches, edge-expansion variants) was removed from the repo in 0.7.1; it survives at git tag `v0.6.3` (`scripts/run-bench.mjs`, full results in that tag's `BENCHMARK.md`). This file reruns the same protocol as a single condition against the current release.

**Run:** 2026-07-27, memspec v0.9.0, Node 26, Apple Silicon. Sample n=20 per dataset, seed=42 (same sampler and seed as the v0.5-era runs).

**Datasets:**

- **LoCoMo cat-2 Temporal** — `snap-research/locomo` `data/locomo10.json`, sha256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` (byte-identical to the v0.5-era runs). 321 eligible category-2 questions; ground truth = unique `D{n}` prefixes of each question's `evidence` entries.
- **LongMemEval-S Knowledge-Update** — HuggingFace `xiaowu0162/longmemeval`, file `longmemeval_s`, sha256 `08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894`. Note: this hash differs from the v0.5-era runs (`d6f21ea9…`) — the upstream file has been revised since 2026-06; 78 knowledge-update questions were eligible in this revision.

## Results (v0.9.0)

| Dataset | n | Recall@5 | Recall@10 | MRR | p50 latency | p99 latency |
|---|---|---|---|---|---|---|
| LoCoMo cat-2 Temporal | 20 | 0.700 | 0.700 | 0.675 | 3.9 ms | 5.0 ms |
| LongMemEval-S Knowledge-Update | 20 | 1.000 | 1.000 | 1.000 | 10.5 ms | 13.4 ms |

## Observations

- **Retrieval quality is identical to the v0.4/v0.5 baselines** (LoCoMo 0.700/0.700/0.675; LongMemEval 1.000 across the board). Expected: no release from v0.6 through v0.9 touched the ranking path — this run's value is regression evidence, not a new claim.
- **LongMemEval-S Knowledge-Update stays saturated.** Ground-truth session ids are lexically distinctive and the answer session is the most BM25-relevant by dataset construction; the slice cannot differentiate retrieval strategies at this protocol. Reported for continuity, not bragging rights.
- **LoCoMo's 30% miss pool is unchanged and BM25-shaped**: temporal-reference questions ("when did X happen?") whose answers are relative dates or session-boundary implications the tag-match protocol doesn't expose. The fix surface is temporal indexing/recency boost, not graph traversal (analysis in the v0.6.3 `BENCHMARK.md` still applies).
- **Latency numbers are not comparable to the v0.5-era table** (different machine); they're included as current absolute figures only.
- **The synthetic LoCoMo miss pool above is temporal, but that's not the whole story on a real store**: a 2026-08-01 eval against a real store (n=40) found the actual miss pool is semantic vocabulary mismatch, not temporal gaps — BM25 Recall@5 0.475 vs. a dense/embeddings variant's 0.825 on the same queries. The hybrid engine was nevertheless removed 2026-09-11 by product decision; retrieval stays FTS5-only.

## Rerun

```bash
mkdir -p /tmp/eval-data
curl -sL -o /tmp/eval-data/locomo10.json https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json
curl -sL -o /tmp/eval-data/longmemeval_s.json "https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s"
npm run build
node scripts/run-bench.mjs        # BENCH_SAMPLE_SIZE=20 by default, seed=42
```

Raw per-run output lands at `/tmp/memspec-bench-v090.json`, including the miss list per dataset.
