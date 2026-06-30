import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRemember } from '../src/commands/remember.js';
import { runSupersede } from '../src/commands/supersede.js';
import { searchPayload } from '../src/commands/search.js';
import { MemspecStore } from '../src/lib/store.js';

/**
 * v0.6 Phase 1 — archive-expansion tests.
 *
 * Regression target: the real-store eval finding `q13-supersede-markedroid`.
 * `memspec_search` previously filtered records to `state: active` BEFORE the
 * graph expansion walker ran, so the walker had no way to surface a record
 * that had been superseded — even when an active seed pointed at it via the
 * `supersedes` edge.
 *
 * Fix: `include_superseded: true` widens the expansion map to (active +
 * superseded) so the walker can resolve archive targets. Seeds stay
 * active-only — lexical matches into the archive would flood results with
 * stale claims and defeat the lifecycle.
 */

async function makeProject(): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), 'memspec-archive-exp-'));
  const store = new MemspecStore(target);
  store.init();
  return target;
}

/**
 * Shared fixture: an original active fact gets superseded by a replacement.
 * The replacement carries `supersedes: [original.id]` and is active; the
 * original moves to archive with `state: 'superseded'` and `superseded_by`
 * pointing at the replacement.
 */
async function withSupersededPair(): Promise<{
  target: string;
  originalId: string;
  replacementId: string;
}> {
  const target = await makeProject();
  const original = runRemember('fact', 'Queue length tracker', {
    cwd: target,
    body: 'tracks length of the markedroid intake queue every 10s',
    source: 'agent-a',
    tags: 'queue,markedroid',
  });
  const replacement = runSupersede(original.id, {
    cwd: target,
    body: 'queue length tracker — revised, samples every 2s and emits histogram metrics for markedroid intake',
    title: 'Queue length tracker (v2)',
    reason: 'better metrics',
  });
  return { target, originalId: original.id, replacementId: replacement.survivor_id };
}

// ---------- default behaviour (regression guard) ---------------------------

test('default: include_superseded absent — walker cannot reach superseded record (q13 regression)', async () => {
  const { target, originalId, replacementId } = await withSupersededPair();

  const out = searchPayload('Queue length', {
    cwd: target,
    expandEdges: true,
  });

  const replacementRow = out.results.find((r) => r.id === replacementId);
  assert.ok(replacementRow, 'replacement is the active seed hit');
  assert.equal(replacementRow.state, 'active', 'seed row carries state: active');

  const archivedRow = out.results.find((r) => r.id === originalId);
  assert.equal(archivedRow, undefined,
    'archived original must NOT surface when include_superseded is absent');
});

test('default: include_superseded:false — explicitly off matches absent', async () => {
  const { target, originalId, replacementId } = await withSupersededPair();

  const out = searchPayload('Queue length', {
    cwd: target,
    expandEdges: true,
    includeSuperseded: false,
  });

  assert.ok(out.results.find((r) => r.id === replacementId), 'replacement present');
  assert.equal(out.results.find((r) => r.id === originalId), undefined,
    'archived original absent when explicitly off');
});

// ---------- include_superseded ON, expand_edges ON ------------------------

test('include_superseded:true + expand_edges:true — walker reaches superseded predecessor via supersedes', async () => {
  const { target, originalId, replacementId } = await withSupersededPair();

  const out = searchPayload('Queue length', {
    cwd: target,
    expandEdges: true,
    includeSuperseded: true,
  });

  const replacementRow = out.results.find((r) => r.id === replacementId);
  assert.ok(replacementRow, 'replacement is the active seed hit');
  assert.equal(replacementRow.state, 'active');
  assert.equal(replacementRow.expanded_via, undefined, 'seed has no expanded_via');

  const archivedRow = out.results.find((r) => r.id === originalId);
  assert.ok(archivedRow, 'archived original IS surfaced via expansion');
  assert.equal(archivedRow.state, 'superseded',
    'archived row carries state: superseded so callers can see lifecycle');
  assert.ok(archivedRow.expanded_via,
    'archive row must carry expanded_via descriptor');
  assert.equal(archivedRow.expanded_via.edge_type, 'supersedes',
    'expansion edge is the supersedes pointer on the replacement');
  assert.equal(archivedRow.expanded_via.from_id, replacementId,
    'expanded_via.from_id is the active seed');
});

// ---------- include_superseded ON, expand_edges OFF -----------------------

test('include_superseded:true + expand_edges:false — option is a no-op without expansion', async () => {
  const { target, originalId, replacementId } = await withSupersededPair();

  const out = searchPayload('Queue length', {
    cwd: target,
    expandEdges: false,
    includeSuperseded: true,
  });

  const replacementRow = out.results.find((r) => r.id === replacementId);
  assert.ok(replacementRow, 'active replacement still surfaces via FTS');
  assert.equal(replacementRow.state, 'active');

  const archivedRow = out.results.find((r) => r.id === originalId);
  assert.equal(archivedRow, undefined,
    'no expansion → no archive surfacing even with include_superseded set');
});

// ---------- mixed result set, lifecycle marking ---------------------------

test('mixed: active seeds + superseded expansion targets both surface, each correctly marked', async () => {
  const { target, originalId, replacementId } = await withSupersededPair();

  const out = searchPayload('Queue length', {
    cwd: target,
    expandEdges: true,
    includeSuperseded: true,
  });

  const seedRows = out.results.filter((r) => r.expanded_via === undefined);
  const expandedRows = out.results.filter((r) => r.expanded_via !== undefined);

  assert.ok(seedRows.length >= 1, 'at least one active seed');
  assert.ok(expandedRows.length >= 1, 'at least one expansion hit');

  for (const row of seedRows) {
    assert.equal(row.state, 'active',
      `seed ${row.id} must be active (seed pool stays active-only)`);
  }

  const archivedRow = expandedRows.find((r) => r.id === originalId);
  assert.ok(archivedRow, 'archived predecessor is among expansion rows');
  assert.equal(archivedRow.state, 'superseded');
});

// ---------- seed pool stays active-only -----------------------------------

test('seed pool stays active-only: include_superseded:true does not let superseded records seed lexical matches', async () => {
  const target = await makeProject();
  // A fact whose distinctive lexical signal lives ONLY in the superseded
  // predecessor — the replacement uses different wording. Without seed-pool
  // protection, FTS over (active + superseded) would surface the archived
  // record as a seed. We assert the FTS seed pool is unchanged.
  const original = runRemember('fact', 'Sphinx parser uses regex backtracking', {
    cwd: target,
    body: 'sphinx parser pipeline (zorblesplat zonkulus) uses regex backtracking on the lexer fast path',
    source: 'agent-a',
    tags: 'parser',
  });
  runSupersede(original.id, {
    cwd: target,
    body: 'parser pipeline now uses a hand-written state machine; no backtracking, no regex on hot paths',
    title: 'Parser uses state machine',
    reason: 'rewrite shipped 2026-Q2',
  });

  // The unique token "zorblesplat" exists only in the archived predecessor's
  // body. With include_superseded the walker can reach it AS A TARGET, but
  // it must not appear as a SEED (no active record matches the query).
  const out = searchPayload('zorblesplat zonkulus', {
    cwd: target,
    expandEdges: true,
    includeSuperseded: true,
  });

  const seedRows = out.results.filter((r) => r.expanded_via === undefined);
  for (const row of seedRows) {
    assert.equal(row.state, 'active',
      `seed ${row.id} (${row.title}) must be active — superseded records cannot seed`);
    assert.notEqual(row.id, original.id,
      'archived predecessor must NEVER be a seed, only ever an expansion target');
  }
});
