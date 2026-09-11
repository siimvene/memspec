import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { makeTempProject, REPO_ROOT, runCli } from './helpers.js';
import { McpSession } from './mcp-session.js';
import { buildStatusReport } from '../src/commands/status.js';
import { MemspecStore } from '../src/lib/store.js';
import type { MemoryFrontmatter } from '../src/lib/types.js';

/**
 * F1 — usage receipts with outcomes. Covers:
 *  - extended usage.jsonl row shape (query, session, rank, surface)
 *  - `memspec outcome` CLI + `memspec_outcome` MCP tool
 *  - `supersede` auto-emitting a `corrected` outcome for every id it collapses
 *  - Cold / Promotion-candidates derivation over a hand-written usage/outcomes fixture
 */

async function firstId(stdout: string): Promise<string> {
  const match = stdout.match(/Created \w+ memory (ms_[0-9A-Z]+)/);
  if (!match) throw new Error(`could not find created id in: ${stdout}`);
  return match[1];
}

function seedItem(project: string, opts: {
  title: string;
  createdDaysAgo: number;
  kind?: 'claim' | 'observation';
  type?: 'fact' | 'decision' | 'procedure';
  verified_with?: MemoryFrontmatter['verified_with'];
}): string {
  const store = new MemspecStore(project);
  const id = `ms_${ulid()}`;
  const created = new Date(Date.now() - opts.createdDaysAgo * 24 * 60 * 60 * 1000).toISOString();
  const kind = opts.kind ?? 'claim';
  store.writeItem({
    id,
    kind,
    state: 'active',
    created,
    source: 'test',
    tags: [],
    check_by: 'never',
    ...(kind === 'claim' ? { type: opts.type ?? 'fact' } : {}),
    ...(opts.verified_with ? { verified_with: opts.verified_with } : {}),
    title: opts.title,
    body: 'body text',
  });
  return id;
}

test('search logs usage rows with query, session, rank, and surface', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli(['remember', 'fact', 'Auth uses JWT', '--cwd', target, '--source', 'test']);

  await runCli(['search', 'JWT', '--cwd', target], undefined, { MEMSPEC_SESSION_ID: 'sess-usage-1' });

  const raw = await readFile(join(target, '.memspec', 'usage.jsonl'), 'utf8');
  const rows = raw.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].query, 'JWT');
  assert.equal(rows[0].session, 'sess-usage-1');
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].surface, 'cli');
  assert.ok(typeof rows[0].retrieved_at === 'string');
});

test('MCP search stamps surface "mcp" on its usage rows', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli(['remember', 'fact', 'Postgres is the datastore', '--cwd', target, '--source', 'test']);

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'memspec-test', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});
    const res = await session.request('tools/call', { name: 'memspec_search', arguments: { query: 'Postgres' } });
    assert.equal(res.error, undefined);
  } finally {
    await session.close();
  }

  const raw = await readFile(join(target, '.memspec', 'usage.jsonl'), 'utf8');
  const rows = raw.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].surface, 'mcp');
});

test('outcome command appends a row and rejects an unknown outcome / unknown id', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const created = await runCli(['remember', 'fact', 'Some fact', '--cwd', target, '--source', 'test']);
  const id = await firstId(created.stdout);

  const result = await runCli(['outcome', id, 'useful', '--cwd', target, '--note', 'helped a lot', '--source', 'tester']);
  assert.match(result.stdout, /Recorded outcome "useful"/);

  const raw = await readFile(join(target, '.memspec', 'outcomes.jsonl'), 'utf8');
  const rows = raw.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].outcome, 'useful');
  assert.equal(rows[0].note, 'helped a lot');
  assert.equal(rows[0].source, 'tester');
  assert.ok(typeof rows[0].at === 'string');

  await assert.rejects(() => runCli(['outcome', id, 'bogus-outcome', '--cwd', target]));
  await assert.rejects(() => runCli(['outcome', 'ms_00000000000000000000000000', 'useful', '--cwd', target]));
});

test('MCP memspec_outcome records an outcome without mutating the memory file', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const created = await runCli(['remember', 'fact', 'Some other fact', '--cwd', target, '--source', 'test']);
  const id = await firstId(created.stdout);
  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const before = await readFile(join(factsDir, `${id}.md`), 'utf8');

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'memspec-test', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});
    const res = await session.request('tools/call', { name: 'memspec_outcome', arguments: { id, outcome: 'dead_end', note: 'wrong answer' } });
    assert.equal(res.error, undefined);
  } finally {
    await session.close();
  }

  const raw = await readFile(join(target, '.memspec', 'outcomes.jsonl'), 'utf8');
  const rows = raw.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].outcome, 'dead_end');

  const after = await readFile(join(factsDir, `${id}.md`), 'utf8');
  assert.equal(after, before, 'recording an outcome must never mutate the memory record');
});

test('supersede records a "corrected" outcome for every id it collapses (replace, retract, and merge branches)', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const retractId = await firstId((await runCli(['remember', 'fact', 'Retract me', '--cwd', target, '--source', 'test'])).stdout);
  await runCli(['supersede', retractId, '--cwd', target, '--reason', 'no longer true']);

  const replaceId = await firstId((await runCli(['remember', 'fact', 'Replace me', '--cwd', target, '--source', 'test'])).stdout);
  await runCli(['supersede', replaceId, '--cwd', target, '--reason', 'stale', '--body', 'Replacement body']);

  const survivorId = await firstId((await runCli(['remember', 'fact', 'Survivor', '--cwd', target, '--source', 'test'])).stdout);
  const mergeId = await firstId((await runCli(['remember', 'fact', 'Duplicate', '--cwd', target, '--source', 'test'])).stdout);
  await runCli(['supersede', survivorId, '--cwd', target, '--reason', 'dup', '--merge-from', mergeId]);

  const raw = await readFile(join(target, '.memspec', 'outcomes.jsonl'), 'utf8');
  const rows = raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const id of [retractId, replaceId, mergeId]) {
    assert.ok(byId.has(id), `expected a corrected outcome for ${id}`);
    assert.equal(byId.get(id).outcome, 'corrected');
  }
  assert.ok(!byId.has(survivorId), 'the survivor itself is not superseded and gets no outcome row');
});

test('status Cold and Promotion candidates derive from a hand-written usage.jsonl/outcomes.jsonl', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const storeRoot = join(target, '.memspec');

  const daysAgoIso = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  const coldNeverRetrieved = seedItem(target, { title: 'Cold never retrieved', createdDaysAgo: 40 });
  const coldStaleRef = seedItem(target, { title: 'Cold stale reference', createdDaysAgo: 90 });
  const freshFact = seedItem(target, { title: 'Fresh fact', createdDaysAgo: 5 });
  const recentlyReferencedOld = seedItem(target, { title: 'Old but recently referenced', createdDaysAgo: 100 });

  const promoObservation = seedItem(target, { title: 'Promo observation', createdDaysAgo: 3, kind: 'observation' });
  const promoYoungAssertionFact = seedItem(target, { title: 'Promo young assertion fact', createdDaysAgo: 5, verified_with: 'assertion' });
  const oneSessionFact = seedItem(target, { title: 'Only one session', createdDaysAgo: 5, verified_with: 'assertion' });
  const deadEndFact = seedItem(target, { title: 'Has a dead end', createdDaysAgo: 5, verified_with: 'assertion' });
  const oldAssertionFact = seedItem(target, { title: 'Too old for promotion', createdDaysAgo: 20, verified_with: 'assertion' });
  const anchoredFact = seedItem(target, { title: 'Anchored, not assertion', createdDaysAgo: 5, verified_with: 'anchor' });

  const usageLines = [
    { id: coldStaleRef, retrieved_at: daysAgoIso(70), session: 's1' },
    { id: recentlyReferencedOld, retrieved_at: daysAgoIso(10), session: 's1' },
    { id: promoObservation, retrieved_at: daysAgoIso(2), session: 'sA' },
    { id: promoObservation, retrieved_at: daysAgoIso(1), session: 'sB' },
    { id: promoYoungAssertionFact, retrieved_at: daysAgoIso(2), session: 'sA' },
    { id: promoYoungAssertionFact, retrieved_at: daysAgoIso(1), session: 'sB' },
    { id: oneSessionFact, retrieved_at: daysAgoIso(1), session: 'sA' },
    { id: deadEndFact, retrieved_at: daysAgoIso(2), session: 'sA' },
    { id: deadEndFact, retrieved_at: daysAgoIso(1), session: 'sB' },
    { id: oldAssertionFact, retrieved_at: daysAgoIso(2), session: 'sA' },
    { id: oldAssertionFact, retrieved_at: daysAgoIso(1), session: 'sB' },
    { id: anchoredFact, retrieved_at: daysAgoIso(2), session: 'sA' },
    { id: anchoredFact, retrieved_at: daysAgoIso(1), session: 'sB' },
  ];
  await writeFile(join(storeRoot, 'usage.jsonl'), `${usageLines.map((l) => JSON.stringify(l)).join('\n')}\n`);

  const outcomeLines = [
    { id: deadEndFact, outcome: 'dead_end', at: daysAgoIso(1) },
  ];
  await writeFile(join(storeRoot, 'outcomes.jsonl'), `${outcomeLines.map((l) => JSON.stringify(l)).join('\n')}\n`);

  const { report } = buildStatusReport({ cwd: target });
  const coldIds = report.cold.map((c) => c.id);
  const promoIds = report.promotion_candidates.map((c) => c.id);

  assert.ok(coldIds.includes(coldNeverRetrieved), 'never retrieved + created > 30d ago => cold');
  assert.ok(coldIds.includes(coldStaleRef), 'last referenced 70 days ago => cold');
  assert.ok(!coldIds.includes(freshFact), 'created only 5 days ago => not cold regardless of retrieval');
  assert.ok(!coldIds.includes(recentlyReferencedOld), 'referenced 10 days ago => not cold despite being old');

  assert.ok(promoIds.includes(promoObservation), 'active observation, 2 sessions, no dead_end => candidate');
  assert.ok(promoIds.includes(promoYoungAssertionFact), 'young assertion fact, 2 sessions, no dead_end => candidate');
  assert.ok(!promoIds.includes(oneSessionFact), 'only 1 distinct session => not a candidate');
  assert.ok(!promoIds.includes(deadEndFact), 'has a dead_end outcome => not a candidate');
  assert.ok(!promoIds.includes(oldAssertionFact), 'created 20 days ago => outside the 14-day window');
  assert.ok(!promoIds.includes(anchoredFact), 'witness is anchor, not assertion => not a candidate');

  const text = await runCli(['status', '--cwd', target]);
  assert.match(text.stdout, /## Cold/);
  assert.match(text.stdout, /## Promotion candidates/);
  assert.match(text.stdout, /candidates only, nothing auto-promoted/);
});
