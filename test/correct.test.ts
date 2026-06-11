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

test('correct persists the reason to both records', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addAndGetId(target);

  await runCli([
    'correct', id,
    '--reason', 'Migrated to OAuth',
    '--replace', 'Now uses OAuth2 with PKCE',
    '--cwd', target,
    '--source', 'test',
  ]);

  const factEntries = await readdir(join(target, '.memspec', 'memory', 'facts'));
  const replacement = matter(await readText(join(target, '.memspec', 'memory', 'facts', factEntries[0])));
  assert.equal(replacement.data.correction_reason, 'Migrated to OAuth');

  const archiveEntries = await readdir(join(target, '.memspec', 'archive'));
  const archived = matter(await readText(join(target, '.memspec', 'archive', archiveEntries[0])));
  assert.equal(archived.data.correction_reason, 'Migrated to OAuth');
});

test('correct without replacement persists the reason on the archived record', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addAndGetId(target);

  await runCli(['correct', id, '--reason', 'No longer true', '--cwd', target]);

  const archiveEntries = await readdir(join(target, '.memspec', 'archive'));
  const archived = matter(await readText(join(target, '.memspec', 'archive', archiveEntries[0])));
  assert.equal(archived.data.correction_reason, 'No longer true');
});

test('correct resets the replacement decay clock to the type default', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli([
    'add', 'fact', 'Nearly expired', '--cwd', target,
    '--body', 'Old TTL', '--source', 'test',
    '--decay-after', '2030-01-01T00:00:00.000Z',
  ]);
  const entries = await readdir(join(target, '.memspec', 'memory', 'facts'));
  const id = matter(await readText(join(target, '.memspec', 'memory', 'facts', entries[0]))).data.id;

  await runCli([
    'correct', id,
    '--reason', 'stale', '--replace', 'Fresh knowledge',
    '--cwd', target, '--source', 'test',
  ]);

  const factEntries = await readdir(join(target, '.memspec', 'memory', 'facts'));
  const replacement = matter(await readText(join(target, '.memspec', 'memory', 'facts', factEntries[0])));

  // Default fact TTL is 90d from now — nowhere near the inherited 2030 date.
  const decayAfter = Date.parse(String(replacement.data.decay_after));
  const expected = Date.now() + 90 * 24 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(decayAfter - expected) < 2 * dayMs, 'decay clock should reset to the 90d fact default');
});

test('correct --title gives the replacement a fresh title', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addAndGetId(target);

  await runCli([
    'correct', id,
    '--reason', 'Migrated to OAuth',
    '--replace', 'Now uses OAuth2 with PKCE',
    '--title', 'Auth uses OAuth2 PKCE',
    '--cwd', target,
    '--source', 'test',
  ]);

  const factEntries = await readdir(join(target, '.memspec', 'memory', 'facts'));
  const content = await readText(join(target, '.memspec', 'memory', 'facts', factEntries[0]));
  assert.match(content, /# Auth uses OAuth2 PKCE/);
  assert.doesNotMatch(content, /# Old auth/);
});

test('correct --supersede-by merges into an existing memory instead of minting', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const loserId = await addAndGetId(target);
  await runCli(['add', 'fact', 'Auth survivor', '--cwd', target, '--body', 'OAuth2 PKCE', '--source', 'test']);

  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const entries = await readdir(factsDir);
  let survivorId = '';
  for (const entry of entries) {
    const parsed = matter(await readText(join(factsDir, entry)));
    if (parsed.data.id !== loserId) survivorId = parsed.data.id;
  }

  const result = await runCli([
    'correct', loserId,
    '--reason', 'Duplicate of survivor',
    '--supersede-by', survivorId,
    '--cwd', target,
  ]);
  assert.match(result.stdout, /Superseded/);
  assert.match(result.stdout, /merged into existing memory/);

  // No third record was minted: survivor stays, loser is archived.
  const remaining = await readdir(factsDir);
  assert.equal(remaining.length, 1);
  const survivor = matter(await readText(join(factsDir, remaining[0])));
  assert.equal(survivor.data.id, survivorId);
  assert.equal(survivor.data.state, 'active');

  const archiveEntries = await readdir(join(target, '.memspec', 'archive'));
  assert.equal(archiveEntries.length, 1);
  const archived = matter(await readText(join(target, '.memspec', 'archive', archiveEntries[0])));
  assert.equal(archived.data.state, 'corrected');
  assert.equal(archived.data.corrected_by, survivorId);
  assert.equal(archived.data.correction_reason, 'Duplicate of survivor');
});

test('correct rejects --replace combined with --supersede-by', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addAndGetId(target);

  await assert.rejects(
    () => runCli([
      'correct', id,
      '--reason', 'test',
      '--replace', 'new content',
      '--supersede-by', 'ms_00000000000000000000000000',
      '--cwd', target,
    ]),
    (error: Error & { stderr?: string }) => {
      assert.match(`${error.message}\n${error.stderr ?? ''}`, /mutually exclusive/);
      return true;
    },
  );
});

test('correct refuses operator-sourced records without --override-operator', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli(['add', 'fact', 'Operator truth', '--cwd', target, '--body', 'Stated by Siim', '--source', 'human:siim']);
  const entries = await readdir(join(target, '.memspec', 'memory', 'facts'));
  const id = matter(await readText(join(target, '.memspec', 'memory', 'facts', entries[0]))).data.id;

  await assert.rejects(
    () => runCli(['correct', id, '--reason', 'agent disagrees', '--cwd', target]),
    (error: Error & { stderr?: string }) => {
      assert.match(`${error.message}\n${error.stderr ?? ''}`, /--override-operator/);
      return true;
    },
  );

  // Untouched without the flag.
  const stillThere = await readdir(join(target, '.memspec', 'memory', 'facts'));
  assert.equal(stillThere.length, 1);

  // With the flag it proceeds, and the override is logged into the reason.
  await runCli(['correct', id, '--reason', 'confirmed with operator', '--override-operator', '--cwd', target]);
  const archiveEntries = await readdir(join(target, '.memspec', 'archive'));
  const archived = matter(await readText(join(target, '.memspec', 'archive', archiveEntries[0])));
  assert.equal(archived.data.state, 'corrected');
  assert.match(String(archived.data.correction_reason), /confirmed with operator/);
  assert.match(String(archived.data.correction_reason), /--override-operator used/);
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
