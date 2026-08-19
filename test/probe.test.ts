import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeTempProject, runCli } from './helpers.js';

async function addFact(target: string, title: string): Promise<string> {
  await runCli(['remember', 'fact', title, '--cwd', target, '--body', 'Body', '--source', 'test']);
  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const entries = await readdir(factsDir);
  return entries[entries.length - 1].replace(/\.md$/, '');
}

function factPath(target: string, id: string): string {
  return join(target, '.memspec', 'memory', 'facts', `${id}.md`);
}

test('probe --set baselines a command and stores cmd + output hash', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Config has three services');
  await writeFile(join(target, 'services.txt'), 'a\nb\nc\n');

  const res = await runCli(['probe', id, '--cwd', target, '--set', 'grep -c . services.txt']);
  assert.match(res.stdout, /Probe set/);

  const data = matter(await readFile(factPath(target, id), 'utf8')).data;
  assert.equal(data.probe.cmd, 'grep -c . services.txt');
  assert.match(String(data.probe.hash), /^[0-9a-f]{64}$/);
});

test('probe re-run reports OK when output is unchanged and DRIFTED when it changes', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Service count');
  await writeFile(join(target, 'services.txt'), 'a\nb\nc\n');
  await runCli(['probe', id, '--cwd', target, '--set', 'grep -c . services.txt']);

  const ok = await runCli(['probe', id, '--cwd', target]);
  assert.match(ok.stdout, /PROBE OK/);

  // Change the underlying reality — the probe output now differs.
  await writeFile(join(target, 'services.txt'), 'a\nb\nc\nd\n');
  await assert.rejects(
    () => runCli(['probe', id, '--cwd', target]),
    (err: Error & { stdout?: string; code?: number }) => {
      assert.match(err.stdout ?? '', /PROBE DRIFTED/);
      assert.equal(err.code, 1, 'drift exits non-zero');
      return true;
    },
  );
});

test('verify accepts a probe as the mechanical witness and refreshes with verified_with: probe', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Probed fact');
  await writeFile(join(target, 'services.txt'), 'a\nb\n');
  await runCli(['probe', id, '--cwd', target, '--set', 'grep -c . services.txt']);

  // No --evidence, no anchors — the probe alone is the witness.
  const res = await runCli(['verify', id, '--cwd', target]);
  assert.match(res.stdout, /Verified/);
  assert.match(res.stdout, /verified_with: probe/);

  const data = matter(await readFile(factPath(target, id), 'utf8')).data;
  assert.equal(data.verified_with, 'probe');
});

test('verify returns needs_review when the probe has drifted, leaving the memory untouched', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Drifting probed fact');
  await writeFile(join(target, 'services.txt'), 'a\nb\n');
  await runCli(['probe', id, '--cwd', target, '--set', 'grep -c . services.txt']);
  const before = await readFile(factPath(target, id), 'utf8');

  await writeFile(join(target, 'services.txt'), 'a\nb\nc\n');
  await assert.rejects(
    () => runCli(['verify', id, '--cwd', target]),
    (err: Error & { stdout?: string; code?: number }) => {
      assert.match(err.stdout ?? '', /NEEDS REVIEW/);
      assert.match(err.stdout ?? '', /probe drifted/);
      return true;
    },
  );
  assert.equal(await readFile(factPath(target, id), 'utf8'), before, 'drifted verify must not mutate the file');
});

test('read paths (search / status / context) never execute the probe command', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Side-effecting probe');

  // Baseline a probe with a side effect: it appends a line to ran.log. --set
  // runs it exactly once.
  await runCli(['probe', id, '--cwd', target, '--set', 'sh -c "echo x >> ran.log; echo stable"']);
  const logPath = join(target, 'ran.log');
  assert.ok(existsSync(logPath));
  const afterSet = (await readFile(logPath, 'utf8')).trim().split('\n').length;
  assert.equal(afterSet, 1, 'baseline runs the probe once');

  // Every read path must leave the probe un-run.
  await runCli(['search', 'probe', '--cwd', target]);
  await runCli(['status', '--cwd', target]);
  await runCli(['context', '--cwd', target]);

  const afterReads = (await readFile(logPath, 'utf8')).trim().split('\n').length;
  assert.equal(afterReads, 1, 'no read path may auto-execute a probe (they run shell commands)');
});
