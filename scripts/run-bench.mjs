#!/usr/bin/env node
// Single-condition rerun of memspec's retrieval bench against the current
// build (v0.9.0 dist/). Same protocol as scripts/run-bench.mjs @ v0.6.3:
// per-question fresh tmp store, one memory per haystack session tagged with
// session id, search the question, score top-K via tag match. n=20 seed=42.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const DATA_DIR = '/tmp/eval-data';
const SAMPLE_SIZE = Number(process.env.BENCH_SAMPLE_SIZE || 20);
const SEED = 42;

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function sample(arr, n, seed) {
  const rng = mulberry32(seed);
  const copy = arr.slice();
  for (let i = 0; i < Math.min(n, copy.length); i++) {
    const j = i + Math.floor(rng() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function loadLongMemEval() {
  const path = join(DATA_DIR, 'longmemeval_s.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const slice = raw.filter((q) => q.question_type === 'knowledge-update');
  const picks = sample(slice, SAMPLE_SIZE, SEED);
  return {
    sha256: sha256File(path),
    total: slice.length,
    questions: picks.map((q) => ({
      question_id: q.question_id,
      question: q.question,
      ground_truth_session_ids: q.answer_session_ids,
      sessions: q.haystack_session_ids.map((sid, i) => ({
        session_id: sid,
        body: q.haystack_sessions[i].map((t) => `[${t.role}] ${t.content}`).join('\n\n'),
      })),
    })),
  };
}

function loadLoCoMo() {
  const path = join(DATA_DIR, 'locomo10.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const questions = [];
  for (const item of raw) {
    const conv = item.conversation;
    const sessionKeys = Object.keys(conv).filter((k) => /^session_\d+$/.test(k));
    const sessions = sessionKeys
      .map((k) => {
        const idx = Number(k.split('_')[1]);
        const turns = conv[k];
        if (!Array.isArray(turns)) return null;
        return { session_id: `D${idx}`, body: turns.map((t) => `[${t.speaker}] ${t.text}`).join('\n\n') };
      })
      .filter(Boolean);
    for (const qa of item.qa) {
      if (qa.category !== 2) continue;
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
  return { sha256: sha256File(path), total: questions.length, questions: picks };
}

async function loadApi() {
  const distRoot = join(REPO_ROOT, 'dist');
  const [rm, sr, st] = await Promise.all([
    import(pathToFileURL(join(distRoot, 'commands/remember.js')).href),
    import(pathToFileURL(join(distRoot, 'commands/search.js')).href),
    import(pathToFileURL(join(distRoot, 'lib/store.js')).href),
  ]);
  return { runRemember: rm.runRemember, searchPayload: sr.searchPayload, MemspecStore: st.MemspecStore };
}

async function evalQuestion(api, question) {
  const storeRoot = join(tmpdir(), `eval-store-${randomBytes(8).toString('hex')}`);
  mkdirSync(storeRoot, { recursive: true });
  try {
    const store = new api.MemspecStore(storeRoot);
    store.init();
    for (const s of question.sessions) {
      const titleSeed = s.body.replace(/\s+/g, ' ').trim().slice(0, 120) || s.session_id;
      try {
        api.runRemember('fact', titleSeed, {
          cwd: storeRoot,
          body: s.body,
          source: 'eval',
          tags: s.session_id,
          checkBy: 'never',
        });
      } catch {}
    }
    const t0 = process.hrtime.bigint();
    const payload = api.searchPayload(question.question, { cwd: storeRoot, limit: '10', json: true });
    const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;

    const gtSet = new Set(question.ground_truth_session_ids);
    const ranks = [];
    let firstHitRank = 0;
    (payload.results || []).forEach((r, idx) => {
      if ((r.tags || []).some((t) => gtSet.has(t))) {
        ranks.push(idx + 1);
        if (firstHitRank === 0) firstHitRank = idx + 1;
      }
    });
    return {
      question_id: question.question_id,
      latency_ms: latencyMs,
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

async function main() {
  const api = await loadApi();
  const out = {};
  for (const [key, loader] of [
    ['locomo', loadLoCoMo],
    ['longmemeval', loadLongMemEval],
  ]) {
    const ds = loader();
    console.log(`[bench] ${key}: ${ds.questions.length} sampled of ${ds.total} eligible (sha256 ${ds.sha256})`);
    const perQ = [];
    let i = 0;
    for (const q of ds.questions) {
      i++;
      perQ.push(await evalQuestion(api, q));
      if (i % 5 === 0) console.log(`  [${i}/${ds.questions.length}] recall@10=${perQ.filter((x) => x.recall_at_10).length}/${i}`);
    }
    const n = perQ.length;
    const sum = (xs) => xs.reduce((a, b) => a + b, 0);
    const lats = perQ.map((r) => r.latency_ms).sort((a, b) => a - b);
    const p = (q) => lats[Math.min(lats.length - 1, Math.floor(q * lats.length))];
    out[key] = {
      n,
      total_eligible: ds.total,
      sha256: ds.sha256,
      recall_at_5: sum(perQ.map((r) => r.recall_at_5)) / n,
      recall_at_10: sum(perQ.map((r) => r.recall_at_10)) / n,
      mrr: sum(perQ.map((r) => r.reciprocal_rank)) / n,
      p50_latency_ms: p(0.5),
      p99_latency_ms: p(0.99),
      misses: perQ.filter((r) => !r.recall_at_10).map((r) => r.question_id),
    };
    console.log(
      `[bench] ${key}: recall@5=${out[key].recall_at_5.toFixed(3)} recall@10=${out[key].recall_at_10.toFixed(3)} mrr=${out[key].mrr.toFixed(3)} p50=${out[key].p50_latency_ms.toFixed(1)}ms p99=${out[key].p99_latency_ms.toFixed(1)}ms`
    );
  }
  writeFileSync('/tmp/memspec-bench-v090.json', JSON.stringify(out, null, 2));
  console.log('[bench] wrote /tmp/memspec-bench-v090.json');
}

main();
