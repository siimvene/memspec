import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import matter from 'gray-matter';
import { runRemember } from '../src/commands/remember.js';
import { runRelate, runUnrelate } from '../src/commands/relate.js';
import { makeTempProject, readText, runCli } from './helpers.js';

async function readData(target: string, subdir: string, id: string): Promise<Record<string, unknown>> {
  const path = join(target, '.memspec', 'memory', subdir, `${id}.md`);
  return matter(await readText(path)).data as Record<string, unknown>;
}

test('unrelate removes a conflicts_with edge, clears its provenance, and logs the removal', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const other = runRemember('fact', 'Sessions expire after 24 hours', {
    cwd: target, body: 'a', source: 'agent-a', tags: 'auth',
  });
  const child = runRemember('fact', 'Sessions expire after 1 hour', {
    cwd: target, body: 'b', source: 'agent-b', tags: 'auth', conflictsWith: [other.id],
  });

  const result = runUnrelate({
    cwd: target, from: child.id, to: other.id, type: 'conflicts_with',
    reason: 'not actually contradictory', source: 'agent-b',
  });
  assert.equal(result.removed, true);
  assert.equal(result.total_edges_of_type, 0);

  const data = await readData(target, 'facts', child.id);
  assert.equal(data.conflicts_with, undefined, 'edge removed (empty array omitted)');
  const ext = data.ext as Record<string, unknown>;
  assert.equal(ext.edge_sources, undefined, 'provenance mark dropped with the edge');
  const removals = ext.edge_removals as Array<Record<string, unknown>>;
  assert.equal(removals.length, 1);
  assert.equal(removals[0].to, other.id);
  assert.equal(removals[0].type, 'conflicts_with');
  assert.equal(removals[0].removed_by, 'agent-b');
  assert.equal(removals[0].reason, 'not actually contradictory');
  assert.ok(removals[0].removed_at, 'timestamp recorded');
});

test('unrelate on an absent edge is a reported no-op', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const a = runRemember('fact', 'A claim', { cwd: target, body: 'a', source: 'agent-a' });
  const b = runRemember('fact', 'B claim', { cwd: target, body: 'b', source: 'agent-a' });

  const result = runUnrelate({
    cwd: target, from: a.id, to: b.id, type: 'conflicts_with', reason: 'cleanup',
  });
  assert.equal(result.removed, false);
  assert.match(result.message, /no-op/);

  const data = await readData(target, 'facts', a.id);
  assert.equal(data.edge_removals, undefined, 'a no-op must not log a removal');
});

test('unrelate removes positive edge types too', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const parent = runRemember('fact', 'Parent claim', { cwd: target, body: 'p', source: 'agent-a' });
  const child = runRemember('fact', 'Child claim', {
    cwd: target, body: 'c', source: 'agent-a', refines: [parent.id],
  });

  const result = runUnrelate({
    cwd: target, from: child.id, to: parent.id, type: 'refines', reason: 'mis-linked',
  });
  assert.equal(result.removed, true);

  const data = await readData(target, 'facts', child.id);
  assert.equal(data.refines, undefined);
});

test('unrelate refuses operator-sourced records without override, allows with it', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const op = runRemember('fact', 'Operator claim', {
    cwd: target, body: 'o', source: 'human:siim', tags: 'infra',
  });
  const to = runRemember('fact', 'Some other claim', { cwd: target, body: 't', source: 'agent-a' });
  runRelate({ cwd: target, from: op.id, to: to.id, type: 'conflicts_with' });

  assert.throws(
    () => runUnrelate({ cwd: target, from: op.id, to: to.id, type: 'conflicts_with', reason: 'x' }),
    /operator-sourced/,
  );

  const result = runUnrelate({
    cwd: target, from: op.id, to: to.id, type: 'conflicts_with',
    reason: 'confirmed non-conflict', source: 'human:siim', overrideOperator: true,
  });
  assert.equal(result.removed, true);
  assert.match(result.message, /override_operator used/);

  const data = await readData(target, 'operator/facts', op.id);
  const removals = (data.ext as Record<string, unknown>).edge_removals as Array<Record<string, unknown>>;
  assert.match(String(removals[0].reason), /override_operator used on operator-sourced record/);
});

test('unrelate requires a reason', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const a = runRemember('fact', 'A', { cwd: target, body: 'a', source: 'agent-a' });
  const b = runRemember('fact', 'B', { cwd: target, body: 'b', source: 'agent-a' });
  runRelate({ cwd: target, from: a.id, to: b.id, type: 'conflicts_with' });

  assert.throws(
    () => runUnrelate({ cwd: target, from: a.id, to: b.id, type: 'conflicts_with', reason: '' }),
    /requires --reason/,
  );
});

test('CLI: memspec unrelate removes an edge', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const a = runRemember('fact', 'Alpha', { cwd: target, body: 'a', source: 'agent-a' });
  const b = runRemember('fact', 'Beta', { cwd: target, body: 'b', source: 'agent-a' });
  runRelate({ cwd: target, from: a.id, to: b.id, type: 'conflicts_with' });

  const { stdout } = await runCli([
    'unrelate', '--cwd', target, '--from', a.id, '--to', b.id,
    '--type', 'conflicts_with', '--reason', 'cli removal', '--source', 'agent-a',
  ]);
  assert.match(stdout, /Removed/);

  const data = await readData(target, 'facts', a.id);
  assert.equal(data.conflicts_with, undefined);
});

test('relate stamps asserted provenance on conflicts_with edges', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const a = runRemember('fact', 'Alpha claim', { cwd: target, body: 'a', source: 'agent-a' });
  const b = runRemember('fact', 'Beta claim', { cwd: target, body: 'b', source: 'agent-a' });
  runRelate({ cwd: target, from: a.id, to: b.id, type: 'conflicts_with' });

  const data = await readData(target, 'facts', a.id);
  const ext = data.ext as Record<string, unknown>;
  assert.equal((ext.edge_sources as Record<string, string>)[b.id], 'asserted');
});
