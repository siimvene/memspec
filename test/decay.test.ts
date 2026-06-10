import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeTempProject, readText, runCli } from './helpers.js';

test('decay moves expired items into archive with decayed state', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli([
    'add',
    'procedure',
    'Restart gateway',
    '--cwd',
    target,
    '--body',
    'Run systemctl restart openclaw-gateway',
    '--source',
    'test',
    '--decay-after',
    '2000-01-01T00:00:00.000Z',
  ]);

  const result = await runCli(['decay', '--cwd', target]);
  assert.match(result.stdout, /Decayed 1 item/);

  const proceduresDir = join(target, '.memspec', 'memory', 'procedures');
  assert.equal((await readdir(proceduresDir)).length, 0);

  const archiveDir = join(target, '.memspec', 'archive');
  const archiveEntries = await readdir(archiveDir);
  assert.equal(archiveEntries.length, 1);

  const archivedContent = await readText(join(archiveDir, archiveEntries[0]));
  const archived = matter(archivedContent);
  assert.equal(archived.data.state, 'decayed');
  assert.match(archived.content, /Restart gateway/);
});

test('decay --archive moves expired items into archive with archived state', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli([
    'add',
    'fact',
    'Old port',
    '--cwd',
    target,
    '--body',
    'Service listens on 7779',
    '--source',
    'test',
    '--decay-after',
    '2000-01-01T00:00:00.000Z',
  ]);

  const result = await runCli(['decay', '--cwd', target, '--archive']);
  assert.match(result.stdout, /Archived 1 item/);

  const archiveDir = join(target, '.memspec', 'archive');
  const [entry] = await readdir(archiveDir);
  const archivedContent = await readText(join(archiveDir, entry));
  const archived = matter(archivedContent);
  assert.equal(archived.data.state, 'archived');
});

test('decay surfaces anchor drift but never archives drifted items', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'auth.py'), 'mockup\n');
  await runCli([
    'add', 'fact', 'Auth is a mockup', '--cwd', target,
    '--body', 'Needs real password verification', '--source', 'test',
  ]);

  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const [factEntry] = await readdir(factsDir);
  const id = factEntry.replace(/\.md$/, '');
  await runCli(['anchor', id, 'auth.py', '--cwd', target]);

  // No drift yet: clean store
  const clean = await runCli(['decay', '--cwd', target, '--dry-run']);
  assert.doesNotMatch(clean.stdout, /anchor drift/);

  // Code ships, anchored file changes
  await writeFile(join(target, 'auth.py'), 'real argon2id implementation\n');

  const dryRun = await runCli(['decay', '--cwd', target, '--dry-run']);
  assert.match(dryRun.stdout, /1 item\(s\) with anchor drift/);
  assert.match(dryRun.stdout, /auth\.py \(changed\)/);

  // A real decay run must NOT archive the drifted item
  await runCli(['decay', '--cwd', target]);
  assert.equal((await readdir(factsDir)).length, 1);
  assert.equal((await readdir(join(target, '.memspec', 'archive'))).length, 0);

  // status surfaces the drift too
  const status = await runCli(['status', '--cwd', target]);
  assert.match(status.stdout, /1 item\(s\) with anchor drift/);
});

test('expired items decay even when also anchored', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'lib.ts'), 'v1\n');
  await runCli([
    'add', 'fact', 'Expired anchored fact', '--cwd', target,
    '--body', 'Old knowledge', '--source', 'test',
    '--decay-after', '2000-01-01T00:00:00.000Z',
  ]);

  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const [factEntry] = await readdir(factsDir);
  const id = factEntry.replace(/\.md$/, '');
  await runCli(['anchor', id, 'lib.ts', '--cwd', target]);
  await writeFile(join(target, 'lib.ts'), 'v2\n');

  const result = await runCli(['decay', '--cwd', target]);
  assert.match(result.stdout, /Decayed 1 item/);
  assert.doesNotMatch(result.stdout, /anchor drift/);
  assert.equal((await readdir(factsDir)).length, 0);
});
