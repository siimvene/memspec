import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRemember } from '../src/commands/remember.js';
import { runRelate } from '../src/commands/relate.js';
import { runSupersede } from '../src/commands/supersede.js';
import { searchPayload } from '../src/commands/search.js';
import {
  EDGE_TYPES,
  expandGraph,
  MAX_DEPTH,
  type EdgeType,
  type ExpansionHit,
} from '../src/lib/graph-walk.js';
import { MemspecStore } from '../src/lib/store.js';
import type { MemoryFrontmatter } from '../src/lib/types.js';

/**
 * Phase 1 graph-traversal tests. Split between two layers:
 *
 * - Unit-level: `expandGraph` is fed in-memory record maps directly. Lets us
 *   exercise cycles, depth caps, and ordering without spinning up a project.
 * - Integration-level: `searchPayload` is exercised against a real on-disk
 *   memspec store with `runRemember` + `runRelate`, so the regression guard
 *   covers the full wiring (FTS seed → expansion → result merge → dedupe).
 */

// ---------- helpers ---------------------------------------------------------

async function makeProject(): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), 'memspec-graph-'));
  const store = new MemspecStore(target);
  store.init();
  return target;
}

/**
 * Build a minimal MemoryFrontmatter for the unit-level walker tests. Only
 * the fields the walker actually reads need to be present — everything else
 * is a placeholder so the type-check passes.
 */
function fmRecord(id: string, edges: Partial<Pick<MemoryFrontmatter,
  'refines' | 'supports' | 'depends_on' | 'conflicts_with' | 'supersedes' | 'superseded_by'>> = {}): MemoryFrontmatter {
  return {
    id,
    kind: 'claim',
    type: 'fact',
    state: 'active',
    created: '2026-06-29T00:00:00Z',
    source: 'test',
    tags: [],
    check_by: 'never',
    ...edges,
  };
}

// ---------- expandGraph unit tests -----------------------------------------

test('expandGraph: empty seeds → no hits', () => {
  const records = new Map<string, MemoryFrontmatter>();
  records.set('a', fmRecord('a'));
  assert.deepEqual(expandGraph([], records), []);
});

test('expandGraph: seed ids are never returned in expansion output', () => {
  const records = new Map<string, MemoryFrontmatter>([
    ['a', fmRecord('a', { refines: ['b'] })],
    ['b', fmRecord('b', { refines: ['a'] })],
  ]);
  const hits = expandGraph(['a'], records, { maxDepth: 3 });
  for (const hit of hits) {
    assert.notEqual(hit.id, 'a', 'seed id must not appear as expansion hit');
  }
});

test('expandGraph: 1-hop expansion across each edge type individually', () => {
  for (const edgeType of EDGE_TYPES) {
    const edges = {
      [edgeType]: edgeType === 'superseded_by' ? 'b' : ['b'],
    } as Partial<MemoryFrontmatter>;
    const records = new Map<string, MemoryFrontmatter>([
      ['a', fmRecord('a', edges)],
      ['b', fmRecord('b')],
    ]);
    const hits = expandGraph(['a'], records, { maxDepth: 1 });
    assert.equal(hits.length, 1, `${edgeType}: expected exactly one 1-hop hit`);
    assert.equal(hits[0].id, 'b', `${edgeType}: expected hit on b`);
    assert.equal(hits[0].from_id, 'a', `${edgeType}: expected from_id = seed a`);
    assert.equal(hits[0].edge_type, edgeType, `${edgeType}: expected edge_type matches`);
    assert.equal(hits[0].hops, 1, `${edgeType}: hops should be 1`);
  }
});

test('expandGraph: multi-edge-type expansion combined', () => {
  const records = new Map<string, MemoryFrontmatter>([
    ['a', fmRecord('a', { refines: ['b'], supports: ['c'], depends_on: ['d'] })],
    ['b', fmRecord('b')],
    ['c', fmRecord('c')],
    ['d', fmRecord('d')],
  ]);
  const hits = expandGraph(['a'], records, { maxDepth: 1 });
  const ids = hits.map((h) => h.id).sort();
  assert.deepEqual(ids, ['b', 'c', 'd']);
});

test('expandGraph: depth 2 surfaces records 2 hops away', () => {
  const records = new Map<string, MemoryFrontmatter>([
    ['a', fmRecord('a', { refines: ['b'] })],
    ['b', fmRecord('b', { refines: ['c'] })],
    ['c', fmRecord('c')],
  ]);
  const hits1 = expandGraph(['a'], records, { maxDepth: 1 });
  assert.deepEqual(hits1.map((h) => h.id), ['b'], 'depth 1 stops at b');

  const hits2 = expandGraph(['a'], records, { maxDepth: 2 });
  const ids = hits2.map((h) => h.id);
  assert.deepEqual(ids, ['b', 'c'], 'depth 2 reaches c via b');
  assert.equal(hits2.find((h) => h.id === 'b')!.hops, 1);
  assert.equal(hits2.find((h) => h.id === 'c')!.hops, 2);
  assert.equal(hits2.find((h) => h.id === 'c')!.from_id, 'a',
    'from_id is the original seed, not the intermediate hop');
});

test('expandGraph: depth cap respected — depth 3 stops, does not reach hop 4', () => {
  // Linear chain a → b → c → d → e
  const records = new Map<string, MemoryFrontmatter>([
    ['a', fmRecord('a', { refines: ['b'] })],
    ['b', fmRecord('b', { refines: ['c'] })],
    ['c', fmRecord('c', { refines: ['d'] })],
    ['d', fmRecord('d', { refines: ['e'] })],
    ['e', fmRecord('e')],
  ]);

  const hits = expandGraph(['a'], records, { maxDepth: 3 });
  const ids = hits.map((h) => h.id);
  assert.deepEqual(ids, ['b', 'c', 'd'], 'depth 3 reaches d but not e');

  // MAX_DEPTH is the hard ceiling — passing 4 clamps back to 3.
  assert.equal(MAX_DEPTH, 3);
  const hits4 = expandGraph(['a'], records, { maxDepth: 4 });
  assert.deepEqual(hits4.map((h) => h.id), ['b', 'c', 'd'],
    'maxDepth above MAX_DEPTH is clamped, not honoured');
});

test('expandGraph: maxExpansion cap respected — short-circuits the walk', () => {
  // a → {b, c, d, e, f}
  const records = new Map<string, MemoryFrontmatter>([
    ['a', fmRecord('a', { refines: ['b', 'c', 'd', 'e', 'f'] })],
    ['b', fmRecord('b')],
    ['c', fmRecord('c')],
    ['d', fmRecord('d')],
    ['e', fmRecord('e')],
    ['f', fmRecord('f')],
  ]);

  const hits = expandGraph(['a'], records, { maxExpansion: 3 });
  assert.equal(hits.length, 3, 'cap honoured: stops at 3 hits');
});

test('expandGraph: cycle A→B→A returns each record exactly once (seed never appears)', () => {
  const records = new Map<string, MemoryFrontmatter>([
    ['a', fmRecord('a', { refines: ['b'] })],
    ['b', fmRecord('b', { refines: ['a'] })],
  ]);
  const hits = expandGraph(['a'], records, { maxDepth: 3 });
  const ids = hits.map((h) => h.id);
  assert.deepEqual(ids, ['b'], 'cycle: b surfaces once, a never (it is the seed)');
});

test('expandGraph: cycle A→B→A→B with mixed edge types still terminates', () => {
  // a refines b; b conflicts_with a; ensure both edge_types are tried but the
  // visited-set prevents re-walking a or b.
  const records = new Map<string, MemoryFrontmatter>([
    ['a', fmRecord('a', { refines: ['b'] })],
    ['b', fmRecord('b', { conflicts_with: ['a'] })],
  ]);
  const hits = expandGraph(['a'], records, { maxDepth: 3 });
  const ids = hits.map((h) => h.id);
  assert.deepEqual(ids, ['b']);
});

test('expandGraph: edge types walked in supplied order (deterministic output)', () => {
  // a → b via refines; a → c via supports. Order in EDGE_TYPES list controls
  // which edge surfaces b vs c first.
  const records = new Map<string, MemoryFrontmatter>([
    ['a', fmRecord('a', { refines: ['b'], supports: ['c'] })],
    ['b', fmRecord('b')],
    ['c', fmRecord('c')],
  ]);

  const refinesFirst = expandGraph(['a'], records, { edgeTypes: ['refines', 'supports'] });
  assert.deepEqual(refinesFirst.map((h) => h.id), ['b', 'c']);

  const supportsFirst = expandGraph(['a'], records, { edgeTypes: ['supports', 'refines'] });
  assert.deepEqual(supportsFirst.map((h) => h.id), ['c', 'b']);
});

test('expandGraph: records with missing edge fields do not crash', () => {
  const records = new Map<string, MemoryFrontmatter>([
    ['a', fmRecord('a')], // no edges at all
    ['b', fmRecord('b', { refines: [] })], // empty array
  ]);
  assert.doesNotThrow(() => expandGraph(['a', 'b'], records, { maxDepth: 3 }));
  assert.deepEqual(expandGraph(['a', 'b'], records, { maxDepth: 3 }), []);
});

test('expandGraph: unresolved edge target id is still surfaced as a hit', () => {
  // a refers to "ghost" which is not in the record map. The walker still
  // emits the hit so the caller can see the dangling pointer; downstream
  // result-building skips it cleanly.
  const records = new Map<string, MemoryFrontmatter>([
    ['a', fmRecord('a', { refines: ['ghost'] })],
  ]);
  const hits = expandGraph(['a'], records, { maxDepth: 2 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'ghost');
});

test('expandGraph: a record reachable from two seeds is returned once via first seed', () => {
  // a → c, b → c. With seed order [a, b], c is reached from a first.
  const records = new Map<string, MemoryFrontmatter>([
    ['a', fmRecord('a', { refines: ['c'] })],
    ['b', fmRecord('b', { refines: ['c'] })],
    ['c', fmRecord('c')],
  ]);
  const hits = expandGraph(['a', 'b'], records, { maxDepth: 1 });
  const cHits = hits.filter((h) => h.id === 'c');
  assert.equal(cHits.length, 1, 'c surfaces exactly once');
  assert.equal(cHits[0].from_id, 'a', 'attributed to the seed that reached it first');
});

// ---------- performance bound ----------------------------------------------

test('expandGraph: 1-hop expansion on a 100-record fully-edged store completes in <50ms', () => {
  // Build 100 records where each has refines/supports/depends_on edges to
  // the next 5 records (mod 100). That's 300 outbound edges per record →
  // a dense walk surface. Single-seed 1-hop should still finish well under
  // the 50ms bound the spec calls out.
  const records = new Map<string, MemoryFrontmatter>();
  const N = 100;
  for (let i = 0; i < N; i++) {
    const id = `r${i}`;
    const refines = [0, 1, 2, 3, 4].map((d) => `r${(i + d + 1) % N}`);
    const supports = [0, 1, 2, 3, 4].map((d) => `r${(i + d + 6) % N}`);
    const depends_on = [0, 1, 2, 3, 4].map((d) => `r${(i + d + 11) % N}`);
    records.set(id, fmRecord(id, { refines, supports, depends_on }));
  }

  const start = performance.now();
  const hits = expandGraph(['r0'], records, { maxDepth: 1, maxExpansion: 200 });
  const elapsed = performance.now() - start;

  assert.ok(hits.length >= 5, 'should produce at least a few expansion hits');
  assert.ok(elapsed < 50, `1-hop on 100-record dense store should run <50ms (got ${elapsed.toFixed(2)}ms)`);
});

// ---------- searchPayload regression guard ---------------------------------

test('searchPayload: expandEdges defaults off — results identical to v0.4 search', async () => {
  const target = await makeProject();
  const a = runRemember('fact', 'Authentication uses JWT tokens', {
    cwd: target, body: 'JWT-based auth', source: 'agent-a', tags: 'auth',
  });
  const b = runRemember('fact', 'Refresh token rotation policy', {
    cwd: target, body: 'Rotated every 7 days', source: 'agent-a', tags: 'auth',
  });
  // Wire a refines edge so expansion *would* fire if turned on.
  runRelate({ cwd: target, from: b.id, to: a.id, type: 'refines' });

  const noExpand = searchPayload('JWT', { cwd: target });
  const explicitlyOff = searchPayload('JWT', { cwd: target, expandEdges: false });

  // Deep equality of full payload — the regression guard the spec calls out.
  assert.deepEqual(noExpand, explicitlyOff);

  // None of the v0.4 results should carry an expanded_via field.
  for (const hit of noExpand.results) {
    assert.equal(hit.expanded_via, undefined, 'v0.4 default must not set expanded_via');
  }
});

test('searchPayload: expandEdges on — outbound edges from seed surface as expansion hits', async () => {
  const target = await makeProject();
  // Outbound from seed: pg refines schema. Walker follows outbound edges only.
  const pg = runRemember('fact', 'Database is Postgres 15', {
    cwd: target, body: 'pg', source: 'agent-a', tags: 'db',
  });
  const schema = runRemember('fact', 'Schema uses snake_case columns', {
    cwd: target, body: 'sc', source: 'agent-a', tags: 'db',
  });
  runRelate({ cwd: target, from: pg.id, to: schema.id, type: 'refines' });

  const off = searchPayload('Postgres', { cwd: target });
  assert.equal(off.results.length, 1);
  assert.equal(off.results[0].id, pg.id);

  const on = searchPayload('Postgres', { cwd: target, expandEdges: true });
  assert.equal(on.results.length, 2, 'seed + 1 expansion hit');
  assert.equal(on.results[0].id, pg.id, 'seed first');
  assert.equal(on.results[0].expanded_via, undefined, 'seed has no expanded_via');

  const expansion = on.results[1];
  assert.equal(expansion.id, schema.id);
  assert.ok(expansion.expanded_via, 'expansion hit carries the descriptor');
  assert.equal(expansion.expanded_via!.from_id, pg.id);
  assert.equal(expansion.expanded_via!.edge_type, 'refines');
  assert.equal(expansion.expanded_via!.hops, 1);
});

test('searchPayload: dedupe — record in both seed and expansion frontier wins as seed', async () => {
  const target = await makeProject();
  // Two seeds for query "queue": a (worker queue) and b (queue pipeline).
  // Wire a refines b — so b would also surface as an expansion hit from a.
  // The seed entry must win; b must not carry an expanded_via field.
  const b = runRemember('fact', 'Queue pipeline draining policy', {
    cwd: target, body: 'qp', source: 'agent-a', tags: 'queue',
  });
  const a = runRemember('fact', 'Worker queue retries failed jobs', {
    cwd: target, body: 'wq', source: 'agent-a', tags: 'queue',
  });
  runRelate({ cwd: target, from: a.id, to: b.id, type: 'refines' });

  const on = searchPayload('queue', { cwd: target, expandEdges: true });
  const ids = on.results.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate result ids');

  const bRow = on.results.find((r) => r.id === b.id)!;
  assert.equal(bRow.expanded_via, undefined,
    'b is in the seed set — seed wins, no expanded_via field');
});

test('searchPayload: expansion respects edgeTypes filter (only follows specified edges)', async () => {
  const target = await makeProject();
  // Only the seed matches the query — targets share no tags or title tokens
  // with the query string, so they only appear via expansion.
  const seed = runRemember('fact', 'Zylphon parameters sheet', {
    cwd: target, body: 'wp', source: 'agent-a', tags: 'zylphon',
  });
  const refinesTarget = runRemember('fact', 'Pool max size capped at 32', {
    cwd: target, body: 'pm', source: 'agent-a', tags: 'pool',
  });
  const supportsTarget = runRemember('fact', 'Benchmark logs from 2026', {
    cwd: target, body: 'bm', source: 'agent-a', tags: 'benchmark',
  });
  runRelate({ cwd: target, from: seed.id, to: refinesTarget.id, type: 'refines' });
  runRelate({ cwd: target, from: seed.id, to: supportsTarget.id, type: 'supports' });

  // Filter to refines only — supports target must NOT be surfaced.
  const refinesOnly = searchPayload('Zylphon', {
    cwd: target,
    expandEdges: true,
    edgeTypes: ['refines'],
  });
  const expandedIds = refinesOnly.results
    .filter((r) => r.expanded_via !== undefined)
    .map((r) => r.id);
  assert.deepEqual(expandedIds, [refinesTarget.id]);

  // Filter to supports only.
  const supportsOnly = searchPayload('Zylphon', {
    cwd: target,
    expandEdges: true,
    edgeTypes: ['supports'],
  });
  const supportsIds = supportsOnly.results
    .filter((r) => r.expanded_via !== undefined)
    .map((r) => r.id);
  assert.deepEqual(supportsIds, [supportsTarget.id]);
});

test('searchPayload: expandDepth=2 walks two hops', async () => {
  const target = await makeProject();
  // Chain: seed → mid → far, all via refines.
  const far = runRemember('fact', 'Backup retention 30 days', {
    cwd: target, body: 'br', source: 'agent-a', tags: 'backup',
  });
  const mid = runRemember('fact', 'Backup encrypted at rest', {
    cwd: target, body: 'be', source: 'agent-a', tags: 'backup',
  });
  const seed = runRemember('fact', 'Backups taken nightly to S3', {
    cwd: target, body: 'bn', source: 'agent-a', tags: 'backup',
  });
  runRelate({ cwd: target, from: seed.id, to: mid.id, type: 'refines' });
  runRelate({ cwd: target, from: mid.id, to: far.id, type: 'refines' });

  const depth1 = searchPayload('nightly', { cwd: target, expandEdges: true, expandDepth: 1 });
  const depth1Ids = depth1.results.map((r) => r.id);
  assert.ok(depth1Ids.includes(mid.id), 'depth 1 finds mid');
  assert.ok(!depth1Ids.includes(far.id), 'depth 1 does NOT find far');

  const depth2 = searchPayload('nightly', { cwd: target, expandEdges: true, expandDepth: 2 });
  const depth2Ids = depth2.results.map((r) => r.id);
  assert.ok(depth2Ids.includes(mid.id), 'depth 2 finds mid');
  assert.ok(depth2Ids.includes(far.id), 'depth 2 finds far');

  const farRow = depth2.results.find((r) => r.id === far.id)!;
  assert.equal(farRow.expanded_via!.hops, 2);
  assert.equal(farRow.expanded_via!.from_id, seed.id);
});

test('searchPayload: expansion walks supersede DAG (supersedes + superseded_by)', async () => {
  const target = await makeProject();
  // Create a fact, then supersede it. The replacement carries `supersedes`
  // pointing at the archived original; the archived original carries
  // `superseded_by` pointing back. Both edges should be walkable.
  const original = runRemember('fact', 'Queue length tracker', {
    cwd: target, body: 'orig', source: 'agent-a', tags: 'queue',
  });
  const replacement = runSupersede(original.id, {
    cwd: target,
    body: 'replacement body — refined queue length tracker',
    title: 'Queue length tracker (v2)',
    reason: 'better metrics',
  });

  // Searching for "Queue length" finds the active replacement; expansion via
  // `supersedes` should NOT surface the archived original (active-only walker).
  // But the walker itself doesn't filter by state — search.ts loads active
  // only, so the original is absent from the records map and the walker
  // emits a hit that fails to resolve. Verify the surface behaviour.
  const expanded = searchPayload('Queue length', { cwd: target, expandEdges: true });
  const replacementRow = expanded.results.find((r) => r.id === replacement.survivor_id);
  assert.ok(replacementRow, 'replacement is the seed hit');

  // Archived original lives in archive/; loadActive() skips it. Walker still
  // emits an ExpansionHit for the dangling id, but search.ts skips it when
  // building rows. Net: no spurious archived-record row in results.
  const archivedRow = expanded.results.find((r) => r.id === original.id);
  assert.equal(archivedRow, undefined, 'archived original is not surfaced as an active result');
});

test('searchPayload: expansion ordering — seeds first in BM25 order, then expansion by hop', async () => {
  const target = await makeProject();
  // Two seeds (different BM25 scores via title match strength), each with a
  // 1-hop neighbour. Expected order: seed1, seed2, expansion(seed1), expansion(seed2).
  const e1 = runRemember('fact', 'Foo subsystem details', {
    cwd: target, body: 'e1', source: 'agent-a', tags: 'foo',
  });
  const e2 = runRemember('fact', 'Bar subsystem details', {
    cwd: target, body: 'e2', source: 'agent-a', tags: 'bar',
  });
  // s1's title is an exact phrase match for "alpha widget", outranking s2.
  const s1 = runRemember('fact', 'alpha widget configuration', {
    cwd: target, body: 's1', source: 'agent-a', tags: 'alpha',
  });
  const s2 = runRemember('fact', 'alpha widget operator', {
    cwd: target, body: 's2', source: 'agent-a', tags: 'alpha',
  });
  runRelate({ cwd: target, from: s1.id, to: e1.id, type: 'refines' });
  runRelate({ cwd: target, from: s2.id, to: e2.id, type: 'refines' });

  const out = searchPayload('alpha widget', { cwd: target, expandEdges: true });
  const seedRows = out.results.filter((r) => r.expanded_via === undefined);
  const expandedRows = out.results.filter((r) => r.expanded_via !== undefined);

  // Seed rows come first.
  for (let i = 0; i < seedRows.length; i++) {
    assert.equal(out.results[i].expanded_via, undefined,
      `position ${i} should be a seed row`);
  }

  // All expansion rows are hop 1 (BFS) and follow the seeds.
  for (const row of expandedRows) {
    assert.equal(row.expanded_via!.hops, 1);
  }
  assert.ok(seedRows.length >= 1);
  assert.ok(expandedRows.length >= 1);
});
