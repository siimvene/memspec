import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
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
