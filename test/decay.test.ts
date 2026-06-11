import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeTempProject, readText, runCli } from './helpers.js';

test('decay flags expired items stale instead of archiving', async () => {
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
  assert.match(result.stdout, /Flagged 1 item\(s\) stale/);
  assert.match(result.stdout, /memspec sweep/);

  // Flag, not delete: the item stays active in place, nothing is archived.
  const proceduresDir = join(target, '.memspec', 'memory', 'procedures');
  const entries = await readdir(proceduresDir);
  assert.equal(entries.length, 1);

  const flagged = matter(await readText(join(proceduresDir, entries[0])));
  assert.equal(flagged.data.state, 'active');
  assert.equal(flagged.data.stale, true);

  assert.equal((await readdir(join(target, '.memspec', 'archive'))).length, 0);

  // Search still returns it, carrying the stale flag.
  const search = await runCli(['search', 'gateway', '--cwd', target, '--json']);
  const results = JSON.parse(search.stdout);
  assert.equal(results.length, 1);
  assert.equal(results[0].stale, true);
});

test('decay is idempotent on already-flagged items', async () => {
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

  await runCli(['decay', '--cwd', target]);
  const second = await runCli(['decay', '--cwd', target]);
  assert.match(second.stdout, /Flagged 0 item\(s\) stale/);
  assert.match(second.stdout, /1 item\(s\) were already flagged/);
});

test('verify clears the stale flag', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli([
    'add', 'fact', 'Still true fact', '--cwd', target,
    '--body', 'Holds up', '--source', 'test',
    '--decay-after', '2000-01-01T00:00:00.000Z',
  ]);
  await runCli(['decay', '--cwd', target]);

  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const [entry] = await readdir(factsDir);
  const id = entry.replace(/\.md$/, '');
  assert.equal(matter(await readText(join(factsDir, entry))).data.stale, true);

  await runCli(['verify', id, '--cwd', target, '--evidence', 're-checked, still true']);
  const after = matter(await readText(join(factsDir, entry))).data;
  assert.equal(after.stale, undefined);
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

test('expired items are flagged even when also anchored', async () => {
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
  assert.match(result.stdout, /Flagged 1 item\(s\) stale/);
  assert.doesNotMatch(result.stdout, /anchor drift/);
  assert.equal((await readdir(factsDir)).length, 1);
});
