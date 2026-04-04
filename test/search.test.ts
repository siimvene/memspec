import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempProject, runCli } from './helpers.js';

test('search finds items by title keyword', async () => {
  const target = await makeTempProject();

  await runCli(['init', '--cwd', target]);
  await runCli(['add', 'fact', 'JWT auth tokens', '--cwd', target, '--body', 'Uses refresh tokens', '--source', 'test', '--tags', 'auth']);
  await runCli(['add', 'fact', 'Database is Postgres', '--cwd', target, '--body', 'Postgres 16', '--source', 'test', '--tags', 'db']);

  const result = await runCli(['search', 'JWT', '--cwd', target]);
  assert.match(result.stdout, /JWT auth tokens/);
  assert.doesNotMatch(result.stdout, /Postgres/);
});

test('search returns no results message for unknown query', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const result = await runCli(['search', 'nonexistent', '--cwd', target]);
  assert.match(result.stdout, /No results/);
});

test('search --json returns valid JSON', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli(['add', 'decision', 'Use REST', '--cwd', target, '--body', 'REST over GraphQL', '--source', 'test']);

  const result = await runCli(['search', 'REST', '--cwd', target, '--json']);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, 'decision');
});

test('search --type filters by memory type', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli(['add', 'fact', 'Auth uses JWT', '--cwd', target, '--body', 'JWT tokens', '--source', 'test']);
  await runCli(['add', 'decision', 'Chose JWT auth', '--cwd', target, '--body', 'JWT over sessions', '--source', 'test']);

  const result = await runCli(['search', 'JWT', '--cwd', target, '--type', 'fact']);
  assert.match(result.stdout, /Auth uses JWT/);
  assert.doesNotMatch(result.stdout, /Chose JWT/);
});

test('search applies type filtering before the result limit', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli(['add', 'decision', 'JWT', '--cwd', target, '--body', 'Short title wins score', '--source', 'test']);
  await runCli(['add', 'fact', 'JWT deployment secret', '--cwd', target, '--body', 'Contains the same keyword', '--source', 'test']);

  const result = await runCli(['search', 'JWT', '--cwd', target, '--type', 'fact', '--limit', '1']);
  assert.match(result.stdout, /JWT deployment secret/);
  assert.doesNotMatch(result.stdout, /No results/);
});

test('search rejects unsupported type filters', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  await assert.rejects(
    () => runCli(['search', 'JWT', '--cwd', target, '--type', 'rule']),
    (error: Error & { stderr?: string }) => {
      const output = `${error.message}\n${error.stderr ?? ''}`;
      assert.match(output, /Unsupported memory type/);
      return true;
    },
  );
});
