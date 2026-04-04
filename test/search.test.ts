import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

test('search ranks exact phrase matches higher than scattered term matches', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  // Both items have all three terms in the title, but only the first has them adjacent in order
  await runCli(['add', 'decision', 'Use files over DB', '--cwd', target, '--body', 'Flat file storage decision', '--source', 'test']);
  await runCli(['add', 'fact', 'DB backup files over NFS', '--cwd', target, '--body', 'Network file shares for backups', '--source', 'test']);

  const result = await runCli(['search', 'files over db', '--cwd', target, '--json']);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.length === 2);
  // The item with adjacent phrase "files over DB" must rank first
  assert.equal(parsed[0].title, 'Use files over DB');
  assert.equal(parsed[1].title, 'DB backup files over NFS');
});

test('search honors the default retrieval profile from config.yaml', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  await writeFile(
    join(target, '.memspec', 'config.yaml'),
    `classification:
  llm: false
  fallback: rules

decay:
  fact: 90d
  decision: 180d
  procedure: 90d
  observation: 7d

profiles:
  default:
    max_tokens: 2000
    types: [decision]
    min_confidence: 0.8
    ranking:
      relevance: 1
      confidence: 0
      recency: 0
`,
  );

  await runCli(['add', 'fact', 'JWT auth tokens', '--cwd', target, '--body', 'Uses refresh tokens', '--source', 'test']);
  await runCli(['add', 'decision', 'Adopt JWT auth', '--cwd', target, '--body', 'JWT over sessions', '--source', 'test']);

  const decisionFiles = join(target, '.memspec', 'memory', 'decisions');
  const [decisionFile] = await readdir(decisionFiles);
  const decisionPath = join(decisionFiles, decisionFile);
  const decisionContent = await readFile(decisionPath, 'utf8');
  await writeFile(
    decisionPath,
    decisionContent.replace('confidence: 0.7', 'confidence: 0.85'),
  );

  const result = await runCli(['search', 'JWT', '--cwd', target]);
  assert.match(result.stdout, /Adopt JWT auth/);
  assert.doesNotMatch(result.stdout, /JWT auth tokens/);
});
