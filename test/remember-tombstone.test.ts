import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runRemember } from '../src/commands/remember.js';
import { runSupersede } from '../src/commands/supersede.js';
import { MemspecStore } from '../src/lib/store.js';
import { McpSession } from './mcp-session.js';
import { makeTempProject, REPO_ROOT, runCli } from './helpers.js';

/**
 * Tombstone: a value a supersede or retraction rejected cannot come back
 * through a fresh `remember`. Derived from the archive records themselves.
 * The refusal names the rejected record, its persisted reason and the
 * survivor; over MCP it is final, on the CLI --allow-rejected overrides and
 * the override is logged into the new record.
 */

const OLD = { title: 'Session cache TTL is 30 minutes', body: 'Session cache entries expire after 30 minutes.' };
const NEW = { title: 'Session cache TTL is 15 minutes', body: 'Session cache entries expire after 15 minutes.' };
const REASON = 'TTL was lowered to 15 minutes in the config rollout';

async function rejectedValueStore(): Promise<{ cwd: string; oldId: string; survivorId: string }> {
  const cwd = await makeTempProject();
  await runCli(['init', '--cwd', cwd]);
  const old = runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-a' });
  const result = runSupersede(old.id, { cwd, reason: REASON, title: NEW.title, body: NEW.body, source: 'agent-a' });
  return { cwd, oldId: old.id, survivorId: result.survivor_id };
}

test('the superseded value written verbatim is refused, naming the rejection, its reason and the survivor', async () => {
  const { cwd, oldId, survivorId } = await rejectedValueStore();
  assert.throws(
    () => runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-b' }),
    (err: Error) =>
      err.message.startsWith('remember refuses rejected value:') &&
      err.message.includes(`this value was rejected in ${oldId} (reason: ${REASON}), superseded by ${survivorId}`) &&
      err.message.includes('--allow-rejected'),
  );
  assert.equal(new MemspecStore(cwd).loadActive().length, 1, 'nothing written');
});

test('a paraphrase of the superseded value is refused', async () => {
  const { cwd, oldId } = await rejectedValueStore();
  assert.throws(
    () => runRemember('fact', 'Cached sessions expire after 30 minutes', { cwd, body: 'The TTL for the session cache is 30 minutes.', source: 'agent-b' }),
    new RegExp(`this value was rejected in ${oldId}`),
  );
});

test('a genuinely new claim on the same topic is written', async () => {
  const { cwd } = await rejectedValueStore();
  const fresh = runRemember('fact', 'Session cache is backed by Redis', { cwd, body: 'Session cache entries live in the shared Redis cluster.', source: 'agent-b' });
  assert.ok(new MemspecStore(cwd).findById(fresh.id));
});

test('a value that also matches the live survivor is not a rejected value', async () => {
  // A wording-only supersede: old and survivor say the same thing, so a claim
  // matching the old record matches the survivor too. The tombstone stands
  // aside; the claim is then judged against the survivor like any active record.
  const cwd = await makeTempProject();
  await runCli(['init', '--cwd', cwd]);
  const old = runRemember('fact', 'Gateway uses mTLS for upstream authentication', {
    cwd, body: 'Every upstream call from the gateway presents a client certificate.', source: 'agent-a',
  });
  const survivor = runSupersede(old.id, {
    cwd, reason: 'wording', title: 'The gateway authenticates to upstreams with mTLS',
    body: 'Upstream calls from the gateway present a client certificate (mutual TLS).', source: 'agent-a',
  }).survivor_id;

  const restated = { title: 'Gateway authenticates upstream calls with mTLS', body: 'Every upstream call from the gateway presents a client certificate.' };
  // Not refused as a rejected value: it is a twin of the active survivor.
  assert.throws(
    () => runRemember('fact', restated.title, { cwd, body: restated.body, source: 'agent-b' }),
    (err: Error) => err.message.startsWith('remember refuses near-duplicate') && err.message.includes(survivor),
  );
  // A refinement of the survivor (declared, so not a twin) is written.
  const child = runRemember('fact', restated.title, { cwd, body: restated.body, source: 'agent-b', refines: [survivor] });
  assert.ok(new MemspecStore(cwd).findById(child.id));
});

test('a retracted value is refused as retracted with no replacement', async () => {
  const cwd = await makeTempProject();
  await runCli(['init', '--cwd', cwd]);
  const old = runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-a' });
  runSupersede(old.id, { cwd, reason: 'the cache was removed', source: 'agent-a' });
  assert.throws(
    () => runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-b' }),
    new RegExp(`rejected in ${old.id} \\(reason: the cache was removed\\), retracted with no replacement`),
  );
});

test('declared edges do not exempt a rejected value', async () => {
  const { cwd, oldId } = await rejectedValueStore();
  assert.throws(
    () => runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-b', distinctFrom: [oldId] }),
    /remember refuses rejected value/,
  );
});

test('CLI --allow-rejected writes the value and logs the override into the new record', async () => {
  const { cwd, oldId, survivorId } = await rejectedValueStore();
  const result = runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'human:op', allowRejected: true, channel: 'cli' });
  assert.match(result.message, /--allow-rejected: written over 1 rejected value/);
  const written = new MemspecStore(cwd).findById(result.id)!;
  const log = written.ext?.rejected_value_overrides as Array<Record<string, unknown>>;
  assert.equal(log.length, 1);
  assert.equal(log[0].id, oldId);
  assert.equal(log[0].reason, REASON);
  assert.equal(log[0].superseded_by, survivorId);
  assert.equal(log[0].overridden_by, 'human:op');
  assert.equal(typeof log[0].overridden_at, 'string');
});

test('MCP channel: the refusal is final, allowRejected is ignored', async () => {
  const { cwd } = await rejectedValueStore();
  assert.throws(
    () => runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-b', allowRejected: true, channel: 'mcp' }),
    /remember refuses rejected value: .*This refusal is final over MCP/,
  );
});

test('CLI wiring: refused without the flag, written with --allow-rejected', async () => {
  const { cwd, oldId } = await rejectedValueStore();
  await assert.rejects(
    runCli(['remember', 'fact', OLD.title, '--cwd', cwd, '--body', OLD.body, '--source', 'human:op']),
    (err: Error & { stderr?: string }) => (err.stderr ?? err.message).includes(`rejected in ${oldId}`),
  );
  const { stdout } = await runCli(['remember', 'fact', OLD.title, '--cwd', cwd, '--body', OLD.body, '--source', 'human:op', '--allow-rejected']);
  assert.match(stdout, /Created fact memory/);
});

test('memspec_remember MCP tool refuses a rejected value', async () => {
  const { cwd, oldId } = await rejectedValueStore();
  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', cwd]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memspec-test', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});
    const call = await session.request('tools/call', {
      name: 'memspec_remember',
      arguments: { type: 'fact', title: OLD.title, body: OLD.body, source: 'agent-b', allow_rejected: true },
    });
    const result = call.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, new RegExp(`rejected in ${oldId}.*final over MCP`));
  } finally {
    await session.close();
  }
});
