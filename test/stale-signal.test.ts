import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeTempProject, REPO_ROOT, runCli } from './helpers.js';
import { McpSession } from './mcp-session.js';
import { searchPayload, runSearch } from '../src/commands/search.js';
import { runRemember } from '../src/commands/remember.js';
import { runSupersede } from '../src/commands/supersede.js';
import { runContext } from '../src/commands/context.js';
import { buildStatusReport, runStatus } from '../src/commands/status.js';
import { normalizeLegacyFrontmatter } from '../src/lib/schema.js';
import { MemspecStore } from '../src/lib/store.js';
import type { MemoryFrontmatter } from '../src/lib/types.js';

/**
 * Stale-signal work (post-0.11): stop presenting old, unverified records as
 * current truth.
 *
 *   1. Legacy `decay_after: never` no longer means never — the type default
 *      TTL applies unless the record carries an explicit v0.3 `check_by`.
 *   2. Assertion-witnessed hits unverified for longer than `aging_days`
 *      (default 90) carry `aged: true` + `unverified_days`.
 *   3. A supersede whose target lives in a read-only layer writes the
 *      replacement into the one writable layer and hides the target from the
 *      read view, reported as a pending promotion.
 *
 * Origin: a team-store decision imported with `decay_after: never`, witness
 * `assertion`, last verified months earlier, kept ranking as `stale: false`
 * after the facts it stated had changed.
 */

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY).toISOString();
const daysAhead = (n: number): string => new Date(Date.now() + n * DAY).toISOString();
const fixedId = (n: number): string => `ms_01STALESIGNAL${String(n).padStart(13, '0')}`;

async function initStore(dir: string): Promise<MemspecStore> {
  await runCli(['init', '--cwd', dir, '--no-interactive', '--no-install-hooks']);
  return new MemspecStore(join(dir, '.memspec'));
}

function writeClaim(
  store: MemspecStore,
  fm: Partial<MemoryFrontmatter> & { id: string; title: string; body: string },
): string {
  return store.writeItem({
    kind: 'claim',
    type: 'fact',
    state: 'active',
    created: daysAgo(1),
    source: 'agent:test',
    tags: [],
    check_by: daysAhead(365),
    ...fm,
  } as MemoryFrontmatter & { title: string; body: string });
}

/** A pre-0.3 record carrying `decay_after` instead of `check_by`. */
async function writeLegacyDecision(storeRoot: string, id: string, decayAfter: string, created: string): Promise<string> {
  const dir = join(storeRoot, 'memory', 'decisions');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.md`);
  await writeFile(path, [
    '---',
    `id: ${id}`,
    'type: decision',
    'state: active',
    `created: ${created}`,
    'source: claude-code',
    'tags: [auth]',
    `decay_after: ${decayAfter}`,
    '---',
    '',
    '# Token lifetime cost decision',
    '',
    'One-year tokens because each eID auth costs money.',
    '',
  ].join('\n'), 'utf8');
  return path;
}

// --- 1. legacy decay_after: never -------------------------------------------

test('normalize: legacy decay_after never resolves to the type default TTL, not never', () => {
  const created = '2026-05-02T00:00:00.000Z';
  const out = normalizeLegacyFrontmatter({ id: fixedId(1), type: 'decision', created, decay_after: 'never' });
  assert.notEqual(out.check_by, 'never');
  // decision default = 180d, counted from last_verified ?? created.
  assert.equal(out.check_by, new Date(Date.parse(created) + 180 * DAY).toISOString());
  assert.equal(out.decay_after, undefined);

  const verified = normalizeLegacyFrontmatter({
    id: fixedId(2), type: 'fact', created, last_verified: '2026-06-01T00:00:00.000Z', decay_after: 'never',
  });
  assert.equal(verified.check_by, new Date(Date.parse('2026-06-01T00:00:00.000Z') + 90 * DAY).toISOString());
});

test('normalize: legacy decay_after ISO date and explicit check_by never are unchanged', () => {
  const dated = normalizeLegacyFrontmatter({ id: fixedId(3), type: 'fact', created: daysAgo(10), decay_after: '2030-01-01T00:00:00.000Z' });
  assert.equal(dated.check_by, '2030-01-01T00:00:00.000Z');

  const pinned = normalizeLegacyFrontmatter({ id: fixedId(4), type: 'fact', created: daysAgo(10), check_by: 'never' });
  assert.equal(pinned.check_by, 'never');

  // Both present: the v0.3 field wins, as before.
  const both = normalizeLegacyFrontmatter({ id: fixedId(5), type: 'fact', created: daysAgo(10), check_by: 'never', decay_after: 'never' });
  assert.equal(both.check_by, 'never');
});

test('search: an old legacy decay_after never record reads stale, and the file is not rewritten', async () => {
  const dir = await makeTempProject();
  const store = await initStore(dir);
  const path = await writeLegacyDecision(store.root, fixedId(10), 'never', daysAgo(400));
  const before = await readFile(path, 'utf8');

  const payload = searchPayload('token lifetime', { cwd: dir });
  const row = payload.results.find((r) => r.id === fixedId(10));
  assert.ok(row, 'legacy record must still be searchable');
  assert.equal(row.stale, true, '400 days past created with a 180d decision TTL is stale');

  assert.equal(await readFile(path, 'utf8'), before, 'read paths never rewrite files');
});

test('search: an explicit v0.3 check_by never stays honoured on an old record', async () => {
  const dir = await makeTempProject();
  const store = await initStore(dir);
  writeClaim(store, {
    id: fixedId(11), title: 'Pinned settlement history', body: 'Deployed at commit abc.',
    created: daysAgo(400), check_by: 'never', verified_with: 'operator', source: 'human:siim',
  });
  const row = searchPayload('settlement history', { cwd: dir }).results.find((r) => r.id === fixedId(11));
  assert.ok(row);
  assert.equal(row.stale, false);
});

test('migrate --apply: legacy decay_after never becomes a dated check_by, not never', async () => {
  const dir = await makeTempProject();
  await mkdir(join(dir, '.memspec'), { recursive: true });
  const created = '2025-01-01T00:00:00.000Z';
  const path = await writeLegacyDecision(join(dir, '.memspec'), fixedId(12), 'never', created);

  await runCli(['migrate', '--cwd', dir, '--apply']);

  const fm = matter(await readFile(path, 'utf8')).data as Record<string, unknown>;
  const checkBy = fm.check_by instanceof Date ? fm.check_by.toISOString() : fm.check_by;
  assert.equal(checkBy, new Date(Date.parse(created) + 180 * DAY).toISOString());
  assert.equal(fm.decay_after, undefined);
  assert.equal(fm.stale, true, 'the derived check_by is in the past, so migrate flags it like any other');
});

test('legacy never honours the store config.yaml decay: override, on the read path and in migrate', async () => {
  const dir = await makeTempProject();
  const store = await initStore(dir);
  const configPath = join(store.root, 'config.yaml');
  const config = await readFile(configPath, 'utf8');
  assert.match(config, /decision: 180d/);
  await writeFile(configPath, config.replace('decision: 180d', 'decision: 30d'), 'utf8');
  const created = daysAgo(60);
  const path = await writeLegacyDecision(store.root, fixedId(13), 'never', created);

  const row = searchPayload('token lifetime', { cwd: dir }).results.find((r) => r.id === fixedId(13));
  assert.ok(row);
  assert.equal(row.stale, true, '60 days past created with a configured 30d decision TTL is stale (180d default would not be)');
  assert.equal(new MemspecStore(dir).findById(fixedId(13))?.check_by, new Date(Date.parse(created) + 30 * DAY).toISOString());

  await runCli(['migrate', '--cwd', dir, '--apply']);
  const fm = matter(await readFile(path, 'utf8')).data as Record<string, unknown>;
  const checkBy = fm.check_by instanceof Date ? fm.check_by.toISOString() : fm.check_by;
  assert.equal(checkBy, new Date(Date.parse(created) + 30 * DAY).toISOString());
});

// --- 2. aging signal ---------------------------------------------------------

test('search: an assertion-only hit unverified past aging_days carries aged + unverified_days', async () => {
  const dir = await makeTempProject();
  const store = await initStore(dir);
  writeClaim(store, { id: fixedId(20), title: 'Gateway uses mutual TLS', body: 'Gateway mtls everywhere.', created: daysAgo(200) });
  writeClaim(store, { id: fixedId(21), title: 'Gateway retries twice', body: 'Gateway retry policy.', created: daysAgo(10) });

  const payload = searchPayload('gateway', { cwd: dir });
  const old = payload.results.find((r) => r.id === fixedId(20));
  const fresh = payload.results.find((r) => r.id === fixedId(21));
  assert.ok(old && fresh);
  assert.equal(old.stale, false, 'check_by is a year out: not stale, only unverified');
  assert.equal(old.aged, true);
  assert.equal(old.unverified_days, 200);
  assert.equal(fresh.aged, undefined);
  assert.equal(fresh.unverified_days, undefined);

  const text = runSearch('gateway', { cwd: dir });
  assert.match(text, /\[UNVERIFIED 200d — check before relying\]/);
  const json = JSON.parse(runSearch('gateway', { cwd: dir, json: true })) as { results: Array<{ id: string; aged?: boolean }> };
  assert.equal(json.results.find((r) => r.id === fixedId(20))?.aged, true);
});

test('search: last_verified, not created, is the aging clock', async () => {
  const dir = await makeTempProject();
  const store = await initStore(dir);
  writeClaim(store, {
    id: fixedId(22), title: 'Gateway reverified recently', body: 'Gateway rechecked.',
    created: daysAgo(300), last_verified: daysAgo(5),
  });
  const row = searchPayload('gateway', { cwd: dir }).results.find((r) => r.id === fixedId(22));
  assert.ok(row);
  assert.equal(row.aged, undefined);
});

test('search: no aging for explicit check_by never, already-stale, or stronger witnesses', async () => {
  const dir = await makeTempProject();
  const store = await initStore(dir);
  writeClaim(store, { id: fixedId(23), title: 'Gateway pinned history', body: 'Gateway event.', created: daysAgo(200), check_by: 'never' });
  writeClaim(store, { id: fixedId(24), title: 'Gateway overdue claim', body: 'Gateway overdue.', created: daysAgo(200), check_by: daysAgo(20) });
  writeClaim(store, { id: fixedId(25), title: 'Gateway operator claim', body: 'Gateway operator.', created: daysAgo(200), verified_with: 'operator' });

  const rows = new Map(searchPayload('gateway', { cwd: dir }).results.map((r) => [r.id, r]));
  assert.equal(rows.get(fixedId(23))?.aged, undefined, 'explicit never is a deliberate pin');
  assert.equal(rows.get(fixedId(24))?.stale, true);
  assert.equal(rows.get(fixedId(24))?.aged, undefined, 'stale already says it');
  assert.equal(rows.get(fixedId(25))?.aged, undefined, 'only assertion-witnessed claims age');
});

test('search: aging_days from config.yaml moves the threshold; 0 disables it', async () => {
  const dir = await makeTempProject();
  const store = await initStore(dir);
  writeClaim(store, { id: fixedId(26), title: 'Gateway uses mutual TLS', body: 'Gateway mtls.', created: daysAgo(40) });
  const configPath = join(store.root, 'config.yaml');
  const baseConfig = await readFile(configPath, 'utf8');

  assert.equal(searchPayload('gateway', { cwd: dir }).results[0].aged, undefined, '40d < default 90d');

  await writeFile(configPath, `${baseConfig}\naging_days: 30\n`, 'utf8');
  const row = searchPayload('gateway', { cwd: dir }).results[0];
  assert.equal(row.aged, true);
  assert.equal(row.unverified_days, 40);

  await writeFile(configPath, `${baseConfig}\naging_days: 0\n`, 'utf8');
  assert.equal(searchPayload('gateway', { cwd: dir }).results[0].aged, undefined, 'aging_days: 0 disables the signal');
});

test('mcp: memspec_search and memspec_get both carry the aging signal', async () => {
  const dir = await makeTempProject();
  const store = await initStore(dir);
  writeClaim(store, { id: fixedId(27), title: 'Gateway uses mutual TLS', body: 'Gateway mtls.', created: daysAgo(120) });

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', dir]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stale-signal', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});

    const search = await session.request('tools/call', { name: 'memspec_search', arguments: { query: 'gateway' } });
    const sres = search.result as { content: Array<{ text: string }>; structuredContent: { results: Array<{ aged?: boolean; unverified_days?: number }> } };
    assert.equal(sres.structuredContent.results[0].aged, true);
    assert.equal(sres.structuredContent.results[0].unverified_days, 120);
    assert.match(sres.content[0].text, /\[UNVERIFIED 120d — check before relying\]/);

    const get = await session.request('tools/call', { name: 'memspec_get', arguments: { id: fixedId(27) } });
    const parsed = JSON.parse((get.result as { content: Array<{ text: string }> }).content[0].text) as {
      aged?: boolean; unverified_days?: number; stale?: boolean;
    };
    assert.equal(parsed.aged, true);
    assert.equal(parsed.unverified_days, 120);
    assert.equal(parsed.stale, false);
  } finally {
    await session.close();
  }
});

// --- 3. cross-layer supersede ------------------------------------------------

/** Writable personal store layering a read-only team store (same shape as layered-readonly.test.ts). */
async function makeTeamFixture(extraWritable = false): Promise<{
  personal: string; personalStore: MemspecStore; teamStore: MemspecStore; teamId: string; teamPath: string;
}> {
  const personal = await makeTempProject();
  const team = await makeTempProject();
  const personalStore = await initStore(personal);
  const teamStore = await initStore(team);

  const teamRec = runRemember('decision', 'Token lifetime is one year', {
    cwd: team,
    body: 'One-year tokens because each eID auth costs money.',
    source: 'team:import',
  });

  const lines = [
    'stores:',
    '  - name: personal',
    `    path: ${personalStore.root}`,
    '    priority: 0',
    '    writable: true',
    '  - name: team',
    `    path: ${teamStore.root}`,
    '    priority: 10',
    '    writable: false',
  ];
  if (extraWritable) {
    const other = await makeTempProject();
    const otherStore = await initStore(other);
    lines.push('  - name: other', `    path: ${otherStore.root}`, '    priority: 5', '    writable: true');
  }
  await writeFile(join(personalStore.root, 'config.yaml'), `${lines.join('\n')}\n`, 'utf8');

  return { personal, personalStore, teamStore, teamId: teamRec.id, teamPath: teamRec.filePath };
}

test('supersede: a read-only-layer target gets a local replacement reported as a pending promotion', async () => {
  const fx = await makeTeamFixture();
  const teamBefore = await readFile(fx.teamPath, 'utf8');

  const result = runSupersede(fx.teamId, {
    cwd: fx.personal,
    reason: 'auth system and vendor price changed',
    body: 'Token lifetime follows the new auth flow; per-auth cost no longer drives it.',
    source: 'agent:test',
  });

  assert.deepEqual(result.pending_promotion, { layer: 'team', target_id: fx.teamId });
  assert.match(result.message, /pending promotion/i);
  assert.match(result.message, /team/);

  const replacement = fx.personalStore.findById(result.survivor_id);
  assert.ok(replacement, 'replacement lands in the writable personal layer');
  assert.deepEqual(replacement.supersedes, [fx.teamId]);
  assert.equal(replacement.state, 'active');
  assert.equal(await readFile(fx.teamPath, 'utf8'), teamBefore, 'the read-only file is untouched');
  assert.equal(fx.teamStore.findById(fx.teamId)?.state, 'active');
});

test('read view: a team record superseded by an active local record drops out of search and boot context', async () => {
  const fx = await makeTeamFixture();
  const before = searchPayload('token lifetime', { cwd: fx.personal });
  assert.ok(before.results.some((r) => r.id === fx.teamId), 'precondition: team record visible');

  const result = runSupersede(fx.teamId, {
    cwd: fx.personal, reason: 'stale', body: 'Token lifetime is set by the new auth flow.', source: 'agent:test',
  });

  const after = searchPayload('token lifetime', { cwd: fx.personal });
  assert.ok(!after.results.some((r) => r.id === fx.teamId), 'superseded-in-view record is not an active hit');
  assert.ok(after.results.some((r) => r.id === result.survivor_id));

  const boot = runContext({ cwd: fx.personal, format: 'json' });
  assert.ok(!boot.includes(fx.teamId), 'boot context drops the superseded team record');
  assert.ok(boot.includes(result.survivor_id));
  const queried = runContext({ cwd: fx.personal, format: 'json', query: 'token lifetime' });
  assert.ok(!queried.includes(fx.teamId));
});

test('read view: a hand-written local record declaring supersedes counts the same; a retired one does not', async () => {
  const fx = await makeTeamFixture();
  writeClaim(fx.personalStore, {
    id: fixedId(30), type: 'decision', title: 'Retired local note', body: 'Token lifetime retired note.',
    state: 'retired', supersedes: [fx.teamId],
  });
  assert.ok(
    searchPayload('token lifetime', { cwd: fx.personal }).results.some((r) => r.id === fx.teamId),
    'only an ACTIVE local record supersedes in view',
  );

  writeClaim(fx.personalStore, {
    id: fixedId(31), type: 'decision', title: 'Token lifetime corrected', body: 'Token lifetime follows the new flow.',
    supersedes: [fx.teamId],
  });
  const ids = searchPayload('token lifetime', { cwd: fx.personal }).results.map((r) => r.id);
  assert.ok(!ids.includes(fx.teamId));
  assert.ok(ids.includes(fixedId(31)));

  const report = buildStatusReport({ cwd: fx.personal }).report;
  assert.deepEqual(report.pending_promotions, [{ id: fixedId(31), target_id: fx.teamId, target_layer: 'team' }]);
  const text = runStatus({ cwd: fx.personal });
  assert.match(text, /Pending promotions/);
  assert.ok(text.includes(`${fixedId(31)} supersedes ${fx.teamId} (layer: team)`));
});

test('mcp: memspec_get on a superseded-in-view team record says so', async () => {
  const fx = await makeTeamFixture();
  const result = runSupersede(fx.teamId, {
    cwd: fx.personal, reason: 'stale', body: 'Token lifetime is set by the new auth flow.', source: 'agent:test',
  });

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', fx.personal]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stale-signal', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});
    const get = await session.request('tools/call', { name: 'memspec_get', arguments: { id: fx.teamId } });
    const parsed = JSON.parse((get.result as { content: Array<{ text: string }> }).content[0].text) as {
      state: string; superseded_by?: string; layer?: string;
    };
    assert.equal(parsed.state, 'superseded-in-view');
    assert.equal(parsed.superseded_by, result.survivor_id);
    assert.equal(parsed.layer, 'team');

    const sup = await session.request('tools/call', {
      name: 'memspec_supersede',
      arguments: { id: result.survivor_id, reason: 'refine', body: 'Refined again.', source: 'agent:test' },
    });
    const structured = (sup.result as { structuredContent: { pending_promotion?: unknown } }).structuredContent;
    assert.equal(structured.pending_promotion, undefined, 'a local-to-local supersede is not a promotion');
  } finally {
    await session.close();
  }
});

test('mcp: memspec_supersede on a read-only-layer target returns pending_promotion', async () => {
  const fx = await makeTeamFixture();
  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', fx.personal]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stale-signal', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});
    const sup = await session.request('tools/call', {
      name: 'memspec_supersede',
      arguments: { id: fx.teamId, reason: 'stale', body: 'New flow.', source: 'agent:test' },
    });
    const structured = (sup.result as { structuredContent: { pending_promotion?: unknown } }).structuredContent;
    assert.deepEqual(structured.pending_promotion, { layer: 'team', target_id: fx.teamId });
  } finally {
    await session.close();
  }
});

test('supersede: read-only target still refuses when the writable layer is ambiguous, or on a retraction', async () => {
  const ambiguous = await makeTeamFixture(true);
  assert.throws(
    () => runSupersede(ambiguous.teamId, { cwd: ambiguous.personal, reason: 'x', body: 'new', source: 'agent:test' }),
    /read-only store layer 'team'/,
  );

  const fx = await makeTeamFixture();
  assert.throws(
    () => runSupersede(fx.teamId, { cwd: fx.personal, reason: 'retract', source: 'agent:test' }),
    /read-only store layer 'team'/,
  );
  assert.equal(fx.teamStore.findById(fx.teamId)?.state, 'active');
});

test('read view: superseding the local replacement again keeps the team record superseded in view', async () => {
  const fx = await makeTeamFixture();
  const first = runSupersede(fx.teamId, {
    cwd: fx.personal, reason: 'stale', body: 'Token lifetime is set by the new auth flow.', source: 'agent:test',
  });
  const second = runSupersede(first.survivor_id, {
    cwd: fx.personal, reason: 'refined', body: 'Token lifetime is set by the new auth flow, 30 days.', source: 'agent:test',
  });
  assert.equal(second.pending_promotion, undefined);

  const ids = searchPayload('token lifetime', { cwd: fx.personal }).results.map((r) => r.id);
  assert.ok(!ids.includes(fx.teamId), 'the chain still ends in an active local record');
  assert.ok(ids.includes(second.survivor_id));
  assert.deepEqual(
    buildStatusReport({ cwd: fx.personal }).report.pending_promotions,
    [{ id: second.survivor_id, target_id: fx.teamId, target_layer: 'team' }],
    'the promotion owed is the live end of the chain',
  );

  // Retracting the live end withdraws the local claim: the team record is active again.
  runSupersede(second.survivor_id, { cwd: fx.personal, reason: 'wrong after all', source: 'agent:test' });
  assert.ok(searchPayload('token lifetime', { cwd: fx.personal }).results.some((r) => r.id === fx.teamId));
});

test('supersede: a read-only target already superseded in view points at the live local record instead of forking', async () => {
  const fx = await makeTeamFixture();
  const first = runSupersede(fx.teamId, {
    cwd: fx.personal, reason: 'stale', body: 'Token lifetime is set by the new auth flow.', source: 'agent:test',
  });
  assert.throws(
    () => runSupersede(fx.teamId, { cwd: fx.personal, reason: 'again', body: 'Another take.', source: 'agent:test' }),
    new RegExp(`already superseded in this view by ${first.survivor_id}`),
  );
  assert.equal(fx.personalStore.loadActive().length, 1, 'no second local replacement was written');
});

// --- 4. cross-layer supersede: memo, lock, determinism ----------------------

test('read view: pendingPromotions parses the layers once per view, and a write through a layer store invalidates it', async () => {
  const fx = await makeTeamFixture();
  const { CompositeStore } = await import('../src/lib/composite-store.js');
  const composite = CompositeStore.forCwd(fx.personal);
  const proto = MemspecStore.prototype as unknown as Record<'loadAll' | 'loadActive', (...a: unknown[]) => unknown>;
  const original = { loadAll: proto.loadAll, loadActive: proto.loadActive };
  let loads = 0;
  for (const name of ['loadAll', 'loadActive'] as const) {
    proto[name] = function (this: unknown, ...args: unknown[]) { loads++; return original[name].apply(this, args); };
  }
  try {
    assert.equal(composite.pendingPromotions().size, 0);
    const first = loads;
    assert.ok(first > 0);
    composite.pendingPromotions();
    composite.pendingPromotions();
    assert.equal(loads, first, 'repeat calls on one view reuse the computed map');

    const local = composite.layers.find((l) => l.writable)!;
    writeClaim(local.store, { id: fixedId(40), title: 'Token lifetime follows auth', body: 'New flow.', supersedes: [fx.teamId] });
    assert.equal(composite.pendingPromotions().get(fx.teamId)?.id, fixedId(40), 'a write through the layer store is seen');
  } finally {
    proto.loadAll = original.loadAll;
    proto.loadActive = original.loadActive;
  }
});

test('supersede: a cross-layer supersede holds a lock on the target; a held lock refuses, a stale one is reclaimed', async () => {
  const fx = await makeTeamFixture();
  const { utimes } = await import('node:fs/promises');
  const lockDir = join(fx.personalStore.root, 'local', 'locks');
  const lock = join(lockDir, `supersede-${fx.teamId}.lock`);
  await mkdir(lockDir, { recursive: true });
  await writeFile(lock, 'pid 1\n', { flag: 'wx' });

  assert.throws(
    () => runSupersede(fx.teamId, { cwd: fx.personal, reason: 'stale', body: 'Racing replacement.', source: 'agent:test' }),
    /another supersede of .* is in progress/,
  );
  assert.equal(fx.personalStore.loadActive().length, 0, 'nothing written while the lock is held');

  const old = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(lock, old, old);
  const result = runSupersede(fx.teamId, { cwd: fx.personal, reason: 'stale', body: 'Replacement.', source: 'agent:test' });
  assert.deepEqual(result.pending_promotion, { layer: 'team', target_id: fx.teamId });
  await assert.rejects(readFile(lock, 'utf8'), /ENOENT/, 'the lock is released after the write');
});

test('supersede: two concurrent cross-layer supersedes of one target write one replacement', async () => {
  const fx = await makeTeamFixture();
  const run = (body: string) => runCli(['supersede', fx.teamId, '--cwd', fx.personal, '--reason', 'race', '--body', body, '--source', 'agent:test'])
    .then(() => 'ok', (err: unknown) => String((err as { stderr?: string }).stderr ?? err));
  const outcomes = await Promise.all([run('First take.'), run('Second take.')]);
  assert.equal(outcomes.filter((o) => o === 'ok').length, 1, `exactly one succeeds: ${JSON.stringify(outcomes)}`);
  assert.equal(fx.personalStore.loadActive().length, 1, 'one active local replacement');
});

test('read view: two live local replacements of one target are reported deterministically, flagged as a conflict', async () => {
  const fx = await makeTeamFixture();
  // Ids chosen so the lexically-larger one sorts first on disk by title.
  writeClaim(fx.personalStore, { id: fixedId(52), title: 'A token lifetime take', body: 'One.', supersedes: [fx.teamId] });
  writeClaim(fx.personalStore, { id: fixedId(51), title: 'Z token lifetime take', body: 'Two.', supersedes: [fx.teamId] });
  const { CompositeStore } = await import('../src/lib/composite-store.js');
  const pending = CompositeStore.forCwd(fx.personal).pendingPromotions().get(fx.teamId);
  assert.deepEqual(pending, { id: fixedId(51), target_id: fx.teamId, target_layer: 'team', conflicting_ids: [fixedId(52)] });
  const { report } = buildStatusReport({ cwd: fx.personal });
  assert.deepEqual(report.pending_promotions, [pending]);
  assert.match(runStatus({ cwd: fx.personal }), new RegExp(`${fixedId(51)} supersedes ${fx.teamId} \\(layer: team\\) — CONFLICT: also superseded by ${fixedId(52)}`));
});
