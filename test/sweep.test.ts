import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeTempProject, readText, REPO_ROOT, runCli } from './helpers.js';

async function setupStaleFact(target: string): Promise<void> {
  await runCli(['init', '--cwd', target]);
  await runCli([
    'add', 'fact', 'Old port', '--cwd', target,
    '--body', 'Service listens on 7779', '--source', 'test',
    '--decay-after', '2000-01-01T00:00:00.000Z',
  ]);
  await runCli(['decay', '--cwd', target]);
}

function runSweepWithInput(target: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(REPO_ROOT, 'src/cli.ts'), 'sweep', '--cwd', target],
      { cwd: REPO_ROOT, env: { ...process.env, TZ: 'UTC' } },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`sweep exited ${code}: ${stdout}`));
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

test('sweep --dry-run lists stale candidates without changes', async () => {
  const target = await makeTempProject();
  await setupStaleFact(target);

  const result = await runCli(['sweep', '--cwd', target, '--dry-run']);
  assert.match(result.stdout, /1 stale item\(s\) eligible for retirement/);
  assert.match(result.stdout, /Old port/);
  assert.match(result.stdout, /Dry run - no changes made/);

  assert.equal((await readdir(join(target, '.memspec', 'memory', 'facts'))).length, 1);
  assert.equal((await readdir(join(target, '.memspec', 'archive'))).length, 0);
});

test('sweep retires a stale item on confirmation', async () => {
  const target = await makeTempProject();
  await setupStaleFact(target);

  const stdout = await runSweepWithInput(target, 'y\n');
  assert.match(stdout, /Retired 1 of 1 stale item\(s\)/);

  assert.equal((await readdir(join(target, '.memspec', 'memory', 'facts'))).length, 0);
  const archiveEntries = await readdir(join(target, '.memspec', 'archive'));
  assert.equal(archiveEntries.length, 1);
  const archived = matter(await readText(join(target, '.memspec', 'archive', archiveEntries[0])));
  assert.equal(archived.data.state, 'archived');
});

test('sweep keeps items when declined', async () => {
  const target = await makeTempProject();
  await setupStaleFact(target);

  const stdout = await runSweepWithInput(target, 'n\n');
  assert.match(stdout, /Retired 0 of 1 stale item\(s\)/);
  assert.equal((await readdir(join(target, '.memspec', 'memory', 'facts'))).length, 1);
});

test('sweep reports when nothing is stale', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const result = await runCli(['sweep', '--cwd', target]);
  assert.match(result.stdout, /No stale items to sweep/);
});
