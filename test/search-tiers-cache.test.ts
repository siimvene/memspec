import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

// --- review round: tier consistency ----------------------------------------

test('FTS keeps a prefix-only full match in tier 1, after the exact full matches and above every partial', () => {
  const fts = new FtsIndex();
  try {
    fts.populate([
      item('exact', 'Kube config', 'kube config'),
      // Carries every term only by prefix, and shares no exact token with the query.
      item('prefixed', 'Kubernetes configuration', 'kubernetes configuration notes'),
      item('half', 'Kube only', 'kube kube'),
    ]);
    const hits = fts.search('kube config', { limit: 10 });
    assert.deepEqual(hits.map((h) => [h.id, h.tier]), [['exact', 1], ['prefixed', 1], ['half', 2]]);
    assert.equal(hits.find((h) => h.id === 'prefixed')!.prefix, true);
    assert.ok(!hits.find((h) => h.id === 'exact')!.prefix);
  } finally {
    fts.close();
  }
});

test('store keeps exact full matches above prefix full matches, and both above partials', async () => {
  const project = await freshStore();
  // The exact match is a weak body-only mention; the prefix match is all title.
  const exact = remember(project, 'Cluster note', 'Among many other words about clusters, nodes and pods there is a config for kube mention near the end of this long body.');
  const prefixed = remember(project, 'Kubernetes configuration', 'Kubernetes configuration kubernetes configuration kubernetes.');
  const half = remember(project, 'Kube kube kube', 'kube kube kube kube');
  for (let i = 0; i < 8; i++) remember(project, `Unrelated filler ${i}`, 'nothing to see here');

  // Test the test: on raw BM25 the prefix match beats the exact one.
  const fts = new FtsIndex();
  try {
    fts.populate(new MemspecStore(project).loadActive());
    const score = new Map(fts.search('kube config', { limit: 20 }).map((h) => [h.id, h.bm25Score]));
    assert.ok(score.get(prefixed)! < score.get(exact)!, 'precondition: prefix match scores higher on BM25');
  } finally {
    fts.close();
  }

  const meta: SearchRelevanceMeta = { topBm25: null };
  const ranked = new MemspecStore(project).search('kube config', { limit: 10 }, meta);
  assert.deepEqual(ranked.map((i) => i.id), [exact, prefixed, half]);
  assert.deepEqual([meta.tiers?.get(exact), meta.tiers?.get(prefixed), meta.tiers?.get(half)], [1, 1, 2]);
});

test('topBm25 is taken from the full-term matches when there are any, never from a partial top-up row', async () => {
  const project = await freshStore();
  remember(project, 'Deployment runbook', 'The runbook mentions zephyr once and quokka once, among many other words about deployment windows and rollback.');
  remember(project, 'Zephyr zephyr zephyr', 'zephyr zephyr zephyr zephyr');
  // Enough other records that BM25's IDF is not the degenerate near-zero.
  for (let i = 0; i < 8; i++) remember(project, `Unrelated filler ${i}`, 'nothing to see here');

  const fts = new FtsIndex();
  let tier1Best = Infinity;
  let tier2Best = Infinity;
  try {
    fts.populate(new MemspecStore(project).loadActive());
    for (const hit of fts.search('zephyr quokka', { limit: 20 })) {
      if (hit.tier === 1) tier1Best = Math.min(tier1Best, hit.bm25Score);
      else tier2Best = Math.min(tier2Best, hit.bm25Score);
    }
  } finally {
    fts.close();
  }
  // Test the test: the partial row scores better on raw BM25.
  assert.ok(tier2Best < tier1Best, `precondition: tier 2 ${tier2Best} < tier 1 ${tier1Best}`);

  const meta: SearchRelevanceMeta = { topBm25: null };
  new MemspecStore(project).search('zephyr quokka', { limit: 10 }, meta);
  assert.equal(meta.topBm25, tier1Best);

  // A page of partials only still reports its strongest partial.
  const partialMeta: SearchRelevanceMeta = { topBm25: null };
  new MemspecStore(project).search('zephyr ocelot', { limit: 10 }, partialMeta);
  assert.notEqual(partialMeta.topBm25, null);
});

test('coverage judges the partial-term rule on the best-covered hit, not on any full match elsewhere on the page', async () => {
  const project = await freshStore();
  // Full match only by prefix, one exact query token, title only.
  remember(project, 'Kubernetes configuration tariff', 'See doc.');
  // Partial match carrying two exact tokens in its body, missing the third.
  remember(project, 'Cluster notes', 'kube config notes for the cluster');
  remember(project, 'Unrelated filler one', 'nothing to see');
  remember(project, 'Unrelated filler two', 'still nothing');
  const payload = searchPayload('kube config tariff', { cwd: project, json: true });
  assert.equal(payload.count, 2);
  assert.equal(payload.coverage, 'weak', payload.coverage_note);
  assert.match(payload.coverage_note, /only partial-term matches: best hit carries 2 of 3 query terms \(unmatched: tariff\)/);
});

function layered(personal: string, team: string): void {
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
}

test('layer fusion ranks partial matches by their rank within the partial tier, not behind the layer\'s own full matches', async () => {
  const personal = await freshStore();
  const team = await freshStore();
  remember(personal, 'Quokka zephyr survey', 'quokka and zephyr counted together');
  remember(personal, 'Zephyr quokka census', 'zephyr with quokka again');
  const personalPartial = remember(personal, 'Quokka habitat', 'quokka quokka');
  remember(team, 'Quokka diet', 'quokka eats leaves');
  remember(team, 'Zephyr winds', 'zephyr blows');
  layered(personal, team);

  const meta: SearchRelevanceMeta = { topBm25: null };
  const ranked = CompositeStore.forCwd(personal).search('quokka zephyr', { limit: 10 }, meta);
  assert.equal(ranked.length, 5);
  assert.deepEqual(ranked.map((i) => meta.tiers?.get(i.id)), [1, 1, 2, 2, 2]);
  // Rank 1 of the personal layer's partials ties rank 1 of the team's on RRF; layer priority breaks it.
  assert.equal(ranked[2].id, personalPartial);
});

test('layer fusion takes a duplicated id\'s tier from the copy it serves, not from a stale copy in a lower layer', async () => {
  const personal = await freshStore();
  const team = await freshStore();
  const census = remember(team, 'Zephyr quokka census', 'zephyr with quokka counted');
  const dup = remember(team, 'Quokka zephyr notes', 'quokka and zephyr together');
  // The personal layer holds a newer copy of `dup` that no longer mentions zephyr.
  const teamPath = new MemspecStore(team).loadActive().find((i) => i.id === dup)!.filePath;
  const personalPath = join(new MemspecStore(personal).root, teamPath.slice(new MemspecStore(team).root.length));
  mkdirSync(dirname(personalPath), { recursive: true });
  writeFileSync(personalPath, readFileSync(teamPath, 'utf8').replace('Quokka zephyr notes', 'Quokka notes').replace('quokka and zephyr together', 'quokka alone now'));
  layered(personal, team);

  const meta: SearchRelevanceMeta = { topBm25: null };
  const ranked = CompositeStore.forCwd(personal).search('quokka zephyr', { limit: 10 }, meta);
  assert.deepEqual(ranked.map((i) => i.id), [census, dup]);
  assert.equal(ranked[1].title, 'Quokka notes');
  assert.equal(meta.tiers?.get(dup), 2);
  assert.equal(meta.tiers?.get(census), 1);
});

// --- review round: usage cursor --------------------------------------------

test('usage stats refold a same-size in-place rewrite that keeps the inode and the probed tail', async () => {
  const project = await freshStore();
  const root = new MemspecStore(project).root;
  const path = usagePath(root);
  const row = (id: string, session: string) => JSON.stringify({ id, retrieved_at: '2026-01-01T00:00:00.000Z', session });
  writeFileSync(path, [row('A', 's1'), row('B', 's2'), row('C', 's3')].join('\n') + '\n');
  assert.deepEqual([...computeUsageStats(root).keys()].sort(), ['A', 'B', 'C']);
  const before = statSync(path);

  // First row rewritten to another of the same length; the last 64 bytes are untouched.
  const rewritten = readFileSync(path, 'utf8').replace(row('A', 's1'), row('Z', 's1'));
  writeFileSync(path, rewritten);
  const after = statSync(path);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.deepEqual([...computeUsageStats(root).keys()].sort(), ['B', 'C', 'Z']);
  assert.deepEqual(computeUsageStats(root), referenceStats(root));
});
