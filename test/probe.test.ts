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

test('probe --set writes verified_with: probe — the entry point that actually ran the command', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Probed fact');
  await writeFile(join(target, 'services.txt'), 'a\nb\n');
  await runCli(['probe', id, '--cwd', target, '--set', 'grep -c . services.txt']);

  const data = matter(await readFile(factPath(target, id), 'utf8')).data;
  assert.equal(data.verified_with, 'probe');
});

test('verify never executes the probe and refuses an anchorless verify without evidence', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Probed but unexercised fact');
  await runCli(['probe', id, '--cwd', target, '--set', 'sh -c "echo v >> verify-ran.log; echo stable"']);
  const logPath = join(target, 'verify-ran.log');
  const runsAfterSet = (await readFile(logPath, 'utf8')).trim().split('\n').length;

  // Anchorless + no evidence: the unexercised probe is not a witness — refuse,
  // pointing at `memspec probe`.
  await assert.rejects(
    () => runCli(['verify', id, '--cwd', target]),
    (err: Error & { stderr?: string; stdout?: string }) => {
      assert.match((err.stderr ?? '') + (err.stdout ?? ''), /exercise it with `memspec probe/);
      return true;
    },
  );

  // With evidence the verify passes — as evidence, not as a probe witness, and
  // still without running the command.
  const res = await runCli(['verify', id, '--cwd', target, '--evidence', 'checked by hand']);
  assert.match(res.stdout, /verified_with: evidence/);
  assert.match(res.stdout, /probe present, not exercised/);

  const runsAfterVerify = (await readFile(logPath, 'utf8')).trim().split('\n').length;
  assert.equal(runsAfterVerify, runsAfterSet, 'verify must never execute a probe command');
});

test('a stored probe from synced content does not run until trusted on this machine', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Synced probed fact');
  await runCli(['probe', id, '--cwd', target, '--set', 'sh -c "echo x >> trust-ran.log; echo stable"']);
  const logPath = join(target, 'trust-ran.log');
  const runsAfterSet = (await readFile(logPath, 'utf8')).trim().split('\n').length;

  // Simulate arrival on a fresh machine: the trustfile does not sync.
  const trustfile = join(target, '.memspec', '.probe-trust.json');
  assert.ok(existsSync(trustfile), '--set records trust in the machine-local trustfile');
  await writeFile(trustfile, '{"trusted":[]}\n');

  const untrusted = await runCli(['probe', id, '--cwd', target]).catch((err) => err);
  assert.match(untrusted.stdout ?? '', /PROBE UNTRUSTED/);
  const runsAfterUntrusted = (await readFile(logPath, 'utf8')).trim().split('\n').length;
  assert.equal(runsAfterUntrusted, runsAfterSet, 'an untrusted stored command must not execute');

  // Explicit --trust is the consent path: approves, then runs.
  const trusted = await runCli(['probe', id, '--cwd', target, '--trust']);
  assert.match(trusted.stdout, /PROBE OK/);
  const runsAfterTrust = (await readFile(logPath, 'utf8')).trim().split('\n').length;
  assert.equal(runsAfterTrust, runsAfterSet + 1);

  // The trustfile must never sync: the store's .gitignore carries it.
  const gitignore = await readFile(join(target, '.memspec', '.gitignore'), 'utf8');
  assert.ok(gitignore.split('\n').some((l) => l.trim() === '.probe-trust.json'));
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
