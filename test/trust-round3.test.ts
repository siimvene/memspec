import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRemember } from '../src/commands/remember.js';
import { runSupersede } from '../src/commands/supersede.js';
import { searchPayload } from '../src/commands/search.js';
import { claimSimilarity, CLAIM_SIMILARITY_THRESHOLD } from '../src/lib/similarity.js';
import { MemspecStore } from '../src/lib/store.js';
import { McpSession } from './mcp-session.js';
import { makeTempProject, REPO_ROOT, runCli } from './helpers.js';

/**
 * Regression: the round-3 skeptic probes D and E.
 *
 * D: a supersede with merge_from and no body never judged the survivor's own
 * text, so merging the current-value record S into an older record still
 * stating the rejected value made the old value the chain's active end (and
 * the current value could no longer be re-remembered). The twin scores 0.43
 * against the rejected record, under the threshold: only the place-transfer
 * rule (tombstone.ts) catches it.
 *
 * E: the archive scan read only the write-target layer, so a remember into
 * another writable layer (`store: "global"`) re-asserted a value rejected in
 * the project layer of the same read view.
 */

const MCP = { channel: 'mcp' as const };

const BODY = (ttl: string) =>
  `Session cache entries in the gateway expire after ${ttl} minutes. The TTL is set in config/cache.yaml under session.ttl and applies to every pod in the cluster; changing it requires a rolling restart of the gateway deployment.`;
const OLD = { title: 'Session cache TTL is 30 minutes', body: BODY('30') };
const NEW = { title: 'Session cache TTL is 15 minutes', body: BODY('15') };
const TWIN = {
  title: 'We set the session cache TTL to 30 minutes',
  body: 'Decision: session cache TTL in the gateway is 30 minutes, configured in config/cache.yaml (session.ttl).',
};

async function project(): Promise<string> {
  const cwd = await makeTempProject();
  await runCli(['init', '--cwd', cwd, '--no-interactive', '--no-install-hooks']);
  return cwd;
}

/** A pre-existing cross-type twin stating the old value, then the correction 30 -> 15. */
async function twinThenCorrection(): Promise<{ cwd: string; twinId: string; oldId: string; survivorId: string }> {
  const cwd = await project();
  const twin = runRemember('decision', TWIN.title, { cwd, body: TWIN.body, source: 'agent-a' });
  const old = runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-a' });
  const survivorId = runSupersede(old.id, { cwd, reason: 'lowered', title: NEW.title, body: NEW.body, source: 'agent-a' }).survivor_id;
  return { cwd, twinId: twin.id, oldId: old.id, survivorId };
}

/** The correction 30 -> 15 with no old-value twin. */
async function correctionOnly(): Promise<{ cwd: string; survivorId: string }> {
  const cwd = await project();
  const old = runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-a' });
  const survivorId = runSupersede(old.id, { cwd, reason: 'lowered', title: NEW.title, body: NEW.body, source: 'agent-a' }).survivor_id;
  return { cwd, survivorId };
}

function activeIds(cwd: string): string[] {
  return new MemspecStore(cwd).loadActive().map((i) => i.id).sort();
}

test('D: the twin sits under the threshold against the rejected record (why the lexical scan alone misses it)', () => {
  assert.ok(claimSimilarity(TWIN, OLD) < CLAIM_SIMILARITY_THRESHOLD);
});

test('D: merging the current-value survivor into a record stating the rejected value is refused over MCP', async () => {
  const { cwd, twinId, survivorId } = await twinThenCorrection();
  const before = activeIds(cwd);
  assert.throws(
    () => runSupersede(twinId, { cwd, reason: 'consolidating duplicates', mergeFrom: [survivorId], source: 'agent-b', ...MCP }),
    (e: Error) => /supersede refuses rejected value/.test(e.message) && /final over MCP/.test(e.message) && /30/.test(e.message),
  );
  assert.deepEqual(activeIds(cwd), before, 'nothing archived');
  assert.equal(new MemspecStore(cwd).findById(survivorId)!.state, 'active');
  // The current value stays the chain's active end: restating it is a plain near-duplicate of S.
  assert.throws(
    () => runRemember('fact', NEW.title, { cwd, body: NEW.body, source: 'agent-c', ...MCP }),
    /near-duplicate/,
  );
});

test('D: on the CLI the merge refuses without --allow-rejected, and with it writes and logs on the survivor', async () => {
  const { cwd, twinId, oldId, survivorId } = await twinThenCorrection();
  assert.throws(
    () => runSupersede(twinId, { cwd, reason: 'consolidating', mergeFrom: [survivorId], source: 'agent-b' }),
    /--allow-rejected/,
  );
  const res = runSupersede(twinId, { cwd, reason: 'consolidating', mergeFrom: [survivorId], source: 'human:op', allowRejected: true });
  assert.match(res.message, /--allow-rejected/);
  const twin = new MemspecStore(cwd).findById(twinId)!;
  const log = twin.ext?.rejected_value_overrides as Array<Record<string, unknown>>;
  assert.equal(log.length, 1);
  assert.equal(log[0].id, oldId);
  assert.deepEqual(log[0].removed_values, ['30']);
  assert.equal(new MemspecStore(cwd).findById(survivorId)!.ext?.supersede_kind, 'merge');
});

test('D: a merge that keeps the current value still works (twin of S into S, S into a twin stating 15)', async () => {
  const { cwd, survivorId } = await correctionOnly();
  const twin15 = runRemember('decision', 'We set the session cache TTL to 15 minutes', {
    cwd, body: 'Decision: session cache TTL in the gateway is 15 minutes, configured in config/cache.yaml (session.ttl).', source: 'agent-a',
  });
  // S into the 15-minute twin: the correction's place moves to a record holding the current value.
  const merged = runSupersede(twin15.id, { cwd, reason: 'consolidating', mergeFrom: [survivorId], source: 'agent-b', ...MCP });
  assert.deepEqual(merged.superseded_ids, [survivorId]);
  // And the other direction in a fresh store: a 15-minute twin into S.
  const fresh = await correctionOnly();
  const twinB = runRemember('decision', 'We set the session cache TTL to 15 minutes', {
    cwd: fresh.cwd, body: 'Decision: session cache TTL in the gateway is 15 minutes, configured in config/cache.yaml (session.ttl).', source: 'agent-a',
  });
  const back = runSupersede(fresh.survivorId, { cwd: fresh.cwd, reason: 'consolidating', mergeFrom: [twinB.id], source: 'agent-b', ...MCP });
  assert.equal(back.survivor_id, fresh.survivorId);
});

async function mcpOpen(cwd: string, env?: NodeJS.ProcessEnv): Promise<McpSession> {
  const s = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', cwd], env);
  await s.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'round3', version: '0.0.0' } });
  s.notify('notifications/initialized', {});
  return s;
}

async function mcpCall(session: McpSession, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const r = await session.request('tools/call', { name, arguments: args });
  const res = r.result as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: res.isError === true, text: res.content[0].text };
}

test('MCP-D: memspec_supersede merge_from of the survivor into the old-value twin is refused', async () => {
  const { cwd, twinId, survivorId } = await twinThenCorrection();
  const session = await mcpOpen(cwd);
  try {
    const r = await mcpCall(session, 'memspec_supersede', { id: twinId, reason: 'consolidating duplicates', merge_from: [survivorId], source: 'agent-b', allow_rejected: true });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /rejected value/);
  } finally {
    await session.close();
  }
  assert.equal(new MemspecStore(cwd).findById(survivorId)!.state, 'active');
});

/** The documented two-layer template: a writable global layer and the project layer. */
async function twoLayers(): Promise<{ home: string; proj: string; survivorId: string }> {
  const home = await makeTempProject();
  const proj = await makeTempProject();
  await runCli(['init', '--cwd', home, '--no-interactive', '--no-install-hooks']);
  await runCli(['init', '--cwd', proj, '--no-interactive', '--no-install-hooks']);
  writeFileSync(join(proj, '.memspec', 'config.yaml'), [
    'stores:', '  - name: global', `    path: ${join(home, '.memspec')}`, '    priority: 0', '    writable: true',
    '  - name: project', '    path: .memspec', '    priority: 10', '    writable: true', '',
  ].join('\n'));
  const old = runRemember('fact', OLD.title, { cwd: proj, body: OLD.body, source: 'agent-a' });
  const survivorId = runSupersede(old.id, { cwd: proj, reason: 'lowered', title: NEW.title, body: NEW.body, source: 'agent-a' }).survivor_id;
  return { home, proj, survivorId };
}

test('E: remember into another writable layer cannot re-assert a value rejected in the project layer', async () => {
  const { home, proj } = await twoLayers();
  assert.throws(
    () => runRemember('fact', OLD.title, { cwd: proj, body: OLD.body, source: 'agent-b', store: 'global', storeRoot: home, ...MCP }),
    /remember refuses rejected value/,
  );
  assert.throws(
    () => runRemember('fact', OLD.title, { cwd: proj, body: OLD.body, source: 'agent-b', store: 'global', storeRoot: home }),
    /--allow-rejected/,
  );
  assert.deepEqual(searchPayload('session cache TTL', { cwd: proj }).results.map((x: { title: string }) => x.title), [NEW.title]);
});

test('E: a supersede replacement written in one layer is judged against the other layer\'s archive', async () => {
  const { home, proj } = await twoLayers();
  const z = runRemember('fact', 'Build runner uses 4 vCPU', { cwd: proj, body: 'CI runners are provisioned with 4 vCPU and 16 GB of memory per job.', source: 'agent-b', store: 'global', storeRoot: home });
  assert.throws(
    () => runSupersede(z.id, { cwd: proj, reason: 'repurpose', title: OLD.title, body: OLD.body, source: 'agent-b', ...MCP }),
    /supersede refuses rejected value/,
  );
});

test('MCP-E: memspec_remember store=global on the two-layer template is refused', async () => {
  const { home, proj } = await twoLayers();
  const session = await mcpOpen(proj, { HOME: home });
  try {
    const r = await mcpCall(session, 'memspec_remember', { type: 'fact', title: OLD.title, body: OLD.body, source: 'agent-b', store: 'global' });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /rejected value/);
  } finally {
    await session.close();
  }
  assert.deepEqual(new MemspecStore(home).loadActive().map((i) => i.title), []);
});

test('place transfer: a dream-style merge whose summary mentions the removed number for an unrelated reason is written', async () => {
  const { cwd, survivorId } = await correctionOnly();
  const redis = runRemember('fact', 'Gateway Redis cluster runs three nodes', {
    cwd, body: 'The gateway Redis cluster runs three nodes behind a sentinel pair; failover is automatic.', source: 'agent-a',
  });
  const probe = runRemember('fact', 'Gateway health check interval', {
    cwd, body: 'The gateway health check runs every 30 seconds against /healthz on each pod.', source: 'agent-a',
  });
  const result = runSupersede(redis.id, {
    cwd, reason: 'dream consolidation', source: 'agent-dream', ...MCP,
    title: 'Gateway runtime facts',
    body: 'The gateway Redis cluster runs three nodes behind a sentinel pair. The health check runs every 30 seconds against /healthz. Session cache entries expire after 15 minutes.',
    mergeFrom: [survivorId, probe.id],
  });
  assert.equal(new MemspecStore(cwd).findById(result.survivor_id)!.state, 'active');
});
