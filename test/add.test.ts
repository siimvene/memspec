import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeTempProject, readText, runCli } from './helpers.js';

test('add creates a fact file with required frontmatter fields', async () => {
  const repoRoot = '/tmp/memspec-12872';
  const target = await makeTempProject();

  await runCli(['init', '--cwd', target], repoRoot);
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
  ], repoRoot);

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
  const repoRoot = '/tmp/memspec-12872';
  const target = await makeTempProject();

  await runCli(['init', '--cwd', target], repoRoot);
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
  ], repoRoot);

  const decisionsDir = join(target, '.memspec', 'memory', 'decisions');
  const entries = await readdir(decisionsDir);
  assert.equal(entries.length, 1);

  const content = await readText(join(decisionsDir, entries[0]));
  const parsed = matter(content);
  assert.equal(parsed.data.decay_after, 'never');
});
