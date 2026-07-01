#!/usr/bin/env node
// Dev eval harness for the memspec simulated-memory fixture.
// Runs the labeled query set against the fixture using the CURRENT build and
// reports per-pattern retrieval metrics — and, crucially, the FAILURES, so you
// can see where retrieval has headroom. Not a CI gate.
//
//   npm run build && node eval.mjs [<fixture-root>]

import { cpSync, mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.SIM_REPO_ROOT || resolve(here, '..', '..');
const FIXTURE = process.argv[2] || join(here, 'fixture');
const { queries } = JSON.parse(readFileSync(join(here, 'queries.json'), 'utf8'));

const { searchPayload } = await import(pathToFileURL(join(REPO_ROOT, 'dist/commands/search.js')).href);

// fresh copy without the derived index so this build rebuilds its own
const root = join(tmpdir(), `sim-eval-${randomBytes(6).toString('hex')}`);
mkdirSync(root, { recursive: true });
cpSync(join(FIXTURE, '.memspec'), join(root, '.memspec'), { recursive: true });
for (const f of readdirSync(join(root, '.memspec'))) if (f.startsWith('.fts.db')) rmSync(join(root, '.memspec', f), { force: true });

const rankOf = (ids, id) => { const i = ids.indexOf(id); return i < 0 ? 0 : i + 1; };

const rows = [];
for (const qq of queries) {
  const payload = searchPayload(qq.query, { cwd: root, limit: '10', json: true, ...qq.opts });
  const results = payload.results || [];
  const ids = results.map((r) => r.id);
  const tRanks = qq.targets.map((t) => rankOf(ids, t)).filter((r) => r > 0);
  const dRanks = (qq.distractors || []).map((d) => rankOf(ids, d)).filter((r) => r > 0);
  const bestT = tRanks.length ? Math.min(...tRanks) : 0;
  const bestD = dRanks.length ? Math.min(...dRanks) : Infinity;
  // was the best-ranked target only reachable via edge/archive expansion?
  const bestTarget = bestT > 0 ? results[bestT - 1] : null;
  const recoveredVia = bestTarget?.expanded_via ? bestTarget.expanded_via.edge_type : null;

  let score, pass;
  if (qq.metric === 'recall@5') { score = bestT > 0 && bestT <= 5 ? 1 : 0; pass = score === 1; }
  else if (qq.metric === 'top1-correct') { score = ids[0] && qq.targets.includes(ids[0]) ? 1 : 0; pass = score === 1; }
  else if (qq.metric === 'multi-recall@10') { score = tRanks.length / qq.targets.length; pass = score >= 0.99; }
  else { score = 0; pass = false; }

  const beatenByDistractor = bestD < bestT || (bestT === 0 && bestD < Infinity);
  rows.push({
    pattern: qq.pattern, metric: qq.metric, query: qq.query, score, pass,
    bestT, bestD: bestD === Infinity ? '-' : bestD, top1: results[0]?.title || '(none)',
    beatenByDistractor, recoveredVia, stale_in_top: results.slice(0, 5).filter((r) => r.stale).length,
    rationale: qq.rationale,
  });
}

// --- report -----------------------------------------------------------------
const byPattern = {};
for (const r of rows) (byPattern[r.pattern] ||= []).push(r);

console.log('\n=== memspec simulated-fixture retrieval eval (current build) ===\n');
console.log('Per-pattern score (1.0 = all queries in pattern pass):\n');
const patOrder = ['direct', 'edge-walk', 'temporal', 'archive-chain', 'multi-answer', 'conflict', 'precision', 'paraphrase-hard'];
for (const p of patOrder.filter((p) => byPattern[p])) {
  const rs = byPattern[p];
  const avg = rs.reduce((a, r) => a + r.score, 0) / rs.length;
  const npass = rs.filter((r) => r.pass).length;
  console.log(`  ${p.padEnd(16)} ${avg.toFixed(2)}   (${npass}/${rs.length} pass)   [${rs[0].metric}]`);
}

const fails = rows.filter((r) => !r.pass);
console.log(`\nHEADROOM — ${fails.length}/${rows.length} queries fail on current retrieval:\n`);
for (const r of fails) {
  const why = r.recoveredVia ? `target recovered via ${r.recoveredVia} expansion at #${r.bestT}, below the top-5 cut (BM25 alone misses it; expansion hits rank after every seed)`
    : r.beatenByDistractor ? `distractor ranked #${r.bestD} above target (target #${r.bestT || 'absent'})`
    : r.bestT === 0 ? 'target not in top-10' : `target only reached #${r.bestT}`;
  console.log(`  [${r.pattern}] "${r.query}"`);
  console.log(`      → ${why}; top-1 was "${r.top1}"`);
  console.log(`      expectation: ${r.rationale}`);
}

const stale = rows.filter((r) => r.stale_in_top > 0);
if (stale.length) {
  console.log(`\nDIAGNOSTIC (not scored) — stale records surfaced in top-5 on ${stale.length} queries.`);
  console.log('  `stale` is a flag, not a ranking signal; retrieval does not deprioritise stale claims. Candidate improvement.');
}

rmSync(root, { recursive: true, force: true });
