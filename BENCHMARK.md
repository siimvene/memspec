# memspec — Benchmarks

Three instruments, each answering a different question:

1. **Synthetic retrieval** (`scripts/run-bench.mjs`): does ranking regress? LoCoMo and LongMemEval slices, recall only.
2. **Real-store retrieval**: does an agent find the record it needs in a store that has grown for months? 100 blind queries against a 2,366-record store.
3. **Wrongness** (`scripts/bench-wrongness/`): how often does memory serve outdated facts as current, how often does it cry wolf, and does `memspec check` tell a contradiction from a compatible claim? Method and full tables in [`scripts/bench-wrongness/README.md`](scripts/bench-wrongness/README.md).

All runs: Node 26, Apple Silicon. "main" below is the post-0.13.0 tree (search tiers, record cache, trust gates, OKF), not yet released to npm.

## 1. Synthetic retrieval

**Method:** per-question fresh tmp store, `remember` once per haystack session (tagged with the session id), `search` the question, score the top 10 against ground-truth session ids by tag. Recall@5/10 and MRR; no LLM in the loop.

**Datasets:**

- **LoCoMo cat-2 Temporal** — `snap-research/locomo` `data/locomo10.json`, sha256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`. 321 eligible category-2 questions; ground truth = unique `D{n}` prefixes of each question's `evidence`.
- **LongMemEval-S Knowledge-Update** — HuggingFace `xiaowu0162/longmemeval`, file `longmemeval_s`, sha256 `08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894` (revised upstream since the v0.5-era runs, which used `d6f21ea9…`). 78 eligible questions.

**Full eligible sets (2026-10-26):**

| Dataset | n | Build | Recall@5 | Recall@10 | MRR | p50 |
|---|---|---|---|---|---|---|
| LoCoMo cat-2 | 321 | 0.13.0 | 0.822 | 0.869 | 0.716 | 5.8 ms |
| LoCoMo cat-2 | 321 | main | 0.866 | 0.919 | 0.733 | 3.6 ms |
| LongMemEval-S KU | 78 | 0.13.0 | 1.000 | 1.000 | 0.981 | 16.1 ms |
| LongMemEval-S KU | 78 | main | 1.000 | 1.000 | 0.981 | 10.0 ms |

The historical n=20 sample (seed 42) reads 0.700 / 0.700 / 0.675 on LoCoMo for every release from 0.4 to 0.13.0 and 0.750 / 0.850 / 0.706 on main; it was a pessimistic draw, so the full sets are the numbers to quote.

**Latency by release** (n=20 sample, each tag rebuilt and run twice on the same machine, p50): 0.9.0 3.2 / 8.8 ms, 0.10.0 3.2 / 8.9 ms, 0.11.0 5.4 / 15.7 ms, 0.12.3 5.4 / 16.0 ms, 0.13.0 5.8 / 16.7 ms, main 3.7-3.9 / 9.9-10.7 ms (LoCoMo / LongMemEval). The 0.11.0 step was the coverage classifier reading back every token of each hit body; main checks only which query tokens a hit contains.

**Observations:**

- **LongMemEval-S Knowledge-Update is saturated.** Ground-truth sessions are lexically distinctive by construction; the slice cannot separate retrieval strategies. Reported for continuity.
- **The synthetic miss pool is not the real one.** LoCoMo's misses are temporal-reference questions; on a real store the misses are vocabulary mismatch (section 2).

## 2. Real-store retrieval

**Method:** a byte copy of a long-lived personal store (2,366 active claims, 1,553 archived; private, so queries and records are not published). 100 records sampled with a fixed seed, stratified by type (72 facts, 18 decisions, 10 procedures). For each, an agent that never saw the search engine wrote two queries:

- **natural**: how an agent asks mid-task, project names allowed, title not copied;
- **paraphrase**: avoids the record's distinctive vocabulary entirely (describes the situation instead).

Score = rank of the target record in `searchPayload` (limit 50), unscoped. **Ranking has a recency term**, so results move with the clock: every comparison below runs both builds with the clock pinned to the same instant.

| natural queries | R@1 | R@5 | R@10 | MRR |
|---|---|---|---|---|
| 0.13.0, clock 2026-10-25 | 0.72 | 0.90 | 0.95 | 0.807 |
| main, same clock | 0.72 | 0.93 | 1.00 | 0.819 |
| 0.13.0, clock 2026-10-26 | 0.82 | 0.95 | 0.95 | 0.873 |
| main, same clock | 0.82 | 0.99 | 1.00 | 0.889 |

| paraphrase queries | R@1 | R@5 | R@10 | MRR |
|---|---|---|---|---|
| 0.13.0 and main, clock 2026-10-25 | 0.06 | 0.42 | 0.59 | 0.212 |
| 0.13.0 and main, clock 2026-10-26 | 0.27 | 0.51 | 0.63 | 0.378 |

- **Every natural-query miss on 0.13.0** was the AND-first fallback: a query with one term the target lacked returned 1-3 other records and dropped the target. Main tiers matches (all terms first, partial matches below, never above).
- **Paraphrase is the lexical ceiling.** No change moves it; a 2026-08-01 eval on the same store (n=40) measured dense retrieval at R@5 0.825 against BM25's 0.475. Retrieval stays FTS5-only by decision; what main changes is that the store now says so: coverage reads `weak` on 32 of 41 paraphrase misses at R@10 (0.13.0: 0 of 41) while every natural-query hit reads `ok`.
- **The clock matters as much as the code.** Same build, one day apart: paraphrase R@1 0.06 vs 0.27. `1/(1+ageDays)` at weight 0.3 lets same-day records crowd the top ranks on a store that grows by dozens of records a day.
- **Latency:** warm in-process search p50 295 ms on 0.13.0 vs 38 ms on main (back to back, same store). 85% of 0.13.0's search time was re-reading and YAML-parsing every record file on every query; main caches parsed records per file. A cold index build plus first search: ~0.4-0.8 s.

## 3. Wrongness

Full method, provenance (Hono, 367 first-parent commits after v4.6.0, pinned SHAs), per-class tables and threats to validity: [`scripts/bench-wrongness/README.md`](scripts/bench-wrongness/README.md). Headline at the last checkpoint (C5), ~2,100 facts extracted and graded by script, no model in the loop:

| row | stale-served | false alarm | balanced acc |
|---|---|---|---|
| memspec, whole-file anchors, all facts | 6.5% | 87.3% | 53.1% |
| memspec, code facts only | 0% | 87.1% | 56.5% |
| symbol-grain counterfactual, code facts | 0% | 23.1% | 88.4% |
| unlinked memory (never flags) | 100% | 0% | 50% |

- Whole-file anchors almost never serve a stale fact whose truth lives in the anchored file, but on an active repository nearly every anchored file changes, so most alarms are false. Symbol-grain anchoring is the measured fix.
- Cross-file facts are the stale-served hole (25% of changed `usage` facts with subject-file anchors).
- On a real personal store, 16 of 30 drifted claims were still true, 6 of them anchored before the change they describe landed; `verify --reanchor` re-baselines those with history.
- `memspec check` pairs 86-95% of anchored contradictions with their target but flags compatible claims nearly as often (72-89%): it is a "same topic changed, review it" gate, not a contradiction detector. A declared `refines` edge clears the false pairing.

## Rerun

```bash
# 1. synthetic
mkdir -p /tmp/eval-data
curl -sL -o /tmp/eval-data/locomo10.json https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json
curl -sL -o /tmp/eval-data/longmemeval_s.json "https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s"
npm run build
node scripts/run-bench.mjs                          # n=20, seed 42
BENCH_SAMPLE_SIZE=1000 node scripts/run-bench.mjs   # full eligible sets

# 3. wrongness (~10 minutes; clones Hono into a temp dir, builds nothing from it)
node scripts/bench-wrongness/run.mjs /tmp/wrongness.json
```

Section 2 needs a real store and is not reproducible from this repository; its harness is a 60-line loop over `searchPayload` with the clock pinned (`Date` replaced by a fixed instant) so both builds see the same recency.
