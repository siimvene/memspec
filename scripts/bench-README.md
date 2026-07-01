# memspec retrieval benchmark harness

Retrieval-only evaluation that compares released memspec versions (v0.4 → v0.7)
on two public long-conversation datasets. **No LLM in the loop.** Pure
recall/MRR over the top-K results from `memspec_search`.

## Datasets

Both are downloaded once into `/tmp/eval-data/`:

| Dataset           | File path                              | Source |
|-------------------|----------------------------------------|--------|
| LongMemEval-S     | `/tmp/eval-data/longmemeval_s.json`    | https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json |
| LoCoMo (locomo10) | `/tmp/eval-data/locomo10.json`         | https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json |

Slices used:
- LongMemEval-S: `question_type == "knowledge-update"` (78 questions total).
- LoCoMo: `qa.category == 2` (temporal — 321 questions across the 10
  conversations once flattened).

The harness samples `BENCH_SAMPLE_SIZE` questions per slice (default 20) with a
fixed seed (`42`, Mulberry32 + Fisher–Yates partial shuffle) so the picks are
stable across reruns. `BENCH_SAMPLE_SIZE` and `BENCH_SEED` override the
constants for smoke tests.

## Per-question protocol

1. Fresh tmp store: `mktemp -d /tmp/eval-store-*` → `new MemspecStore(root).init()`.
2. **Ingest one memory per session.** Title = first 120 chars of the
   concatenated turns (the dataset doesn't carry session titles, so the
   first-N-chars heuristic gives FTS something to score on). Body = all turns
   in the session joined with `[role] content` line prefixes. Tags = the
   session id (`sharegpt_xxx`/`answer_xxx` for LongMemEval, `D{n}` for
   LoCoMo). `check_by: never` so nothing decays during the run.
3. `memspec_search` the question text via `searchPayload(...)`, `--limit 10`,
   default retrieval path (FTS5 BM25, no edge expansion, no embeddings).
4. Score: a result counts as a hit when any of its `tags` matches a
   ground-truth session id.
   - LongMemEval: ground truth = `answer_session_ids`.
   - LoCoMo: ground truth = unique `D{n}` prefixes of `evidence` entries.
5. Record `recall@5`, `recall@10`, reciprocal rank (`1 / first-hit rank`,
   0 if no hit in top 10), and per-query wall latency.
6. Mean across questions → reported in BENCHMARK.md.

## Versions and how they are evaluated

Each row in BENCHMARK.md is a released version, pinned to its git tag:

| Version | Git tag  |
|---------|----------|
| v0.4    | `v0.4.0` |
| v0.5    | `v0.5.0` |
| v0.6    | `v0.6.3` |
| v0.7    | `v0.7.0` |

Per version the orchestrator (`run-bench.mjs`):

1. `git checkout <tag>`
2. `npm run build` (rebuilds `dist/`)
3. Spawns `_bench-worker.mjs` in a **separate `node` process** to evaluate both
   datasets against that version's `dist/`.

The separate process is not optional. An earlier version imported each build
into the *same* process with a cache-busting query string — but Node only
cache-busts the exact specifier, so a version's transitive dependencies
(`store.js` → `fts.js`, `schema.js`, `graph-walk.js`) resolve to whichever
version loaded **first** and stay cached. The result was every row silently
running v0.4's ranking code. A fresh process per version loads that version's
entire module graph, which is the only correct way to compare builds in-repo.

The orchestrator survives `git checkout` because Node loads it into memory at
startup; the worker, however, is a file on disk that an old-tag checkout would
delete mid-sweep, so `run-bench.mjs` copies it to a `/tmp` staging path before
the first checkout and spawns it from there. Keep the repo tree clean before
starting (each `git checkout <tag>` must not conflict with uncommitted changes).

The v0.5+ graph/temporal surfaces (`expandEdges`, `asOf`, `includeSuperseded`)
are off on this default path: the datasets carry no typed edges or validity
windows, so those features have nothing to act on here. Their version-over-version
effect is measured on a purpose-built corpus in `scripts/sim/` — see
`scripts/sim/README.md` and `scripts/sim/SIM-BENCHMARK.md`.

## Reproducing

```bash
# 0. Download datasets (once):
mkdir -p /tmp/eval-data
curl -sSL -o /tmp/eval-data/locomo10.json \
  https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json
curl -sSL -o /tmp/eval-data/longmemeval_s.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json

# 1. Full sweep (all 4 version tags × 2 datasets), then render BENCHMARK.md.
#    Run from a CLEAN tree: the sweep checks out each tag, so uncommitted changes
#    to tracked files would block the checkout. The orchestrator survives the
#    checkouts (loaded in memory) and self-stages its worker to /tmp; it restores
#    your branch when done.
node scripts/run-bench.mjs --all

# Re-render from cached results without re-running:
node scripts/run-bench.mjs --render
```

`BENCH_SAMPLE_SIZE` / `BENCH_SEED` override the sample size (default 20) and seed.

Per-version raw outputs (including per-question hit ranks) are written to
`/tmp/memspec-bench-results/<version>-<dataset>.json`. They are not committed to
the repo.

## Known limits

- **No semantic embeddings.** Default memspec retrieval is FTS5 BM25; the
  hybrid embeddings backend is off. No released version ships embeddings on by
  default, so this is the fair cross-version comparison.
- **Title heuristic is crude.** Using the first 120 chars of session text as
  the title biases FTS toward whatever happens to start the session.
- **Edge expansion is a no-op as configured.** The bench creates no edges, so
  the `expandEdges` path (added in v0.5) walks zero hops. A meaningful
  linked-note evaluation needs a dataset whose memories carry typed edges
  (refines/supports/depends-on), which neither LongMemEval nor LoCoMo provides
  natively.
- **Knowledge-update + temporal slices only.** Other LongMemEval categories
  (multi-session, abstention, etc.) are skipped.
- **Near-duplicate rejection.** Some sessions repeat similar greetings and the
  remember-time duplicate guard rejects them; the harness swallows those errors
  and continues so the rest of the haystack still indexes.
