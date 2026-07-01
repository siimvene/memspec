#!/usr/bin/env node
// Single-version worker for the simulated-memory sweep. Runs the labeled query
// set against the committed fixture using whatever dist/ is currently built, and
// prints per-query results as JSON on stdout. Spawned once per version by
// bench.mjs so each version gets a clean module graph (a same-process dynamic
// import cannot swap a version's transitive dependencies — they stay cached).
//
//   node _worker.mjs <fixture-root> <queries.json> <search-limit>

import { cpSync, mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.SIM_REPO_ROOT || resolve(here, '..', '..');
const FIXTURE = process.argv[2] || join(here, 'fixture');
const QUERIES = process.argv[3] || join(here, 'queries.json');
const LIMIT = process.argv[4] || '15';

const { searchPayload } = await import(pathToFileURL(join(REPO_ROOT, 'dist/commands/search.js')).href);
const { queries } = JSON.parse(readFileSync(QUERIES, 'utf8'));

const root = join(tmpdir(), `sim-worker-${randomBytes(6).toString('hex')}`);
mkdirSync(root, { recursive: true });
cpSync(join(FIXTURE, '.memspec'), join(root, '.memspec'), { recursive: true });
for (const f of readdirSync(join(root, '.memspec'))) if (f.startsWith('.fts.db')) rmSync(join(root, '.memspec', f), { force: true });

const rankOf = (ids, id) => { const i = ids.indexOf(id); return i < 0 ? 0 : i + 1; };
const rows = [];
for (const q of queries) {
  let results = [];
  try { results = (searchPayload(q.query, { cwd: root, limit: LIMIT, json: true, ...q.opts }) || {}).results || []; }
  catch { results = []; }
  const ids = results.map((r) => r.id);
  const tRanks = q.targets.map((t) => rankOf(ids, t)).filter((r) => r > 0);
  const bestT = tRanks.length ? Math.min(...tRanks) : 0;
  let score;
  if (q.metric === 'top1-correct') score = ids[0] && q.targets.includes(ids[0]) ? 1 : 0;
  else if (q.metric === 'multi-recall@10') score = q.targets.filter((t) => { const r = rankOf(ids, t); return r > 0 && r <= 10; }).length / q.targets.length;
  else score = bestT > 0 && bestT <= 5 ? 1 : 0; // recall@5
  rows.push({ pattern: q.pattern, metric: q.metric, score, bestT, found: bestT > 0 });
}
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ rows }));
