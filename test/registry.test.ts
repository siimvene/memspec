import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CompositeStore } from '../src/lib/composite-store.js';
import { findPointer, matchesClaim } from '../src/lib/registry.js';
import { runRemember } from '../src/commands/remember.js';
import { runDistill, runReduce } from '../src/commands/distill.js';
import { makeTempProject, runCli } from './helpers.js';

test('matchesClaim: exact prefix, single and double wildcards', () => {
  assert.ok(matchesClaim(['/work/kleidia'], '/work/kleidia'));
  assert.ok(matchesClaim(['/work/kleidia'], '/work/kleidia/src/deep'));
  assert.ok(!matchesClaim(['/work/kleidia'], '/work/kleidia-docs'));
  assert.ok(matchesClaim(['/work/plg/**'], '/work/plg/repo-a/nested'));
  assert.ok(matchesClaim(['/work/*/src'], '/work/anything/src/file.ts'));
  assert.ok(!matchesClaim(['/work/*/src'], '/work/a/b/src'));
  assert.ok(!matchesClaim([], '/anything'));
});

test('findPointer: pointer resolves, store dir closer to cwd wins', async () => {
  const repo = await makeTempProject();
  await writeFile(
    join(repo, '.memspec.yaml'),
    'stores:\n  - name: team\n    path: ./team-specs\n    priority: 10\n    writable: true\n'
  );
  await mkdir(join(repo, 'src'), { recursive: true });

  const hit = findPointer(join(repo, 'src'));
  assert.ok(hit);
  assert.equal(hit.dir, repo);
  assert.equal(hit.stores[0].name, 'team');

  // a real .memspec directory at the same level beats the pointer
  await mkdir(join(repo, '.memspec'), { recursive: true });
  assert.equal(findPointer(join(repo, 'src')), null);
});

test('pointer repo: reads fan out across layers, ambiguous writes refuse', async () => {
  const base = await makeTempProject();
  const teamRepo = join(base, 'team-specs');
  const personal = join(base, 'personal');
  const serviceRepo = join(base, 'service');
  for (const p of [teamRepo, personal, join(serviceRepo, 'src')]) await mkdir(p, { recursive: true });
  await runCli(['init', '--cwd', teamRepo, '--no-interactive', '--skip-patch', '--no-install-hooks']);
  await runCli(['init', '--cwd', personal, '--no-interactive', '--skip-patch', '--no-install-hooks']);
  await runCli(['remember', 'fact', 'Team fact about the service', '--cwd', teamRepo, '--source', 'test', '--body', 'x']);
  await runCli(['remember', 'fact', 'Personal incubation note', '--cwd', personal, '--source', 'test', '--body', 'y']);

  await writeFile(
    join(serviceRepo, '.memspec.yaml'),
    [
      'stores:',
      `  - name: team`,
      `    path: ${teamRepo}`,
      '    priority: 10',
      '    writable: true',
      `  - name: personal`,
      `    path: ${personal}`,
      '    priority: 0',
      '    writable: true',
    ].join('\n')
  );

  const composite = CompositeStore.forCwd(join(serviceRepo, 'src'));
  assert.equal(composite.layers.length, 2);
  assert.equal(composite.loadAll().length, 2);

  // ambiguous write: two writable layers, no --store
  assert.throws(
    () => runRemember('fact', 'Where do I go', { cwd: serviceRepo, source: 'test', body: 'z' }),
    /ambiguous write target.*--store/s
  );

  // explicit target routes to the named layer
  const result = runRemember('fact', 'Service deploy quirk', { cwd: serviceRepo, source: 'test', body: 'z', store: 'team' });
  assert.match(result.message, /Created fact/);
  const teamItems = CompositeStore.forCwd(teamRepo).loadAll();
  assert.ok(teamItems.some((i) => i.title.includes('Service deploy quirk')));
});

async function seedDigest(storeParent: string, sessionId: string, cwd: string): Promise<void> {
  const dir = join(storeParent, '.memspec', 'local', 'digests', 'claude-code');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${sessionId}.md`),
    `---\nsession: ${sessionId}\nsource: claude-code\ncwd: ${cwd}\nended: 2026-07-27T09:00:00Z\n---\n\n## WHAT HAPPENED\n- work in ${cwd}\n`
  );
}

test('reduce: routes digests by store claims, holds unclaimed local', async () => {
  const base = await makeTempProject();
  const home = join(base, 'home');
  const team = join(base, 'team');
  await mkdir(join(home, '.memspec'), { recursive: true });
  await mkdir(join(team, '.memspec'), { recursive: true });

  await writeFile(
    join(home, '.memspec', 'config.yaml'),
    `claims:\n  - ${base}/personal-stuff\nstores:\n  - name: team\n    path: ${team}\n    priority: 10\n    writable: true\n  - name: global\n    path: ${home}/.memspec\n    priority: 0\n    writable: true\n`
  );
  await writeFile(join(team, '.memspec', 'config.yaml'), `claims:\n  - ${base}/work/**\n`);

  await seedDigest(home, 's-work', `${base}/work/service-a`);
  await seedDigest(home, 's-personal', `${base}/personal-stuff/notes`);
  await seedDigest(home, 's-mystery', `${base}/somewhere-else`);

  const out = runReduce({ cwd: home, force: true });
  assert.match(out, /1 -> .*team.*digests/);
  assert.match(out, /1 -> .*home.*digests/);
  assert.match(out, /1 unclaimed session\(s\) held local/);

  // unclaimed stays uncovered: once a claim appears, it routes
  await writeFile(join(team, '.memspec', 'config.yaml'), `claims:\n  - ${base}/work/**\n  - ${base}/somewhere-else\n`);
  const second = runReduce({ cwd: home, force: true });
  assert.match(second, /1 -> .*team.*digests/);
  assert.ok(!second.includes('unclaimed'));
});

test('reduce: no claims anywhere keeps legacy single-store behaviour', async () => {
  const base = await makeTempProject();
  const home = join(base, 'home');
  await mkdir(join(home, '.memspec'), { recursive: true });
  await seedDigest(home, 's-1', `${base}/anywhere`);
  const out = runReduce({ cwd: home, force: true });
  assert.match(out, /1 -> .*home.*digests/);
  assert.ok(!out.includes('unclaimed'));
});
