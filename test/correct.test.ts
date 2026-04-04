import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeTempProject, readText, runCli } from './helpers.js';

async function addAndGetId(target: string): Promise<string> {
  await runCli(['add', 'fact', 'Old auth', '--cwd', target, '--body', 'Uses JWT', '--source', 'test']);
  const entries = await readdir(join(target, '.memspec', 'memory', 'facts'));
  const content = await readText(join(target, '.memspec', 'memory', 'facts', entries[0]));
  return matter(content).data.id;
}

test('correct invalidates a memory item without replacement', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addAndGetId(target);

  const result = await runCli(['correct', id, '--reason', 'No longer true', '--cwd', target]);
  assert.match(result.stdout, /Invalidated/);

  const factEntries = await readdir(join(target, '.memspec', 'memory', 'facts'));
  assert.equal(factEntries.length, 0);

  const archiveEntries = await readdir(join(target, '.memspec', 'archive'));
  assert.equal(archiveEntries.length, 1);

  const content = await readText(join(target, '.memspec', 'archive', archiveEntries[0]));
  const parsed = matter(content);
  assert.equal(parsed.data.state, 'corrected');
});

test('correct with --replace creates a new active item and marks old as corrected', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addAndGetId(target);

  const result = await runCli([
    'correct', id,
    '--reason', 'Migrated to OAuth',
    '--replace', 'Now uses OAuth2 with PKCE',
    '--cwd', target,
    '--source', 'test',
  ]);
  assert.match(result.stdout, /Corrected/);

  const factEntries = await readdir(join(target, '.memspec', 'memory', 'facts'));
  assert.equal(factEntries.length, 1);

  const replacementContent = await readText(join(target, '.memspec', 'memory', 'facts', factEntries[0]));
  const replacement = matter(replacementContent);
  assert.equal(replacement.data.state, 'active');
  assert.equal(replacement.data.corrects, id);

  const archiveEntries = await readdir(join(target, '.memspec', 'archive'));
  assert.equal(archiveEntries.length, 1);

  const archivedContent = await readText(join(target, '.memspec', 'archive', archiveEntries[0]));
  const archived = matter(archivedContent);
  assert.equal(archived.data.state, 'corrected');
  assert.ok(archived.data.corrected_by);
});

test('correct fails on nonexistent ID', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  await assert.rejects(
    () => runCli(['correct', 'ms_NONEXISTENT0000000000000', '--reason', 'test', '--cwd', target]),
    (error: Error & { stderr?: string }) => {
      const output = `${error.message}\n${error.stderr ?? ''}`;
      assert.match(output, /not found/);
      return true;
    },
  );
});
