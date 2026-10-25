import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempProject } from './helpers.js';
import { searchPayload } from '../src/commands/search.js';
import { runRemember } from '../src/commands/remember.js';
import { CompositeStore } from '../src/lib/composite-store.js';
import { defaultConfigYaml, getProfile, loadConfig } from '../src/lib/config.js';
import { FtsIndex, queryTokenPresence, tokenizeLikeIndex } from '../src/lib/fts.js';
import { appendOutcome, readOutcomes } from '../src/lib/outcomes.js';
import { MemspecStore, type SearchRelevanceMeta } from '../src/lib/store.js';
import { readUsageEntries, recordSearchHits, usagePath } from '../src/lib/usage.js';
import { computeUsageStats } from '../src/lib/usage-stats.js';
import type { MemoryItem } from '../src/lib/types.js';

async function freshStore(): Promise<string> {
  const project = await makeTempProject();
  new MemspecStore(project).init();
  return project;
}

function remember(project: string, title: string, body: string, tags?: string): string {
  return runRemember('fact', title, { cwd: project, body, source: 'test', tags }).id;
}

function item(id: string, title: string, body: string): MemoryItem {
  return {
    id, kind: 'claim', type: 'fact', state: 'active', created: '2026-01-01T00:00:00.000Z',
    source: 'test', tags: [], check_by: 'never', title, body, filePath: `/nowhere/${id}.md`,
  } as MemoryItem;
}

// --- match tiers -----------------------------------------------------------

test('FTS tops up a short full-term page with partial matches, tier 2, after every full match', () => {
  const fts = new FtsIndex();
  try {
    fts.populate([
      item('both', 'Alpha beta notes', 'alpha and beta together'),
      item('alpha', 'Alpha only', 'alpha alpha alpha'),
      item('beta', 'Beta only', 'beta'),
      item('none', 'Unrelated', 'gamma'),
    ]);
    const hits = fts.search('alpha beta', { limit: 10 });
    assert.deepEqual(hits.map((h) => [h.id, h.tier]).slice(0, 1), [['both', 1]]);
    assert.deepEqual(new Set(hits.slice(1).map((h) => h.id)), new Set(['alpha', 'beta']));
    assert.ok(hits.slice(1).every((h) => h.tier === 2));

    // A full page needs no top-up.
    assert.deepEqual(fts.search('alpha beta', { limit: 1 }).map((h) => h.id), ['both']);
    // A single-term query has no partial tier.
    assert.ok(fts.search('alpha', { limit: 10 }).every((h) => h.tier === 1));
  } finally {
    fts.close();
  }
});

test('store ranking keeps every full-term match above a stronger-scoring partial match', async () => {
  const project = await freshStore();
  const full = remember(project, 'Deployment runbook', 'The runbook mentions zephyr once and quokka once, among many other words about deployment windows and rollback.');
  const partial = remember(project, 'Zephyr zephyr zephyr', 'zephyr zephyr zephyr zephyr');

  // Test the test: on raw BM25 the partial row beats the full one, so only the
  // tier can put the full match first.
  const fts = new FtsIndex();
  try {
    fts.populate(new MemspecStore(project).loadActive());
    const or = fts.search('zephyr', { limit: 10 });
    assert.equal(or[0].id, partial, 'precondition: partial match scores higher on BM25');
  } finally {
    fts.close();
  }

  const meta: SearchRelevanceMeta = { topBm25: null };
  const ranked = new MemspecStore(project).search('zephyr quokka', { limit: 10, ranking: { relevance: 0.4, recency: 0.3 } }, meta);
  assert.deepEqual(ranked.map((i) => i.id), [full, partial]);
  assert.equal(meta.tiers?.get(full), 1);
  assert.equal(meta.tiers?.get(partial), 2);
});

test('layer fusion ranks a full-term match from a lower layer above a partial match from a higher one', async () => {
  const personal = await freshStore();
  const team = await freshStore();
  const partial = remember(personal, 'Quokka habitat', 'quokka quokka');
  const full = remember(team, 'Quokka zephyr survey', 'quokka and zephyr counted together');
  writeFileSync(join(personal, '.memspec', 'config.yaml'), [
    'stores:',
    '  - name: personal',
    `    path: ${join(personal, '.memspec')}`,
    '    priority: 10',
    '    writable: true',
    '  - name: team',
    `    path: ${join(team, '.memspec')}`,
    '    priority: 0',
    '    writable: false',
    '',
  ].join('\n'));

  const meta: SearchRelevanceMeta = { topBm25: null };
  const ranked = CompositeStore.forCwd(personal).search('quokka zephyr', { limit: 10 }, meta);
  assert.deepEqual(ranked.map((i) => i.id), [full, partial]);
  assert.equal(meta.tiers?.get(full), 1);
  assert.equal(meta.tiers?.get(partial), 2);
});

// --- coverage on partial-only pages ----------------------------------------

test('coverage reads weak when no hit carries every term and the best carries under three quarters', async () => {
  const project = await freshStore();
  remember(project, 'Harbour crane schedule', 'The harbour crane runs on a fixed schedule.');
  // 4 content terms, best hit carries 2 (harbour, crane): the old half-terms
  // rule called this ok.
  const weak = searchPayload('harbour crane tariff ledger', { cwd: project, json: true });
  assert.equal(weak.coverage, 'weak');
  assert.match(weak.coverage_note, /only partial-term matches: best hit carries 2 of 4 query terms \(unmatched: tariff, ledger\)/);

  // 3 of 4 is enough for a partial page to stay ok.
  const ok = searchPayload('harbour crane schedule ledger', { cwd: project, json: true });
  assert.equal(ok.coverage, 'ok', ok.coverage_note);

  // A full-term match is ok however many terms the query has.
  const full = searchPayload('harbour crane schedule', { cwd: project, json: true });
  assert.equal(full.coverage, 'ok', full.coverage_note);
});

test('queryTokenPresence answers has(queryToken) exactly like tokenizeLikeIndex', () => {
  const words = ['remootio,', '"tariffs"', 'gate', 'running', 'the'];
  const texts = ['Remootio gateway (tariff) runs', 'the gate is RUNNING', '', 'tariffs; remootio'];
  const full = tokenizeLikeIndex([...words, ...texts]);
  const { queryTokens, present } = queryTokenPresence(words, texts);
  assert.deepEqual(queryTokens, full.slice(0, words.length));
  const all = new Set(queryTokens.flat());
  texts.forEach((_, i) => {
    const expected = new Set(full[words.length + i].filter((t) => all.has(t)));
    assert.deepEqual(present[i], expected);
  });
});

// --- parsed-record cache ---------------------------------------------------

test('record cache picks up added, edited (same size, restored mtime) and deleted files on the next load', async () => {
  const project = await freshStore();
  const store = new MemspecStore(project);
  const a = remember(project, 'Cache alpha', 'first body');
  assert.deepEqual(store.loadActive().map((i) => i.id), [a]);

  const b = remember(project, 'Cache beta', 'second body');
  assert.deepEqual(new Set(store.loadActive().map((i) => i.id)), new Set([a, b]));

  // Same-size edit with the mtime pinned to the same whole second before and
  // after (what a restore-mtime tool does): only ctime moves.
  const path = store.loadActive().find((i) => i.id === a)!.filePath;
  utimesSync(path, 1_700_000_000, 1_700_000_000);
  assert.match(store.loadActive().find((i) => i.id === a)!.body, /first body/);
  const pinned = statSync(path).mtimeMs;
  writeFileSync(path, readFileSync(path, 'utf8').replace('first body', 'FIRST BODY'));
  utimesSync(path, 1_700_000_000, 1_700_000_000);
  assert.equal(statSync(path).mtimeMs, pinned);
  assert.match(store.loadActive().find((i) => i.id === a)!.body, /FIRST BODY/);

  unlinkSync(path);
  assert.deepEqual(store.loadActive().map((i) => i.id), [b]);

  // A file that turns invalid warns on every load, cached or not.
  const bPath = store.loadActive()[0].filePath;
  writeFileSync(bPath, '---\nid: [unclosed\n---\n# broken\n');
  assert.equal(store.loadActive().length, 0);
  assert.equal(store.warnings.length, 1);
  store.loadActive();
  assert.equal(store.warnings.length, 1);
});

test('record cache hands out copies: mutating a loaded record does not leak into the next load', async () => {
  const project = await freshStore();
  const store = new MemspecStore(project);
  remember(project, 'Immutable view', 'body text', 'one,two');
  const [first] = store.loadAll();
  first.title = 'mutated';
  first.tags.push('three');
  (first as { ext?: Record<string, unknown> }).ext = { injected: true };
  const [second] = new MemspecStore(project).loadAll();
  assert.equal(second.title, 'Immutable view');
  assert.deepEqual(second.tags, ['one', 'two']);
  assert.equal(second.ext, undefined);
  const found = store.findById(second.id)!;
  found.tags.length = 0;
  assert.deepEqual(store.findById(second.id)!.tags, ['one', 'two']);
});

// --- usage stats -----------------------------------------------------------

/** The pre-cache full-file fold, kept here as the reference semantics. */
function referenceStats(root: string): Map<string, unknown> {
  const stats = new Map<string, { last_referenced?: string; sessions: number; useful: number; dead_end: number; corrected: number }>();
  const sessions = new Map<string, Set<string>>();
  for (const e of readUsageEntries(root)) {
    if (!e.id) continue;
    const s = stats.get(e.id) ?? { sessions: 0, useful: 0, dead_end: 0, corrected: 0 };
    const at = Date.parse(e.retrieved_at);
    if (!Number.isNaN(at) && (!s.last_referenced || at > Date.parse(s.last_referenced))) s.last_referenced = e.retrieved_at;
    stats.set(e.id, s);
    if (e.session) sessions.set(e.id, (sessions.get(e.id) ?? new Set()).add(e.session));
  }
  for (const [id, set] of sessions) stats.get(id)!.sessions = set.size;
  for (const o of readOutcomes(root)) {
    if (!o.id) continue;
    const s = stats.get(o.id) ?? { sessions: 0, useful: 0, dead_end: 0, corrected: 0 };
    if (o.outcome === 'useful') s.useful++;
    else if (o.outcome === 'dead_end') s.dead_end++;
    else if (o.outcome === 'corrected') s.corrected++;
    stats.set(o.id, s);
  }
  return stats;
}

test('usage stats fold appends incrementally and match the full-file fold, through rewrites and an unterminated line', async () => {
  const project = await freshStore();
  const root = new MemspecStore(project).root;
  assert.equal(computeUsageStats(root).size, 0);

  recordSearchHits(root, ['A', 'B'], { session: 's1' });
  assert.deepEqual(computeUsageStats(root), referenceStats(root));
  recordSearchHits(root, ['A'], { session: 's2' });
  appendOutcome(root, 'B', 'useful');
  const afterAppend = computeUsageStats(root);
  assert.equal(afterAppend.get('A')!.sessions, 2);
  assert.equal(afterAppend.get('B')!.useful, 1);
  assert.deepEqual(afterAppend, referenceStats(root));

  // Unterminated last line: counted now, and still counted once it is finished.
  appendFileSync(usagePath(root), JSON.stringify({ id: 'C', retrieved_at: '2026-01-02T00:00:00.000Z', session: 's3' }));
  assert.equal(computeUsageStats(root).get('C')!.sessions, 1);
  appendFileSync(usagePath(root), '\n' + JSON.stringify({ id: 'C', retrieved_at: '2026-01-03T00:00:00.000Z', session: 's4' }) + '\n');
  const finished = computeUsageStats(root);
  assert.equal(finished.get('C')!.sessions, 2);
  assert.equal(finished.get('C')!.last_referenced, '2026-01-03T00:00:00.000Z');
  assert.deepEqual(finished, referenceStats(root));

  // Rewritten in place (shorter, then longer with different bytes): refolded from scratch.
  writeFileSync(usagePath(root), JSON.stringify({ id: 'D', retrieved_at: '2026-01-04T00:00:00.000Z' }) + '\n');
  assert.deepEqual([...computeUsageStats(root).keys()].sort(), ['B', 'D']);
  const longer = ['E', 'F', 'G', 'H'].map((id) => JSON.stringify({ id, retrieved_at: '2026-01-05T00:00:00.000Z', session: 'x' })).join('\n') + '\n';
  writeFileSync(usagePath(root), longer);
  assert.deepEqual(computeUsageStats(root), referenceStats(root));
  assert.ok(!computeUsageStats(root).has('D'));

  // Returned entries are fresh objects.
  computeUsageStats(root).get('E')!.sessions = 99;
  assert.equal(computeUsageStats(root).get('E')!.sessions, 1);
});

// --- dead min_confidence ---------------------------------------------------

test('a config that still carries min_confidence loads and searches; new configs no longer write it', async () => {
  const project = await freshStore();
  writeFileSync(join(project, '.memspec', 'config.yaml'), [
    'profiles:',
    '  default:',
    '    types: [fact, decision, procedure]',
    '    min_confidence: 0.99',
    '    ranking:',
    '      relevance: 1',
    '      confidence: 0.5',
    '      recency: 0',
    '',
  ].join('\n'));
  const config = loadConfig(join(project, '.memspec'));
  assert.deepEqual(getProfile(config).types, ['fact', 'decision', 'procedure']);
  const id = remember(project, 'Legacy config record', 'still searchable');
  assert.deepEqual(searchPayload('legacy config', { cwd: project, json: true }).results.map((r) => r.id), [id]);
  assert.doesNotMatch(defaultConfigYaml(), /min_confidence/);
});
