# memspec — Benchmarks

**What this measures:** retrieval quality of `memspec_search`, version over version. Homegrown, retrieval-only harness — **no LLM in the loop.** Per question: a fresh tmp store, one `memspec_remember` per haystack session (tagged with the session id), one `memspec_search` for the question, then the top-K results are scored against the ground-truth session ids by tag match. Reported as Recall@5, Recall@10, and MRR.

**Versions:** each row is a released version pinned to its git tag — v0.4 (`v0.4.0`), v0.5 (`v0.5.0`), v0.6 (`v0.6.3`), v0.7 (`v0.7.0`). Each is checked out, rebuilt, and evaluated in an **isolated process** so a version's full module graph (ranking, storage, schema) is exercised — not just the entry point. Every version runs the same default retrieval path (FTS5 BM25, no edge expansion, no embeddings); the v0.5+ graph/temporal surfaces are opt-in and off here. For a version sweep that *does* exercise those capabilities on a purpose-built corpus, see `scripts/sim/SIM-BENCHMARK.md`.

**Datasets:**
- LongMemEval-S Knowledge-Update slice (sha256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`)
- LoCoMo category-2 Temporal slice (sha256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`)

**Sample size:** n shown per section heading (random sample, seed=42).
**Harness:** `scripts/run-bench.mjs` — see `scripts/bench-README.md` to reproduce.

## Results

### LongMemEval-S Knowledge-Update (n=20)

| Version | Recall@5 | Recall@10 | MRR | p50 latency | p99 latency |
|---|---|---|---|---|---|
| v0.4 (`v0.4.0`) | 1.000 | 1.000 | 1.000 | 11.7 ms | 14.3 ms |
| v0.5 (`v0.5.0`) | 1.000 | 1.000 | 1.000 | 11.6 ms | 13.0 ms |
| v0.6 (`v0.6.3`) | 1.000 | 1.000 | 1.000 | 11.5 ms | 13.1 ms |
| v0.7 (`v0.7.0`) | 1.000 | 1.000 | 1.000 | 11.6 ms | 12.6 ms |

### LoCoMo cat-2 Temporal Reasoning (n=20)

| Version | Recall@5 | Recall@10 | MRR | p50 latency | p99 latency |
|---|---|---|---|---|---|
| v0.4 (`v0.4.0`) | 0.700 | 0.700 | 0.675 | 3.9 ms | 4.9 ms |
| v0.5 (`v0.5.0`) | 0.700 | 0.700 | 0.675 | 4.1 ms | 5.2 ms |
| v0.6 (`v0.6.3`) | 0.700 | 0.700 | 0.675 | 3.9 ms | 4.4 ms |
| v0.7 (`v0.7.0`) | 0.700 | 0.700 | 0.675 | 3.9 ms | 4.9 ms |

## Reading the numbers

- **Retrieval ranking is unchanged across v0.4 → v0.7 on the default path.** Recall and MRR are identical to three decimals in every version because none of these releases changed the default FTS5 BM25 scoring path: v0.5 added the (opt-in, off here) graph/temporal surfaces, v0.6 renamed graph traversal to "linked notes" and fixed layered-store retrieval, v0.7 added the offline `memspec-dream` reflection pass. With process isolation each row genuinely runs its own build, so this is a measured no-regression result, not an artifact of shared module state.
- **LongMemEval is saturated (Recall = 1.000).** The Knowledge-Update slice is easy for this protocol: ground-truth content is the most BM25-relevant to the question by construction, and the dedup guard keeps the candidate pool narrow. A no-regression tripwire, not a discriminator.
- **LoCoMo has real headroom.** ~30% of cat-2 stays unanswered by BM25 — a temporal-resolution / ranking problem, identical misses in every version.
- **This benchmark deliberately does not exercise v0.5+ capabilities.** Edge expansion, temporal `as_of`, and archived-record retrieval are off on the default path. Their version-over-version effect is measured separately in `scripts/sim/SIM-BENCHMARK.md`, a purpose-built corpus where those features have something to act on.

See `scripts/bench-README.md` for methodology details and rerun instructions.
