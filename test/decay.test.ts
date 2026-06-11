import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeTempProject, readText, runCli } from './helpers.js';

// v0.3 retires the `memspec decay` write-side. Stale flagging is automatic at
// read time (`store.loadActive()` adds the flag lazily for items past
// `check_by`), and the CLI command is a read-only deprecation shim until the
// next release. Physical retirement is `memspec sweep`. These tests cover the
// new contract: lazy flagging, deprecation messaging, and `verify` clearing a
// persisted stale flag.

test('items past check_by surface as stale in search without an explicit decay run', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli([
    'add', 'procedure', 'Restart gateway', '--cwd', target,
    '--body', 'Run systemctl restart openclaw-gateway', '--source', 'test',
    '--decay-after', '2000-01-01T00:00:00.000Z',
  ]);

  // Search returns the item with stale=true because loadActive flags lazily.
  const search = await runCli(['search', 'gateway', '--cwd', target, '--json']);
  const results = JSON.parse(search.stdout);
  assert.equal(results.length, 1);
  assert.equal(results[0].stale, true);

  // The on-disk file is not mutated — flagging is a read-time concern.
  const proceduresDir = join(target, '.memspec', 'memory', 'procedures');
  const [entry] = await readdir(proceduresDir);
  const onDisk = matter(await readText(join(proceduresDir, entry)));
  assert.equal(onDisk.data.stale, undefined, 'lazy flag must not mutate the file');
});

test('decay CLI is deprecated in v0.3 and reports without mutating', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli([
    'add', 'fact', 'Old port', '--cwd', target,
    '--body', 'Service listens on 7779', '--source', 'test',
    '--decay-after', '2000-01-01T00:00:00.000Z',
  ]);

  const result = await runCli(['decay', '--cwd', target]);
  assert.match(result.stdout, /deprecated in v0\.3/);
  assert.match(result.stdout, /1 item\(s\) past TTL/);

  // No mutation on disk.
  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const [entry] = await readdir(factsDir);
  const onDisk = matter(await readText(join(factsDir, entry)));
  assert.equal(onDisk.data.stale, undefined);
});

test('verify clears a persisted stale flag', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli([
    'add', 'fact', 'Still true fact', '--cwd', target,
    '--body', 'Holds up', '--source', 'test',
    '--decay-after', '2000-01-01T00:00:00.000Z',
  ]);

  // Hand-persist `stale: true` to simulate a record carried over from a
  // previous sweep cycle or a v0.2 decay run.
  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const [entry] = await readdir(factsDir);
  const filePath = join(factsDir, entry);
  const raw = await readText(filePath);
  const parsed = matter(raw);
  parsed.data.stale = true;
  await writeFile(filePath, matter.stringify(parsed.content, parsed.data));

  const id = parsed.data.id;
  await runCli(['verify', id, '--cwd', target, '--evidence', 're-checked, still true']);

  const after = matter(await readText(filePath)).data;
  assert.equal(after.stale, undefined);
});

test('decay surfaces anchor drift in its deprecation report', async () => {
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

  // No drift yet.
  const clean = await runCli(['decay', '--cwd', target, '--dry-run']);
  assert.doesNotMatch(clean.stdout, /anchor drift/);

  // Code ships, anchored file changes.
  await writeFile(join(target, 'auth.py'), 'real argon2id implementation\n');

  const dryRun = await runCli(['decay', '--cwd', target, '--dry-run']);
  assert.match(dryRun.stdout, /1 item\(s\) with anchor drift/);
  assert.match(dryRun.stdout, /auth\.py \(changed\)/);

  // The drifted item stays in place — verify/supersede/anchor decide its fate.
  assert.equal((await readdir(factsDir)).length, 1);
  assert.equal((await readdir(join(target, '.memspec', 'archive'))).length, 0);

  // `memspec status` surfaces drift too.
  const status = await runCli(['status', '--cwd', target]);
  assert.match(status.stdout, /1 active item\(s\) with anchor drift/);
});

test('expired items remain in place even when also anchored', async () => {
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

  // Both expiry and drift surface; nothing gets archived.
  const result = await runCli(['decay', '--cwd', target]);
  assert.match(result.stdout, /past TTL/);
  assert.equal((await readdir(factsDir)).length, 1);
});
