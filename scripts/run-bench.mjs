#!/usr/bin/env node
// Retrieval-only benchmark harness for memspec v0.4 vs v0.5 conditions.
// Spawns no Python; no LLM in the loop. Uses memspec's library API directly.
//
// Usage:
//   node scripts/run-bench.mjs --branch v0.4 --dataset longmemeval
//   node scripts/run-bench.mjs --all
//
// Outputs JSON results to /tmp/memspec-bench-results/<branch>-<dataset>.json.
// Aggregation into BENCHMARK.md is a separate step (--render).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
// REPO_ROOT can be pinned via env so the script can be staged outside the repo
// and survive the in-flight `git checkout` (otherwise the script file itself
// disappears mid-run on branches that don't carry it).
const REPO_ROOT = process.env.BENCH_REPO_ROOT || resolve(here, '..');
const DATA_DIR = '/tmp/eval-data';
const RESULTS_DIR = '/tmp/memspec-bench-results';
const SAMPLE_SIZE = Number(process.env.BENCH_SAMPLE_SIZE || 50);
const SEED = Number(process.env.BENCH_SEED || 42);

const BRANCHES = ['v0.4', 'v0.5-graph', 'v0.5-temporal', 'v0.5-integration'];
const BRANCH_REFS = {
  'v0.4': 'main',
  'v0.5-graph': 'feat/v0.5-graph',
  'v0.5-temporal': 'feat/v0.5-temporal',
  'v0.5-integration': 'feat/v0.5-integration',
};
const DATASETS = ['longmemeval', 'locomo'];

// --- Argument parsing -------------------------------------------------------

function parseArgs(argv) {
  const args = { all: false, render: false, branch: null, dataset: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--render') args.render = true;
    else if (a === '--branch') args.branch = argv[++i];
    else if (a === '--dataset') args.dataset = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/run-bench.mjs [--all | --branch <b> --dataset <d> | --render]');
      process.exit(0);
    }
  }
  return args;
}

// --- Reproducible sampling --------------------------------------------------

// Mulberry32 PRNG for stable cross-platform sampling.
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(arr, n, seed) {
  const rng = mulberry32(seed);
  const copy = arr.slice();
  // Fisher–Yates partial shuffle for n picks.
  for (let i = 0; i < Math.min(n, copy.length); i++) {
    const j = i + Math.floor(rng() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

// --- Dataset loaders --------------------------------------------------------

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function loadLongMemEval() {
  const path = join(DATA_DIR, 'longmemeval_s.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  // Knowledge-update slice. Schema field is "question_type": "knowledge-update".
  const slice = raw.filter((q) => q.question_type === 'knowledge-update');
  const picks = sample(slice, SAMPLE_SIZE, SEED);
  // Normalise to harness shape.
  return {
    sha256: sha256File(path),
    total: slice.length,
    sampled: picks.length,
    questions: picks.map((q) => ({
      question_id: q.question_id,
      question: q.question,
      ground_truth_session_ids: q.answer_session_ids,
      sessions: q.haystack_session_ids.map((sid, i) => ({
        session_id: sid,
        // Concatenate all turns in the session into one body.
        body: q.haystack_sessions[i]
          .map((t) => `[${t.role}] ${t.content}`)
          .join('\n\n'),
      })),
    })),
  };
}

function loadLoCoMo() {
  const path = join(DATA_DIR, 'locomo10.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  // Flatten: each conversation (item) has many cat-2 questions.
  // For each cat-2 question, treat the parent conversation's sessions as haystack.
  // Evidence is "D{sess}:{turn}" → ground-truth session id is `D{sess}`.
  const questions = [];
  for (const item of raw) {
    const conv = item.conversation;
    // Collect all session_N keys.
    const sessionKeys = Object.keys(conv).filter((k) => /^session_\d+$/.test(k));
    const sessions = sessionKeys.map((k) => {
      const idx = Number(k.split('_')[1]);
      const turns = conv[k];
      if (!Array.isArray(turns)) return null;
      const body = turns
        .map((t) => `[${t.speaker}] ${t.text}`)
        .join('\n\n');
      return { session_id: `D${idx}`, body };
    }).filter(Boolean);
    for (const qa of item.qa) {
      if (qa.category !== 2) continue;
      // Evidence like ["D1:3","D4:7"] → ground-truth = unique D{n} prefixes.
      const evidence = Array.isArray(qa.evidence) ? qa.evidence : [];
      const gt = [...new Set(evidence.map((e) => String(e).split(':')[0]))];
      if (gt.length === 0) continue;
      questions.push({
        question_id: `${item.sample_id}_${questions.length}`,
        question: qa.question,
        ground_truth_session_ids: gt,
        sessions,
      });
    }
  }
  const picks = sample(questions, SAMPLE_SIZE, SEED);
  return {
    sha256: sha256File(path),
    total: questions.length,
    sampled: picks.length,
    questions: picks,
  };
}

// --- Per-question evaluation ------------------------------------------------

async function evalQuestion(api, question, options) {
  const storeRoot = join(tmpdir(), `eval-store-${randomBytes(8).toString('hex')}`);
  mkdirSync(storeRoot, { recursive: true });
  try {
    const store = new api.MemspecStore(storeRoot);
    store.init();

    // Ingest: one memory per session, tagged with session_id.
    for (const s of question.sessions) {
      // Title needs to be informative for FTS hit. Use first ~120 chars of body
      // as a synthetic title since real titles aren't available in the dataset.
      const titleSeed = s.body.replace(/\s+/g, ' ').trim().slice(0, 120) || s.session_id;
      try {
        api.runRemember('fact', titleSeed, {
          cwd: storeRoot,
          body: s.body,
          source: 'eval',
          tags: s.session_id,
          checkBy: 'never',
        });
      } catch (e) {
        // Some sessions may collide on near-duplicate detection — skip and continue;
        // we still want as much haystack as possible. Rare.
      }
    }

    // Search.
    const searchOpts = {
      cwd: storeRoot,
      limit: '10',
      json: true,
    };
    if (options.expandEdges) {
      searchOpts.expandEdges = true;
      searchOpts.expandDepth = 1;
    }
    const t0 = process.hrtime.bigint();
    const payload = api.searchPayload(question.question, searchOpts);
    const t1 = process.hrtime.bigint();
    const latencyMs = Number(t1 - t0) / 1e6;

    const results = payload.results || [];
    // Score: tag membership in ground_truth_session_ids.
    const gtSet = new Set(question.ground_truth_session_ids);
    const ranks = []; // 1-indexed rank for each hit that matches.
    let firstHitRank = 0;
    results.forEach((r, idx) => {
      const tags = r.tags || [];
      if (tags.some((t) => gtSet.has(t))) {
        ranks.push(idx + 1);
        if (firstHitRank === 0) firstHitRank = idx + 1;
      }
    });

    return {
      question_id: question.question_id,
      latency_ms: latencyMs,
      result_count: results.length,
      ground_truth_count: question.ground_truth_session_ids.length,
      hit_ranks: ranks,
      first_hit_rank: firstHitRank,
      recall_at_5: ranks.some((r) => r <= 5) ? 1 : 0,
      recall_at_10: ranks.some((r) => r <= 10) ? 1 : 0,
      reciprocal_rank: firstHitRank > 0 ? 1 / firstHitRank : 0,
    };
  } finally {
    try {
      rmSync(storeRoot, { recursive: true, force: true });
    } catch {}
  }
}

// --- Run a single (branch × dataset × variant) condition --------------------

function loadApi() {
  // Import fresh from dist/ (the caller has already checked out + built).
  const distRoot = join(REPO_ROOT, 'dist');
  const cacheBust = `?t=${Date.now()}-${randomBytes(4).toString('hex')}`;
  return Promise.all([
    import(pathToFileURL(join(distRoot, 'commands/remember.js')).href + cacheBust),
    import(pathToFileURL(join(distRoot, 'commands/search.js')).href + cacheBust),
    import(pathToFileURL(join(distRoot, 'lib/store.js')).href + cacheBust),
  ]).then(([rm, sr, st]) => ({
    runRemember: rm.runRemember,
    searchPayload: sr.searchPayload,
    MemspecStore: st.MemspecStore,
  }));
}

function checkoutAndBuild(branchKey) {
  const ref = BRANCH_REFS[branchKey];
  if (!ref) throw new Error(`unknown branch key: ${branchKey}`);
  console.log(`[bench] git checkout ${ref}`);
  execSync(`git checkout ${ref}`, { cwd: REPO_ROOT, stdio: 'inherit' });
  console.log('[bench] npm run build');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

async function runCondition(branchKey, datasetKey, variantKey, dataset) {
  // variantKey: 'baseline' (no expand) or 'expand1' (expand_edges depth=1).
  const expandEdges = variantKey === 'expand1';
  console.log(`[bench] running ${branchKey} × ${datasetKey} × ${variantKey} on ${dataset.questions.length} questions`);
  const api = await loadApi();
  const perQ = [];
  const start = Date.now();
  let i = 0;
  for (const q of dataset.questions) {
    i++;
    const r = await evalQuestion(api, q, { expandEdges });
    perQ.push(r);
    if (i % 10 === 0) {
      console.log(`  [${i}/${dataset.questions.length}] recall@10=${perQ.filter((x) => x.recall_at_10).length}/${i}`);
    }
  }
  const wall = (Date.now() - start) / 1000;

  // Aggregate.
  const n = perQ.length;
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const recall5 = sum(perQ.map((r) => r.recall_at_5)) / n;
  const recall10 = sum(perQ.map((r) => r.recall_at_10)) / n;
  const mrr = sum(perQ.map((r) => r.reciprocal_rank)) / n;
  const lats = perQ.map((r) => r.latency_ms).sort((a, b) => a - b);
  const p = (q) => lats[Math.min(lats.length - 1, Math.floor(q * lats.length))];

  const summary = {
    branch: branchKey,
    dataset: datasetKey,
    variant: variantKey,
    n,
    recall_at_5: recall5,
    recall_at_10: recall10,
    mrr,
    p50_latency_ms: p(0.5),
    p99_latency_ms: p(0.99),
    wall_seconds: wall,
    per_question: perQ,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = join(RESULTS_DIR, `${branchKey}-${datasetKey}-${variantKey}.json`);
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`[bench] wrote ${outPath}`);
  console.log(`  recall@5=${recall5.toFixed(3)} recall@10=${recall10.toFixed(3)} mrr=${mrr.toFixed(3)} p50=${p(0.5).toFixed(1)}ms p99=${p(0.99).toFixed(1)}ms wall=${wall.toFixed(0)}s`);
  return summary;
}

// --- Top-level orchestration ------------------------------------------------

function loadDataset(key) {
  if (key === 'longmemeval') return loadLongMemEval();
  if (key === 'locomo') return loadLoCoMo();
  throw new Error(`unknown dataset: ${key}`);
}

function renderMarkdown(allResults, datasetSha) {
  const byDataset = {};
  for (const r of allResults) {
    if (!byDataset[r.dataset]) byDataset[r.dataset] = [];
    byDataset[r.dataset].push(r);
  }
  const fmt = (n, d = 3) => Number(n).toFixed(d);
  const ms = (n) => `${n.toFixed(1)} ms`;

  let md = `# memspec — Benchmarks

**Methodology:** Homegrown retrieval-only harness. Per-question fresh tmp store. \`memspec_remember\` per haystack session (one memory per session, tagged with session id), \`memspec_search\` for the question, score top-K results against ground-truth session ids via tag match. Recall@5/10 + MRR. No LLM in the loop (retrieval quality only).

**Datasets:**
- LongMemEval-S Knowledge-Update slice (sha256 \`${datasetSha.longmemeval}\`)
- LoCoMo category-2 Temporal slice (sha256 \`${datasetSha.locomo}\`)

**Conditions:**
- v0.4 baseline — \`main\` (\`5e26ec2\`)
- v0.5-graph — \`feat/v0.5-graph\` (\`d43a9ca\`)
- v0.5-temporal — \`feat/v0.5-temporal\` (\`7832636\`)
- v0.5-integration — \`feat/v0.5-integration\` (\`52a2e81\`)

For v0.5-graph and v0.5-integration we report both **baseline** (no edge expansion — same retrieval path as v0.4) and **expand=1** (BFS over typed edges, depth 1). Edge expansion only helps when the harness creates edges; since the bench ingests independent session-facts with no \`--refines/--supports/--depends-on\` links, the expansion frontier is empty by construction. The expand=1 column is included to verify *no regression* relative to no-expansion.

**Sample size:** ${SAMPLE_SIZE} per dataset slice (random sample, seed=${SEED}).
**Generated:** ${new Date().toISOString()}
**Harness:** \`scripts/run-bench.mjs\`

## Results
`;

  for (const ds of ['longmemeval', 'locomo']) {
    const rows = byDataset[ds] || [];
    if (rows.length === 0) continue;
    const dsLabel = ds === 'longmemeval' ? 'LongMemEval-S Knowledge-Update' : 'LoCoMo cat-2 Temporal';
    const n = rows[0].n;
    md += `\n### ${dsLabel} (n=${n})\n\n`;
    md += `| Condition | Recall@5 | Recall@10 | MRR | p50 latency | p99 latency |\n`;
    md += `|---|---|---|---|---|---|\n`;
    const order = [
      ['v0.4', 'baseline', 'v0.4 baseline'],
      ['v0.5-graph', 'baseline', 'v0.5-graph (no expansion)'],
      ['v0.5-graph', 'expand1', 'v0.5-graph (expand=1)'],
      ['v0.5-temporal', 'baseline', 'v0.5-temporal'],
      ['v0.5-integration', 'baseline', 'v0.5-integration (no expansion)'],
      ['v0.5-integration', 'expand1', 'v0.5-integration (expand=1)'],
    ];
    for (const [b, v, label] of order) {
      const r = rows.find((x) => x.branch === b && x.variant === v);
      if (!r) continue;
      md += `| ${label} | ${fmt(r.recall_at_5)} | ${fmt(r.recall_at_10)} | ${fmt(r.mrr)} | ${ms(r.p50_latency_ms)} | ${ms(r.p99_latency_ms)} |\n`;
    }
  }

  md += `
## Observations

See \`scripts/bench-README.md\` for methodology details and rerun instructions.
`;
  return md;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.render) {
    // Render-only: read all per-condition results from RESULTS_DIR.
    const datasetSha = {};
    if (existsSync(join(DATA_DIR, 'longmemeval_s.json'))) datasetSha.longmemeval = sha256File(join(DATA_DIR, 'longmemeval_s.json'));
    if (existsSync(join(DATA_DIR, 'locomo10.json'))) datasetSha.locomo = sha256File(join(DATA_DIR, 'locomo10.json'));
    const files = execSync(`ls ${RESULTS_DIR}/*.json`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    const all = files.map((f) => JSON.parse(readFileSync(f, 'utf8'))).map((r) => {
      // Strip per_question for rendering.
      const { per_question, ...rest } = r;
      return rest;
    });
    const md = renderMarkdown(all, datasetSha);
    const outPath = join(REPO_ROOT, 'BENCHMARK.md');
    writeFileSync(outPath, md);
    console.log(`[bench] wrote ${outPath}`);
    return;
  }

  const branches = args.all ? BRANCHES : (args.branch ? [args.branch] : null);
  const datasets = args.all ? DATASETS : (args.dataset ? [args.dataset] : null);
  if (!branches || !datasets) {
    console.error('Specify --all, or --branch <b> --dataset <d>, or --render');
    process.exit(1);
  }

  // Load datasets once (data loading is independent of branch).
  const data = {};
  for (const d of datasets) {
    console.log(`[bench] loading ${d}`);
    data[d] = loadDataset(d);
    console.log(`  total in slice: ${data[d].total}, sampled: ${data[d].sampled}, sha256: ${data[d].sha256.slice(0, 16)}…`);
  }

  for (const b of branches) {
    checkoutAndBuild(b);
    for (const d of datasets) {
      const variants = (b === 'v0.5-graph' || b === 'v0.5-integration') ? ['baseline', 'expand1'] : ['baseline'];
      for (const v of variants) {
        await runCondition(b, d, v, data[d]);
      }
    }
  }

  console.log('[bench] all conditions complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
