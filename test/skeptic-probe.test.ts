import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runRemember } from '../src/commands/remember.js';
import { runSupersede } from '../src/commands/supersede.js';
import { CLAIM_SIMILARITY_THRESHOLD, claimSimilarity } from '../src/lib/similarity.js';
import { MemspecStore } from '../src/lib/store.js';
import { McpSession } from './mcp-session.js';
import { makeTempProject, REPO_ROOT, runCli } from './helpers.js';

/**
 * Regression: the skeptic's probes against the round-1 tombstone. Each one
 * wrote a rejected value back over MCP with no override log: re-typing it,
 * declaring distinct_from the survivor with a realistic multi-sentence body
 * (old ~ survivor >= 0.65 is normal for a value change), and superseding an
 * unrelated record with the rejected value as the replacement body.
 */

async function project(): Promise<string> {
  const cwd = await makeTempProject();
  await runCli(['init', '--cwd', cwd]);
  return cwd;
}

// Realistic-length claim: one number changes between OLD and NEW.
const BODY = (ttl: string) =>
  `Session cache entries in the gateway expire after ${ttl} minutes. The TTL is set in config/cache.yaml under session.ttl and applies to every pod in the cluster; changing it requires a rolling restart of the gateway deployment.`;
const OLD = { title: 'Session cache TTL is 30 minutes', body: BODY('30') };
const NEW = { title: 'Session cache TTL is 15 minutes', body: BODY('15') };

async function rejected(): Promise<{ cwd: string; oldId: string; survivorId: string }> {
  const cwd = await project();
  const old = runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-a' });
  const survivorId = runSupersede(old.id, { cwd, reason: 'lowered', title: NEW.title, body: NEW.body, source: 'agent-a' }).survivor_id;
  return { cwd, oldId: old.id, survivorId };
}

function activeIds(cwd: string): string[] {
  return new MemspecStore(cwd).loadActive().map((i) => i.id).sort();
}

const refusedAsRejected = (oldId: string, verb = 'remember') =>
  new RegExp(`${verb} refuses rejected value: this value was rejected in ${oldId} .*final over MCP`);

test('probe A: a realistic value change keeps old ~ survivor above the threshold', () => {
  const score = claimSimilarity(OLD, NEW);
  assert.ok(score >= CLAIM_SIMILARITY_THRESHOLD, `old~new ${score.toFixed(2)}`);
});

test('probe B: re-typing the rejected value (long body) is refused over MCP', async () => {
  const { cwd, oldId, survivorId } = await rejected();
  assert.throws(() => runRemember('decision', OLD.title, { cwd, body: OLD.body, source: 'agent-b', channel: 'mcp' }), refusedAsRejected(oldId));
  assert.deepEqual(activeIds(cwd), [survivorId]);
});

test('probe C: same type + distinct_from the survivor (long body) is refused over MCP', async () => {
  const { cwd, oldId, survivorId } = await rejected();
  for (const edge of ['distinctFrom', 'refines', 'supports', 'dependsOn'] as const) {
    assert.throws(
      () => runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-b', channel: 'mcp', [edge]: [survivorId] }),
      refusedAsRejected(oldId),
    );
  }
  assert.deepEqual(activeIds(cwd), [survivorId]);
});

test('probe D: superseding an unrelated record with the rejected value as the body is refused over MCP', async () => {
  const { cwd, oldId, survivorId } = await rejected();
  const x = runRemember('fact', 'Build runner uses 4 vCPU', { cwd, body: 'CI runners are provisioned with 4 vCPU and 16 GB.', source: 'agent-b' });
  assert.throws(
    () => runSupersede(x.id, { cwd, reason: 'wrong', title: OLD.title, body: OLD.body, source: 'agent-b', channel: 'mcp', allowRejected: true }),
    refusedAsRejected(oldId, 'supersede'),
  );
  assert.deepEqual(activeIds(cwd), [survivorId, x.id].sort(), 'the unrelated record is untouched');
  // CLI --allow-rejected writes it and logs the override on the replacement.
  const written = runSupersede(x.id, { cwd, reason: 'operator restores the old TTL', title: OLD.title, body: OLD.body, source: 'human:op', channel: 'cli', allowRejected: true });
  const log = new MemspecStore(cwd).findById(written.survivor_id)!.ext?.rejected_value_overrides as Array<Record<string, unknown>>;
  assert.equal(log[0].id, oldId);
  assert.deepEqual(log[0].removed_values, ['30']);
  assert.match(written.message, /--allow-rejected/);
});

test('probe E: the short fixture re-typed is refused', async () => {
  const cwd = await project();
  const o = { title: 'Session cache TTL is 30 minutes', body: 'Session cache entries expire after 30 minutes.' };
  const n = { title: 'Session cache TTL is 15 minutes', body: 'Session cache entries expire after 15 minutes.' };
  const old = runRemember('fact', o.title, { cwd, body: o.body, source: 'agent-a' });
  runSupersede(old.id, { cwd, reason: 'lowered', title: n.title, body: n.body, source: 'agent-a' });
  assert.throws(() => runRemember('decision', o.title, { cwd, body: o.body, source: 'agent-b', channel: 'mcp' }), refusedAsRejected(old.id));
});

test('probe D through the memspec_supersede MCP tool: refused, final', async () => {
  const { cwd, oldId } = await rejected();
  const x = runRemember('fact', 'Build runner uses 4 vCPU', { cwd, body: 'CI runners are provisioned with 4 vCPU and 16 GB.', source: 'agent-b' });
  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', cwd]);
  try {
    await session.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'memspec-test', version: '0.0.0' } });
    session.notify('notifications/initialized', {});
    const call = await session.request('tools/call', {
      name: 'memspec_supersede',
      arguments: { id: x.id, reason: 'wrong', title: OLD.title, body: OLD.body, source: 'agent-b', allow_rejected: true },
    });
    const result = call.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, refusedAsRejected(oldId, 'supersede'));
  } finally {
    await session.close();
  }
  assert.equal(new MemspecStore(cwd).findById(x.id)!.state, 'active');
});
