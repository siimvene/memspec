# memspec retrieval benchmark harness

Retrieval-only evaluation that compares memspec v0.4 vs v0.5 branches on two
public long-conversation datasets. **No LLM in the loop.** Pure recall/MRR over
top-K results from `memspec_search`.

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

The harness samples 50 questions per slice with a fixed seed (`42`,
Mulberry32 + Fisher–Yates partial shuffle) so the picks are stable across
reruns. `BENCH_SAMPLE_SIZE` and `BENCH_SEED` env vars override the constants
for smoke tests.

## Per-question protocol

1. Fresh tmp store: `mktemp -d /tmp/eval-store-*` → `new MemspecStore(root).init()`.
2. **Ingest one memory per session.** Title = first 120 chars of the
   concatenated turns (the dataset doesn't carry session titles, so the
   first-N-chars heuristic gives FTS something to score on). Body = all turns
   in the session joined with `[role] content` line prefixes. Tags = the
   session id (`sharegpt_xxx`/`answer_xxx` for LongMemEval, `D{n}` for
   LoCoMo). `check_by: never` so nothing decays during the run.
3. `memspec_search` the question text via `searchPayload(...)`, `--limit 10`.
4. For v0.5-graph and v0.5-integration we run a second pass with
   `expandEdges: true, expandDepth: 1`. Since the harness never wires typed
   edges between session-memories, the expansion frontier is empty — the
   second pass is a *no-regression* check, not an apples-to-oranges win.
5. Score: a result counts as a hit when any of its `tags` matches a
   ground-truth session id.
   - LongMemEval: ground truth = `answer_session_ids`.
   - LoCoMo: ground truth = unique `D{n}` prefixes of `evidence` entries.
6. Record `recall@5`, `recall@10`, reciprocal rank (`1 / first-hit rank`,
   0 if no hit in top 10), and per-query wall latency.
7. Mean across questions → reported in BENCHMARK.md.

## Conditions and how branches are evaluated

| Condition         | Git ref                | Notes |
|-------------------|------------------------|-------|
| v0.4 baseline     | `main` (`5e26ec2`)     | baseline retrieval |
| v0.5-graph        | `feat/v0.5-graph` (`d43a9ca`) | retrieval-only + edge-expansion variant |
| v0.5-temporal     | `feat/v0.5-temporal` (`7832636`) | adds `valid_from/valid_to`; harness doesn't set them, so retrieval matches v0.4 |
| v0.5-integration  | `feat/v0.5-integration` (`52a2e81`) | graph + temporal merged |

Per condition the harness:

1. `git checkout <ref>`
2. `npm run build` (rebuilds `dist/`)
3. Dynamic-imports `dist/commands/{remember,search}.js` and
   `dist/lib/store.js` with a cache-bust query string so the new branch's
   compiled code is loaded into the running Node process.

This is why the harness lives on its own branch (`feat/v0.5-eval`). The
script itself is unstaged on the other branches during execution because
`git checkout` removes the committed file — Node has already loaded it into
memory, so the process keeps running.

## Reproducing

From the repo root on `feat/v0.5-eval`:

```bash
# One condition, one dataset (smoke):
BENCH_SAMPLE_SIZE=5 node scripts/run-bench.mjs --branch v0.4 --dataset longmemeval

# Full sweep (all 4 branches × 2 datasets, ~20–40 min wall):
node scripts/run-bench.mjs --all

# Render BENCHMARK.md from /tmp/memspec-bench-results/*.json:
node scripts/run-bench.mjs --render
```

Per-condition raw outputs (including per-question hit ranks) are written to
`/tmp/memspec-bench-results/<branch>-<dataset>-<variant>.json`. They are not
committed to the repo.

## Known limits

- **No semantic embeddings.** Default memspec retrieval is FTS5 BM25; the
  hybrid embeddings backend is off. This is the fair v0.4-vs-v0.5 comparison
  because no released v0.5 branch ships embeddings.
- **Title heuristic is crude.** Using the first 120 chars of session text as
  the title biases FTS toward whatever happens to start the session. A
  follow-up could try LLM-generated titles, but that re-introduces an LLM
  dependency the harness is built to avoid.
- **Edge expansion is a no-op as configured.** The bench creates no edges,
  so `expandEdges=true` walks zero hops. This is intentional — it proves the
  expand-edges code path doesn't degrade baseline retrieval. A meaningful
  graph-traversal evaluation needs a dataset whose memories carry edges
  (refines/supports/depends-on), which neither LongMemEval nor LoCoMo
  provides natively.
- **Knowledge-update + temporal slices only.** Other LongMemEval categories
  (multi-session, abstention, etc.) are skipped because they aren't what the
  task asked us to measure.
- **Near-duplicate rejection.** Some sessions repeat similar greetings and
  the remember-time duplicate guard rejects them; the harness swallows
  those errors and continues so the rest of the haystack still indexes.
