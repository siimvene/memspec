import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactSecrets, runDistill, runReduce } from '../src/commands/distill.js';
import { makeTempProject } from './helpers.js';

async function makeStore(): Promise<string> {
  const target = await makeTempProject();
  await mkdir(join(target, '.memspec'), { recursive: true });
  return target;
}

async function writeTrajectory(target: string, source: string, sessionId: string, realRecords: number): Promise<void> {
  const dir = join(target, '.memspec', 'local', 'trajectories', source);
  await mkdir(dir, { recursive: true });
  const records = [
    { role: 'meta', source, session_id: sessionId, cwd: '/proj', started_at: '2026-07-27T08:00:00Z', ended_at: '2026-07-27T09:00:00Z' },
    ...Array.from({ length: realRecords }, (_, i) => ({ role: 'user', text: `message ${i}` })),
  ];
  await writeFile(join(dir, `${sessionId}.json`), JSON.stringify({ schema: 'trajectory-v1', records }));
}

async function makeStubLlm(target: string, output: string): Promise<string> {
  const bin = join(target, 'stub-llm.sh');
  await writeFile(bin, `#!/bin/sh\ncat > /dev/null\nprintf '%s' "${output}"\n`);
  await chmod(bin, 0o755);
  return bin;
}

function withStub(bin: string, fn: () => void): void {
  process.env.MEMSPEC_DISTILL_BIN = bin;
  process.env.MEMSPEC_DISTILL_ARGS = '';
  try {
    fn();
  } finally {
    delete process.env.MEMSPEC_DISTILL_BIN;
    delete process.env.MEMSPEC_DISTILL_ARGS;
  }
}

test('distill: digests real sessions, skips tiny ones, watermarks both', async () => {
  const target = await makeStore();
  await writeTrajectory(target, 'claude-code', 'big-session', 10);
  await writeTrajectory(target, 'claude-code', 'tiny-session', 2);
  const stub = await makeStubLlm(target, '## WHAT HAPPENED\n- fixed the bug');

  withStub(stub, () => {
    const out = runDistill({ cwd: target });
    assert.match(out, /distilled 1, skipped 1, failed 0/);
  });

  const digest = await readFile(join(target, '.memspec', 'local', 'digests', 'claude-code', 'big-session.md'), 'utf8');
  assert.match(digest, /session: big-session/);
  assert.match(digest, /fixed the bug/);
  const digests = await readdir(join(target, '.memspec', 'local', 'digests', 'claude-code'));
  assert.deepEqual(digests, ['big-session.md']);

  // second run: everything watermarked
  withStub(stub, () => {
    assert.match(runDistill({ cwd: target }), /distilled 0, skipped 0, failed 0, up-to-date 2/);
  });
});

test('distill: failure counts, then gives up after 3 attempts', async () => {
  const target = await makeStore();
  await writeTrajectory(target, 'codex', 'sad-session', 10);
  const bad = join(target, 'bad-llm.sh');
  await writeFile(bad, '#!/bin/sh\nexit 1\n');
  await chmod(bad, 0o755);

  withStub(bad, () => {
    assert.match(runDistill({ cwd: target }), /failed 1/);
    assert.match(runDistill({ cwd: target }), /attempt 2\/3/);
    assert.match(runDistill({ cwd: target }), /attempt 3\/3/);
    assert.match(runDistill({ cwd: target }), /up-to-date 1/); // given up, not retried
  });
});

test('redactSecrets scrubs common credential shapes', () => {
  const dirty = [
    'key sk-abcdefghijklmnop1234 here',
    'gh token ghp_ABCDEFGHIJKLMNOPQRSTuvwx1234',
    'aws AKIAIOSFODNN7EXAMPLE',
    'password = "hunter2butlonger"',
  ].join('\n');
  const clean = redactSecrets(dirty);
  assert.ok(!clean.includes('sk-abcdefghijklmnop1234'));
  assert.ok(!clean.includes('ghp_ABCDEFGHIJKLMNOPQRST'));
  assert.ok(!clean.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!clean.includes('hunter2butlonger'));
  assert.match(clean, /\[REDACTED\]/);
});

test('reduce: merges fresh digests once, then no-ops; --force required within window', async () => {
  const target = await makeStore();
  await writeTrajectory(target, 'claude-code', 's1', 10);
  const stub = await makeStubLlm(target, '## WHAT HAPPENED\n- shipped feature X');
  withStub(stub, () => runDistill({ cwd: target }));

  const first = runReduce({ cwd: target, force: true });
  assert.match(first, /reduced 1 session digest\(s\)/);
  const outDir = join(target, '.memspec', 'digests');
  const files = await readdir(outDir);
  assert.equal(files.length, 1);
  const body = await readFile(join(outDir, files[0]), 'utf8');
  assert.match(body, /shipped feature X/);
  assert.match(body, /## \/proj/);

  // recent reduce + no new digests: both gates hold
  assert.match(runReduce({ cwd: target }), /nothing to do/);
  assert.match(runReduce({ cwd: target, force: true }), /no new session digests/);
});
