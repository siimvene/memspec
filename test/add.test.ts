import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeTempProject, readText, runCli } from './helpers.js';

test('add creates a fact file with required frontmatter fields', async () => {
  const target = await makeTempProject();

  await runCli(['init', '--cwd', target]);
  await runCli([
    'add',
    'fact',
    'JWT auth',
    '--cwd',
    target,
    '--body',
    'JWT with refresh tokens',
    '--source',
    'test',
    '--tags',
    'auth,api',
  ]);

  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const entries = await readdir(factsDir);
  assert.equal(entries.length, 1);

  const content = await readText(join(factsDir, entries[0]));
  const parsed = matter(content);

  assert.match(parsed.data.id, /^ms_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(parsed.data.type, 'fact');
  assert.equal(parsed.data.state, 'active');
  assert.equal(parsed.data.source, 'test');
  assert.deepEqual(parsed.data.tags, ['auth', 'api']);
  assert.match(parsed.data.decay_after, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(parsed.content, /JWT with refresh tokens/);
});

test('add accepts never as an explicit decay override', async () => {
  const target = await makeTempProject();

  await runCli(['init', '--cwd', target]);
  await runCli([
    'add',
    'decision',
    'Use native iOS',
    '--cwd',
    target,
    '--body',
    'WebKit keyboard limitations block the PWA path',
    '--source',
    'test',
    '--decay-after',
    'never',
  ]);

  const decisionsDir = join(target, '.memspec', 'memory', 'decisions');
  const entries = await readdir(decisionsDir);
  assert.equal(entries.length, 1);

  const content = await readText(join(decisionsDir, entries[0]));
  const parsed = matter(content);
  assert.equal(parsed.data.decay_after, 'never');
});

test('add rejects unsupported memory type', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  await assert.rejects(
    () => runCli(['add', 'rule', 'No secrets', '--cwd', target]),
    (error: Error & { stderr?: string }) => {
      const output = `${error.message}\n${error.stderr ?? ''}`;
      assert.match(output, /Unsupported memory type/);
      return true;
    },
  );
});

test('add uses decay defaults from config.yaml', async () => {
  const target = await makeTempProject();

  await runCli(['init', '--cwd', target]);
  await writeFile(
    join(target, '.memspec', 'config.yaml'),
    `classification:
  llm: false
  fallback: rules

decay:
  fact: 1d
  decision: 180d
  procedure: 90d
  observation: 7d

profiles:
  default:
    max_tokens: 2000
    types: [fact, decision, procedure]
    min_confidence: 0.7
    ranking:
      relevance: 0.4
      confidence: 0.3
      recency: 0.3
`,
  );

  await runCli([
    'add',
    'fact',
    'Config driven TTL',
    '--cwd',
    target,
    '--body',
    'Should expire roughly one day after creation',
    '--source',
    'test',
  ]);

  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const entries = await readdir(factsDir);
  assert.equal(entries.length, 1);

  const content = await readText(join(factsDir, entries[0]));
  const parsed = matter(content);

  const created = Date.parse(String(parsed.data.created));
  const decayAfter = Date.parse(String(parsed.data.decay_after));
  const dayMs = 24 * 60 * 60 * 1000;

  assert.ok(Number.isFinite(created));
  assert.ok(Number.isFinite(decayAfter));
  assert.ok(decayAfter - created < 2 * dayMs, 'expected config TTL to be near 1 day');
});
