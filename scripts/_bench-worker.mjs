#!/usr/bin/env node
// Single-version worker for run-bench.mjs. Evaluates BOTH public datasets using
// whatever dist/ is currently built, and prints per-dataset summaries as JSON.
// Spawned once per version so each version loads its ENTIRE module graph fresh —
// a same-process dynamic import leaks transitive deps (fts/store/schema) from the
// first version loaded, silently running one version's ranking code every time.
//
//   node _bench-worker.mjs           # prints JSON [{dataset,...}, ...] on stdout

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.BENCH_REPO_ROOT || resolve(here, '..');
const DATA_DIR = '/tmp/eval-data';
const SAMPLE_SIZE = Number(process.env.BENCH_SAMPLE_SIZE || 20);
const SEED = Number(process.env.BENCH_SEED || 42);

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => { t = (t + 0x6D2B79F5) >>> 0; let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
function sample(arr, n, seed) {
  const rng = mulberry32(seed); const copy = arr.slice();
  for (let i = 0; i < Math.min(n, copy.length); i++) { const j = i + Math.floor(rng() * (copy.length - i)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy.slice(0, Math.min(n, copy.length));
}
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function loadLongMemEval() {
  const path = join(DATA_DIR, 'longmemeval_s.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const slice = raw.filter((q) => q.question_type === 'knowledge-update');
  const picks = sample(slice, SAMPLE_SIZE, SEED);
  return { sha256: sha256File(path), questions: picks.map((q) => ({
    question_id: q.question_id, question: q.question, ground_truth_session_ids: q.answer_session_ids,
    sessions: q.haystack_session_ids.map((sid, i) => ({ session_id: sid, body: q.haystack_sessions[i].map((t) => `[${t.role}] ${t.content}`).join('\n\n') })),
  })) };
}
function loadLoCoMo() {
  const path = join(DATA_DIR, 'locomo10.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const questions = [];
  for (const item of raw) {
    const conv = item.conversation;
    const sessions = Object.keys(conv).filter((k) => /^session_\d+$/.test(k)).map((k) => {
      const idx = Number(k.split('_')[1]); const turns = conv[k];
      if (!Array.isArray(turns)) return null;
      return { session_id: `D${idx}`, body: turns.map((t) => `[${t.speaker}] ${t.text}`).join('\n\n') };
    }).filter(Boolean);
    for (const qa of item.qa) {
      if (qa.category !== 2) continue;
      const gt = [...new Set((Array.isArray(qa.evidence) ? qa.evidence : []).map((e) => String(e).split(':')[0]))];
      if (gt.length === 0) continue;
      questions.push({ question_id: `${item.sample_id}_${questions.length}`, question: qa.question, ground_truth_session_ids: gt, sessions });
    }
  }
  return { sha256: sha256File(path), questions: sample(questions, SAMPLE_SIZE, SEED) };
}

const distRoot = join(REPO_ROOT, 'dist');
const [rm, sr, st] = await Promise.all([
  import(pathToFileURL(join(distRoot, 'commands/remember.js')).href),
  import(pathToFileURL(join(distRoot, 'commands/search.js')).href),
  import(pathToFileURL(join(distRoot, 'lib/store.js')).href),
]);
const api = { runRemember: rm.runRemember, searchPayload: sr.searchPayload, MemspecStore: st.MemspecStore };

function evalQuestion(question) {
  const storeRoot = join(tmpdir(), `eval-store-${randomBytes(8).toString('hex')}`);
  mkdirSync(storeRoot, { recursive: true });
  try {
    new api.MemspecStore(storeRoot).init();
    for (const s of question.sessions) {
      const titleSeed = s.body.replace(/\s+/g, ' ').trim().slice(0, 120) || s.session_id;
      try { api.runRemember('fact', titleSeed, { cwd: storeRoot, body: s.body, source: 'eval', tags: s.session_id, checkBy: 'never' }); } catch {}
    }
    const t0 = process.hrtime.bigint();
    const payload = api.searchPayload(question.question, { cwd: storeRoot, limit: '10', json: true });
    const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const results = payload.results || [];
    const gtSet = new Set(question.ground_truth_session_ids);
    const ranks = []; let first = 0;
    results.forEach((r, idx) => { if ((r.tags || []).some((t) => gtSet.has(t))) { ranks.push(idx + 1); if (first === 0) first = idx + 1; } });
    return { latency_ms: latencyMs, recall_at_5: ranks.some((r) => r <= 5) ? 1 : 0, recall_at_10: ranks.some((r) => r <= 10) ? 1 : 0, reciprocal_rank: first > 0 ? 1 / first : 0 };
  } finally { try { rmSync(storeRoot, { recursive: true, force: true }); } catch {} }
}

function run(datasetKey, ds) {
  const perQ = ds.questions.map(evalQuestion);
  const n = perQ.length; const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const lats = perQ.map((r) => r.latency_ms).sort((a, b) => a - b);
  const p = (q) => lats[Math.min(lats.length - 1, Math.floor(q * lats.length))];
  return { dataset: datasetKey, sha256: ds.sha256, n,
    recall_at_5: sum(perQ.map((r) => r.recall_at_5)) / n, recall_at_10: sum(perQ.map((r) => r.recall_at_10)) / n,
    mrr: sum(perQ.map((r) => r.reciprocal_rank)) / n, p50_latency_ms: p(0.5), p99_latency_ms: p(0.99) };
}

process.stdout.write(JSON.stringify([run('longmemeval', loadLongMemEval()), run('locomo', loadLoCoMo())]));
