import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempProject, runCli } from './helpers.js';

test('context returns empty section when no memories exist', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);

  const result = await runCli(['context', '--cwd', target]);
  assert.match(result.stdout, /## Active project memory/);
  assert.match(result.stdout, /No active memories/);
});

test('context returns markdown section listing active memories', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  await runCli(['add', 'fact', 'Auth uses JWT', '--cwd', target, '--body', 'JWT with 15min expiry', '--source', 'test']);
  await runCli(['add', 'decision', 'Chose REST', '--cwd', target, '--body', 'REST over GraphQL for simplicity', '--source', 'test']);

  const result = await runCli(['context', '--cwd', target]);
  assert.match(result.stdout, /## Active project memory/);
  // Each line carries id, type, source kind, and a witness marker so booted
  // memories are immediately actionable.
  assert.match(result.stdout, /- ms_[0-9A-HJKMNP-TV-Z]{26} fact \[agent\] ✓0d: Auth uses JWT — JWT with 15min expiry/);
  assert.match(result.stdout, /- ms_[0-9A-HJKMNP-TV-Z]{26} decision \[agent\] ✓0d: Chose REST — REST over GraphQL/);
});

test('context marks anchored memories with the anchor witness', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { readdir } = await import('node:fs/promises');
  const { join: joinPath } = await import('node:path');
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  await writeFile(joinPath(target, 'auth.py'), 'argon2id\n');
  await runCli(['add', 'fact', 'Anchored fact', '--cwd', target, '--body', 'auth backend', '--source', 'test']);
  const entries = await readdir(joinPath(target, '.memspec', 'memory', 'facts'));
  const id = entries[0].replace(/\.md$/, '');
  await runCli(['anchor', id, 'auth.py', '--cwd', target]);

  const result = await runCli(['context', '--cwd', target]);
  assert.match(result.stdout, /\[agent\] ⚓: Anchored fact/);
});

test('context --format json emits an array of items', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  await runCli(['add', 'fact', 'Item one', '--cwd', target, '--body', 'Body one', '--source', 'test']);

  const result = await runCli(['context', '--cwd', target, '--format', 'json']);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, 'Item one');
  assert.equal(parsed[0].type, 'fact');
});

test('context --format json on empty store returns []', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);

  const result = await runCli(['context', '--cwd', target, '--format', 'json']);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed, []);
});

test('context --limit caps the number of items emitted', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  for (let i = 0; i < 5; i++) {
    await runCli([
      'add', 'fact', `Fact ${i}`,
      '--cwd', target,
      '--body', `body ${i}`,
      '--source', 'test',
    ]);
  }

  const result = await runCli(['context', '--cwd', target, '--limit', '2', '--format', 'json']);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 2);
});

test('context respects --budget (tight budget drops items)', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  // Each item body is ~80 chars; with budget=30 tokens (~120 chars) only
  // a small handful should fit.
  const longBody = 'x'.repeat(300);
  for (let i = 0; i < 10; i++) {
    await runCli([
      'add', 'fact', `Long fact ${i}`,
      '--cwd', target,
      '--body', longBody,
      '--source', 'test',
    ]);
  }

  const result = await runCli(['context', '--cwd', target, '--budget', '50', '--format', 'json']);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.length < 10, `expected fewer than 10 items, got ${parsed.length}`);
  assert.ok(parsed.length >= 1, 'expected at least 1 item to fit');
});

test('context --type filters by memory type', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  await runCli(['add', 'fact', 'A fact', '--cwd', target, '--body', 'fact body', '--source', 'test']);
  await runCli(['add', 'decision', 'A decision', '--cwd', target, '--body', 'decision body', '--source', 'test']);

  const result = await runCli(['context', '--cwd', target, '--type', 'decision', '--format', 'json']);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, 'decision');
});

test('context --query routes through store.search', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  await runCli(['add', 'fact', 'JWT auth tokens', '--cwd', target, '--body', 'JWT details', '--source', 'test']);
  await runCli(['add', 'fact', 'Database is Postgres', '--cwd', target, '--body', 'Postgres 16', '--source', 'test']);

  const result = await runCli(['context', '--cwd', target, '--query', 'JWT']);
  assert.match(result.stdout, /JWT auth tokens/);
  assert.doesNotMatch(result.stdout, /Postgres/);
});

test('context truncates very long bodies in markdown output', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  const longBody = 'x'.repeat(500);
  await runCli(['add', 'fact', 'Long body', '--cwd', target, '--body', longBody, '--source', 'test']);

  const result = await runCli(['context', '--cwd', target]);
  // The truncation indicator should be present and the full 500-char body
  // should NOT appear verbatim.
  assert.ok(!result.stdout.includes('x'.repeat(500)), 'full body should not appear verbatim');
  assert.match(result.stdout, /…/);
});

test('context returns empty section when store does not exist', async () => {
  const target = await makeTempProject();
  // No init — the .memspec dir does not exist.

  const result = await runCli(['context', '--cwd', target]);
  assert.match(result.stdout, /## Active project memory/);
  assert.match(result.stdout, /No active memories/);
});
