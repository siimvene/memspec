#!/usr/bin/env node
// Version sweep over the simulated-memory fixture: runs each released version's
// SEARCH against the SAME committed corpus and renders a benchmark with one row
// per version. Local dev artifact — not shipped, not a CI gate.
//
// Because the fixture is built once and every version reads identical markdown
// off disk, differences across rows are pure search-capability differences
// (v0.5 unlocks edge-walk + temporal, v0.6 unlocks archive-chain, etc.).
//
//   node scripts/sim/bench.mjs          # checkout+build each tag, sweep, render
//   node scripts/sim/bench.mjs --render # re-render from cached results
//
// Restores your working branch at the end. Run from a clean tree.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.SIM_REPO_ROOT || resolve(here, '..', '..');
const FIXTURE = join(here, 'fixture');
const RESULTS_DIR = '/tmp/memspec-sim-bench';
const OUT_DOC = join(here, 'SIM-BENCHMARK.md');
const SEARCH_LIMIT = 15; // generous: lets edge/archive expansion hits (ranked after seeds) surface
// Staging area outside the tree: checking out an old tag mid-sweep deletes the
// committed worker/fixture/queries from disk before they can be used. Copy them
// to /tmp up front and drive the sweep from there. (bench.mjs itself survives —
// Node loaded it into memory at startup.)
const STAGE = join(tmpdir(), `memspec-sim-stage-${process.pid}`);
const STAGE_WORKER = join(STAGE, '_worker.mjs');
const STAGE_FIXTURE = join(STAGE, 'fixture');
const STAGE_QUERIES = join(STAGE, 'queries.json');

const VERSIONS = ['v0.4', 'v0.5', 'v0.6', 'v0.7'];
const REFS = { 'v0.4': 'v0.4.0', 'v0.5': 'v0.5.0', 'v0.6': 'v0.6.3', 'v0.7': 'v0.7.0' };
const PATTERNS = ['direct', 'edge-walk', 'temporal', 'archive-chain', 'multi-answer', 'conflict', 'precision', 'paraphrase-hard'];

const rankOf = (ids, id) => { const i = ids.indexOf(id); return i < 0 ? 0 : i + 1; };

function evalVersion(v) {
  execSync(`git checkout ${REFS[v]}`, { cwd: REPO_ROOT, stdio: 'inherit' });
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
  // Spawn a fresh process so this version's ENTIRE module graph is loaded — a
  // same-process dynamic import leaks transitive deps (fts/store/schema) from
  // whichever version loaded first, silently running one version four times.
  const out = execSync(`node ${JSON.stringify(STAGE_WORKER)} ${JSON.stringify(STAGE_FIXTURE)} ${JSON.stringify(STAGE_QUERIES)} ${SEARCH_LIMIT}`, {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, SIM_REPO_ROOT: REPO_ROOT },
  });
  const { rows } = JSON.parse(out);
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, `${v}.json`), JSON.stringify({ version: v, ref: REFS[v], rows }, null, 2));
  const byPat = PATTERNS.map((p) => { const rs = rows.filter((r) => r.pattern === p); return `${p}:${(rs.reduce((a, r) => a + r.score, 0) / rs.length).toFixed(2)}`; });
  console.log(`[sim-bench] ${v}: ${byPat.join(' ')}`);
}

function agg(rows, pattern) {
  const rs = rows.filter((r) => r.pattern === pattern);
  return rs.reduce((a, r) => a + r.score, 0) / rs.length;
}
function foundRate(rows, pattern) {
  const rs = rows.filter((r) => r.pattern === pattern);
  return rs.reduce((a, r) => a + (r.found ? 1 : 0), 0) / rs.length;
}

function render() {
  const versions = VERSIONS.filter((v) => existsSync(join(RESULTS_DIR, `${v}.json`)));
  const data = {};
  for (const v of versions) data[v] = JSON.parse(readFileSync(join(RESULTS_DIR, `${v}.json`), 'utf8')).rows;
  const fmt = (n) => n.toFixed(2);

  // "answer surfaced at all" (found within top-15) — the capability lens that
  // shows which version can reach the answer, independent of final rank.
  let md = `# memspec — simulated-memory benchmark (version per row)

Each row is a released version, pinned to its git tag, running its own \`memspec_search\`
against the **same committed simulated corpus** (\`scripts/sim/fixture/\`, ~190 records).
Identical data on disk; only search capability varies. Built from a non-circular
dataset: queries use user-language phrasing with a deliberate lexical gap from the
answer, and every probe carries a near-miss distractor, so keyword overlap is not
rewarded. See \`scripts/sim/README.md\`.

Two lenses are reported. **Reached** = the intended answer appears anywhere in the
top ${SEARCH_LIMIT} (does the version's retrieval path *get there at all*). **Served** =
it appears in the working set a caller actually reads (top-5 / rank-1 / cluster
completeness — the pattern's natural metric). The gap between them is ranking headroom.

## Reached — answer surfaced at all (top ${SEARCH_LIMIT})

| Version | ${PATTERNS.join(' | ')} |
|${'---|'.repeat(PATTERNS.length + 1)}
`;
  for (const v of versions) {
    md += `| ${v} (\`${REFS[v]}\`) | ${PATTERNS.map((p) => fmt(foundRate(data[v], p))).join(' | ')} |\n`;
  }

  md += `\n## Served — answer in the working set (pattern's natural metric)

| Version | ${PATTERNS.join(' | ')} |
|${'---|'.repeat(PATTERNS.length + 1)}
`;
  for (const v of versions) {
    md += `| ${v} (\`${REFS[v]}\`) | ${PATTERNS.map((p) => fmt(agg(data[v], p))).join(' | ')} |\n`;
  }

  md += `\nMetrics per pattern: direct / edge-walk / archive-chain / paraphrase-hard = recall@5; temporal / precision = top1-correct; multi-answer / conflict = multi-recall@10.

## What this shows

**Capabilities that unlock with version** (measured, not asserted — each row runs that version's own code in an isolated process):

- **v0.5 unlocks edge-walk** (Reached 0.00 → 1.00). \`expand_edges\` surfaces an answer reachable only through a \`depends_on\` edge — a record BM25 misses entirely (absent without expansion, present with it).
- **v0.6 unlocks archive-chain** (Reached 0.00 → 1.00). \`include_superseded\` lets search reach a superseded predecessor via the \`supersedes\` edge. v0.5's expansion excludes superseded targets, so it stays 0 until v0.6.
- **v0.5 unlocks temporal** (Served 0.33 → 1.00). \`as_of\` ranks the era valid at the query time to #1; without it all eras return and the right one wins only by luck (~1/3).

**Headroom no version addresses yet** (flat across every row — the improvement backlog):

- **Edge-walk & archive-chain "Served" stay 0.00.** Expansion *recovers* the record but appends it below every BM25 seed, so it lands outside a top-5 working set. Ranking/interleaving expansion hits is the highest-value fix.
- **Precision stays 0.00.** A near-miss lexical twin outranks the correct answer ("runs low on memory" pulls the OOM record over cache-eviction). Needs a signal beyond raw BM25.
- **Multi-answer stays 0.33.** Paraphrased cluster queries pull the wrong cluster when the right records share no rare terms with the query.

The gap between the two tables is ranking headroom: v0.5/v0.6 made the answers *reachable*; getting them into the working set is unfinished.
`;
  writeFileSync(OUT_DOC, md);
  console.log(`[sim-bench] wrote ${OUT_DOC}`);
  console.log('\n' + md);
}

function main() {
  if (process.argv[2] === '--render') return render();
  // Stage worker + fixture + queries to /tmp before any checkout can delete them.
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
  cpSync(join(here, '_worker.mjs'), STAGE_WORKER);
  cpSync(FIXTURE, STAGE_FIXTURE, { recursive: true });
  cpSync(join(here, 'queries.json'), STAGE_QUERIES);
  const startBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  try {
    for (const v of VERSIONS) evalVersion(v);
  } finally {
    execSync(`git checkout ${startBranch === 'HEAD' ? 'main' : startBranch}`, { cwd: REPO_ROOT, stdio: 'inherit' });
    rmSync(STAGE, { recursive: true, force: true });
  }
  render();
}

try { main(); } catch (e) { console.error(e); process.exit(1); }
