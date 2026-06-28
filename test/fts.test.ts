import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempProject, runCli } from './helpers.js';

test('FTS5: stemming finds "configuration" when searching "configured"', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  await runCli(['remember','decision', 'Server configuration approach', '--cwd', target,
    '--body', 'All configuration managed via GitOps', '--source', 'test', '--tags', 'infra']);
  await runCli(['remember','fact', 'Database is Postgres', '--cwd', target,
    '--body', 'Postgres 16 on RDS', '--source', 'test', '--tags', 'db']);

  // "configured" should find "configuration" via stemming (not a substring match)
  const result = await runCli(['search', 'configured', '--cwd', target, '--json']);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.length >= 1, 'stemming should match configured → configuration');
  assert.equal(parsed[0].title, 'Server configuration approach');
});

test('FTS5: word boundaries prevent "file" matching "profile"', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  await runCli(['remember','fact', 'User profile settings', '--cwd', target,
    '--body', 'Profile page shows user preferences', '--source', 'test']);
  await runCli(['remember','fact', 'Config file locations', '--cwd', target,
    '--body', 'File paths for configuration', '--source', 'test']);

  // Searching "file" should find "Config file locations" but NOT "User profile settings"
  const result = await runCli(['search', 'file', '--cwd', target, '--json']);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.length >= 1, 'should find the file item');
  assert.equal(parsed[0].title, 'Config file locations');
  // "profile" should NOT match "file" with word boundaries
  const profileMatch = parsed.find((r: any) => r.title === 'User profile settings');
  assert.equal(profileMatch, undefined, '"file" should not match "profile" via substring');
});

test('FTS5: BM25 ranking outperforms naive keyword scoring on term spam', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  // Item A: focused, specific
  await runCli(['remember','decision', 'Platform engineering strategy', '--cwd', target,
    '--body', 'Adopt GitOps-based platform approach', '--source', 'test', '--tags', 'platform']);

  // Item B: keyword spam
  await runCli(['remember','fact', 'Cloud platforms overview', '--cwd', target,
    '--body', 'AWS platform, GCP platform, Azure platform are all cloud platforms we evaluated. Platform platform platform.', '--source', 'test']);

  const result = await runCli(['search', 'platform engineering', '--cwd', target, '--json']);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.length >= 1);
  assert.equal(parsed[0].title, 'Platform engineering strategy');
});

test('FTS5: existing phrase ranking still works', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  await runCli(['remember','decision', 'Use files over DB', '--cwd', target,
    '--body', 'Flat file storage decision', '--source', 'test']);
  await runCli(['remember','fact', 'DB backup files over NFS', '--cwd', target,
    '--body', 'Network file shares', '--source', 'test']);

  const result = await runCli(['search', 'files over db', '--cwd', target, '--json']);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.length === 2);
  assert.equal(parsed[0].title, 'Use files over DB');
});

test('FTS5: multi-word query with absent terms still finds the best match', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  // Regression for the 2026-06-10 findings: these natural-language queries
  // returned zero results while the bare keyword matched.
  await runCli(['remember','fact', 'Kleidia ICP', '--cwd', target,
    '--body', 'Target customers are defence and government organisations needing YubiKey lifecycle management',
    '--source', 'test', '--tags', 'kleidia,icp']);
  await runCli(['remember','fact', 'Unrelated networking note', '--cwd', target,
    '--body', 'VLAN trunking on the lab switch', '--source', 'test']);

  const result = await runCli(['search', 'Kleidia ICP target customers defence government strategy', '--cwd', target, '--json']);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.length >= 1, 'OR fallback should rescue queries with absent terms');
  assert.equal(parsed[0].title, 'Kleidia ICP');
});

test('FTS5: OR fallback does not dilute exact AND matches', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  await runCli(['remember','fact', 'JWT auth tokens', '--cwd', target,
    '--body', 'Uses refresh tokens', '--source', 'test']);
  await runCli(['remember','fact', 'JWT logging', '--cwd', target,
    '--body', 'Log token ids only', '--source', 'test']);

  // Both terms present in one item: AND must win, the partial match stays out
  const result = await runCli(['search', 'JWT auth', '--cwd', target, '--json']);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 1, 'AND should be tried before falling back to OR');
  assert.equal(parsed[0].title, 'JWT auth tokens');
});

test('FTS5: type filtering works with FTS backend', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  await runCli(['remember','fact', 'JWT tokens', '--cwd', target, '--body', 'Auth tokens', '--source', 'test']);
  await runCli(['remember','decision', 'Chose JWT', '--cwd', target, '--body', 'JWT decision', '--source', 'test']);

  const result = await runCli(['search', 'JWT', '--cwd', target, '--type', 'fact', '--json']);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, 'fact');
});
