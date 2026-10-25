import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runRemember } from '../src/commands/remember.js';
import { MemspecStore } from '../src/lib/store.js';
import { makeTempProject, runCli } from './helpers.js';

/**
 * remember refuses near-duplicates by title + body similarity, not just an
 * identical title: a paraphrase of an active same-type record in scope is
 * refused with the survivor pointer; a different claim on the same topic is
 * written. Fixture pairs mirror test/similarity.test.ts.
 */

async function project(): Promise<string> {
  const cwd = await makeTempProject();
  await runCli(['init', '--cwd', cwd]);
  return cwd;
}

const GATEWAY = {
  title: 'Gateway uses mTLS for upstream authentication',
  body: 'Every upstream call from the gateway presents a client certificate.',
};
const GATEWAY_PARAPHRASE = {
  title: 'The gateway authenticates to upstreams with mTLS',
  body: 'Upstream calls from the gateway present a client certificate (mutual TLS).',
};

test('a paraphrase of an active claim is refused with the survivor pointer', async () => {
  const cwd = await project();
  const first = runRemember('fact', GATEWAY.title, { cwd, body: GATEWAY.body, source: 'agent-a' });

  assert.throws(
    () => runRemember('fact', GATEWAY_PARAPHRASE.title, { cwd, body: GATEWAY_PARAPHRASE.body, source: 'agent-b' }),
    (err: Error) =>
      err.message.startsWith('remember refuses near-duplicate: an active fact making the same claim already exists') &&
      err.message.includes(`${first.id} "${GATEWAY.title}" (similarity `) &&
      err.message.includes('memspec supersede') &&
      err.message.includes('--distinct-from'),
  );
  assert.equal(new MemspecStore(cwd).loadActive().length, 1, 'no twin written');
});

test('the exact-title refusal keeps its message shape', async () => {
  const cwd = await project();
  runRemember('fact', 'Exact twin', { cwd, body: 'one', source: 'agent-a' });
  assert.throws(
    () => runRemember('fact', 'exact   TWIN', { cwd, body: 'two', source: 'agent-a' }),
    /remember refuses near-duplicate: an active fact with the same title already exists/,
  );
});

test('a different claim on the same topic is written (value change, different fact)', async () => {
  const cwd = await project();
  runRemember('fact', 'Session cache TTL is 30 minutes', { cwd, body: 'Session cache entries expire after 30 minutes.', source: 'agent-a' });
  const valueChange = runRemember('fact', 'Session cache TTL is 15 minutes', { cwd, body: 'Session cache entries expire after 15 minutes.', source: 'agent-a' });
  const sameTopic = runRemember('fact', 'Session cache is backed by Redis', { cwd, body: 'Session cache entries live in the shared Redis cluster.', source: 'agent-a' });
  assert.ok(valueChange.id && sameTopic.id);
  assert.equal(new MemspecStore(cwd).loadActive().length, 3);
});

test('near-duplicate refusal is scoped like the exact-title refusal: other types and other scopes do not count', async () => {
  const cwd = await project();
  const configPath = join(cwd, '.memspec', 'config.yaml');
  await writeFile(configPath, `${await readFile(configPath, 'utf8')}\nscopes:\n  alpha: ['/nowhere/alpha']\n  beta: ['/nowhere/beta']\n`, 'utf8');

  runRemember('fact', GATEWAY.title, { cwd, body: GATEWAY.body, source: 'agent-a', scope: 'alpha' });
  // Same claim as a decision: different type, not a twin.
  runRemember('decision', GATEWAY_PARAPHRASE.title, { cwd, body: GATEWAY_PARAPHRASE.body, source: 'agent-a', scope: 'alpha' });
  // Same claim in another project scope: invisible from there, not a twin.
  runRemember('fact', GATEWAY_PARAPHRASE.title, { cwd, body: GATEWAY_PARAPHRASE.body, source: 'agent-a', scope: 'beta' });
  // Same scope, same type: refused.
  assert.throws(
    () => runRemember('fact', GATEWAY_PARAPHRASE.title, { cwd, body: `${GATEWAY_PARAPHRASE.body} Again.`, source: 'agent-a', scope: 'alpha' }),
    /remember refuses near-duplicate/,
  );
});

test('distinct_from records the judgement and lets a lexically close, different claim through', async () => {
  const cwd = await project();
  const staging = runRemember('fact', 'Staging runs Postgres 16', { cwd, body: 'The staging database is Postgres 16.', source: 'agent-a' });

  assert.throws(
    () => runRemember('fact', 'Production runs Postgres 16', { cwd, body: 'The production database is Postgres 16.', source: 'agent-a' }),
    /remember refuses near-duplicate/,
  );
  const prod = runRemember('fact', 'Production runs Postgres 16', {
    cwd, body: 'The production database is Postgres 16.', source: 'agent-a', distinctFrom: [staging.id],
  });
  assert.deepEqual(new MemspecStore(cwd).findById(prod.id)!.distinct_from, [staging.id]);
});

test('a refines child may restate its parent', async () => {
  const cwd = await project();
  const parent = runRemember('fact', GATEWAY.title, { cwd, body: GATEWAY.body, source: 'agent-a' });
  const child = runRemember('fact', GATEWAY_PARAPHRASE.title, {
    cwd, body: GATEWAY_PARAPHRASE.body, source: 'agent-a', refines: [parent.id],
  });
  assert.deepEqual(new MemspecStore(cwd).findById(child.id)!.refines, [parent.id]);
});
