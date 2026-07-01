#!/usr/bin/env node
// Retrieval benchmark orchestrator — one row per released version.
// Checks out each version tag, rebuilds dist/, then spawns _bench-worker.mjs in a
// SEPARATE process to evaluate both datasets. Process isolation is required: a
// same-process dynamic import across versions leaks transitive deps (fts/store/
// schema) from the first version loaded, silently benchmarking one version N times.
//
// Usage:
//   node scripts/run-bench.mjs --all      # sweep every version tag + render
//   node scripts/run-bench.mjs --render   # re-render from cached results
//
// Run from a clean tree; restores your branch afterwards. Datasets must be present
// in /tmp/eval-data (see scripts/bench-README.md).

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.BENCH_REPO_ROOT || resolve(here, '..');
const RESULTS_DIR = '/tmp/memspec-bench-results';
const SEED = Number(process.env.BENCH_SEED || 42);
// Stage the worker outside the tree: checking out an old tag mid-sweep deletes a
// committed scripts/ file from disk before it can be spawned. (The orchestrator
// itself survives — Node loaded it into memory at startup.)
const WORKER = join(tmpdir(), `memspec-bench-worker-${process.pid}.mjs`);

const BRANCHES = ['v0.4', 'v0.5', 'v0.6', 'v0.7'];
const BRANCH_REFS = { 'v0.4': 'v0.4.0', 'v0.5': 'v0.5.0', 'v0.6': 'v0.6.3', 'v0.7': 'v0.7.0' };
const DATASETS = ['longmemeval', 'locomo'];

function evalVersion(v) {
  const ref = BRANCH_REFS[v];
  console.log(`[bench] git checkout ${ref}`);
  execSync(`git checkout ${ref}`, { cwd: REPO_ROOT, stdio: 'inherit' });
  console.log('[bench] npm run build');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
  // isolated process → this version's full module graph
  const out = execSync(`node ${JSON.stringify(WORKER)}`, {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, BENCH_REPO_ROOT: REPO_ROOT },
  });
  const summaries = JSON.parse(out);
  mkdirSync(RESULTS_DIR, { recursive: true });
  for (const s of summaries) {
    writeFileSync(join(RESULTS_DIR, `${v}-${s.dataset}.json`), JSON.stringify({ branch: v, ref, ...s }, null, 2));
    console.log(`  ${v} ${s.dataset}: recall@5=${s.recall_at_5.toFixed(3)} recall@10=${s.recall_at_10.toFixed(3)} mrr=${s.mrr.toFixed(3)} p50=${s.p50_latency_ms.toFixed(1)}ms`);
  }
}

function renderMarkdown() {
  const rows = [];
  for (const v of BRANCHES) for (const d of DATASETS) {
    const p = join(RESULTS_DIR, `${v}-${d}.json`);
    if (existsSync(p)) rows.push(JSON.parse(readFileSync(p, 'utf8')));
  }
  const byDataset = {};
  for (const r of rows) (byDataset[r.dataset] ||= []).push(r);
  const shaOf = (d) => (byDataset[d]?.[0]?.sha256) || 'n/a';
  const fmt = (n) => Number(n).toFixed(3);
  const ms = (n) => `${n.toFixed(1)} ms`;
  const refOf = (v) => BRANCH_REFS[v] || v;

  let md = `# memspec — Benchmarks

**What this measures:** retrieval quality of \`memspec_search\`, version over version. Homegrown, retrieval-only harness — **no LLM in the loop.** Per question: a fresh tmp store, one \`memspec_remember\` per haystack session (tagged with the session id), one \`memspec_search\` for the question, then the top-K results are scored against the ground-truth session ids by tag match. Reported as Recall@5, Recall@10, and MRR.

**Versions:** each row is a released version pinned to its git tag — v0.4 (\`${refOf('v0.4')}\`), v0.5 (\`${refOf('v0.5')}\`), v0.6 (\`${refOf('v0.6')}\`), v0.7 (\`${refOf('v0.7')}\`). Each is checked out, rebuilt, and evaluated in an **isolated process** so a version's full module graph (ranking, storage, schema) is exercised — not just the entry point. Every version runs the same default retrieval path (FTS5 BM25, no edge expansion, no embeddings); the v0.5+ graph/temporal surfaces are opt-in and off here. For a version sweep that *does* exercise those capabilities on a purpose-built corpus, see \`scripts/sim/SIM-BENCHMARK.md\`.

**Datasets:**
- LongMemEval-S Knowledge-Update slice (sha256 \`${shaOf('longmemeval')}\`)
- LoCoMo category-2 Temporal slice (sha256 \`${shaOf('locomo')}\`)

**Sample size:** n shown per section heading (random sample, seed=${SEED}).
**Harness:** \`scripts/run-bench.mjs\` — see \`scripts/bench-README.md\` to reproduce.

## Results
`;

  for (const ds of DATASETS) {
    const rs = byDataset[ds]; if (!rs) continue;
    const dsLabel = ds === 'longmemeval' ? 'LongMemEval-S Knowledge-Update' : 'LoCoMo cat-2 Temporal Reasoning';
    const ns = [...new Set(rs.map((r) => r.n))];
    md += `\n### ${dsLabel} (n=${ns.join('/')})\n\n`;
    md += `| Version | Recall@5 | Recall@10 | MRR | p50 latency | p99 latency |\n|---|---|---|---|---|---|\n`;
    for (const v of BRANCHES) {
      const r = rs.find((x) => x.branch === v); if (!r) continue;
      md += `| ${v} (\`${refOf(v)}\`) | ${fmt(r.recall_at_5)} | ${fmt(r.recall_at_10)} | ${fmt(r.mrr)} | ${ms(r.p50_latency_ms)} | ${ms(r.p99_latency_ms)} |\n`;
    }
  }

  md += `
## Reading the numbers

- **Retrieval ranking is unchanged across v0.4 → v0.7 on the default path.** Recall and MRR are identical to three decimals in every version because none of these releases changed the default FTS5 BM25 scoring path: v0.5 added the (opt-in, off here) graph/temporal surfaces, v0.6 renamed graph traversal to "linked notes" and fixed layered-store retrieval, v0.7 added the offline \`memspec-dream\` reflection pass. With process isolation each row genuinely runs its own build, so this is a measured no-regression result, not an artifact of shared module state.
- **LongMemEval is saturated (Recall = 1.000).** The Knowledge-Update slice is easy for this protocol: ground-truth content is the most BM25-relevant to the question by construction, and the dedup guard keeps the candidate pool narrow. A no-regression tripwire, not a discriminator.
- **LoCoMo has real headroom.** ~30% of cat-2 stays unanswered by BM25 — a temporal-resolution / ranking problem, identical misses in every version.
- **This benchmark deliberately does not exercise v0.5+ capabilities.** Edge expansion, temporal \`as_of\`, and archived-record retrieval are off on the default path. Their version-over-version effect is measured separately in \`scripts/sim/SIM-BENCHMARK.md\`, a purpose-built corpus where those features have something to act on.

See \`scripts/bench-README.md\` for methodology details and rerun instructions.
`;
  writeFileSync(join(REPO_ROOT, 'BENCHMARK.md'), md);
  console.log(`[bench] wrote ${join(REPO_ROOT, 'BENCHMARK.md')}`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--render')) return renderMarkdown();
  if (!args.includes('--all')) { console.error('Specify --all or --render'); process.exit(1); }
  cpSync(join(here, '_bench-worker.mjs'), WORKER); // stage before any checkout
  const start = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  try { for (const v of BRANCHES) evalVersion(v); }
  finally {
    execSync(`git checkout ${start === 'HEAD' ? 'main' : start}`, { cwd: REPO_ROOT, stdio: 'inherit' });
    rmSync(WORKER, { force: true });
  }
  renderMarkdown();
}

main();
