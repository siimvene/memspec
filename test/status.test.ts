import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempProject, runCli } from './helpers.js';

test('status shows empty store summary', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const result = await runCli(['status', '--cwd', target]);
  assert.match(result.stdout, /Memspec Store/);
  assert.match(result.stdout, /fact/);
  assert.match(result.stdout, /decision/);
  assert.match(result.stdout, /procedure/);
  assert.match(result.stdout, /total\s+0/);
});

test('status counts active items by type', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli(['add', 'fact', 'Fact one', '--cwd', target, '--source', 'test']);
  await runCli(['add', 'fact', 'Fact two', '--cwd', target, '--source', 'test']);
  await runCli(['add', 'decision', 'Dec one', '--cwd', target, '--source', 'test']);

  const result = await runCli(['status', '--cwd', target]);
  assert.match(result.stdout, /fact\s+2/);
  assert.match(result.stdout, /decision\s+1/);
  assert.match(result.stdout, /total\s+3/);
});
