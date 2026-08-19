import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { makeTempProject, REPO_ROOT } from './helpers.js';
// The hook is CommonJS; Node's ESM interop exposes its named export.
import { runClaimsCheck } from '../hooks/memspec-claims-check.js';

const execFileAsync = promisify(execFile);
const SCRIPT = join(REPO_ROOT, 'hooks', 'memspec-claims-check.js');

test('claims-check passes when npmrc, bunfig, and the session hook are all in place', async () => {
  const home = await makeTempProject();
  await writeFile(join(home, '.npmrc'), 'min-release-age=30d\n');
  await writeFile(join(home, '.bunfig.toml'), 'minimumReleaseAge = "30d"\n');
  await mkdir(join(home, '.claude', 'hooks'), { recursive: true });
  await writeFile(join(home, '.claude', 'hooks', 'memspec-session-start.js'), '// installed\n');

  const lines: string[] = runClaimsCheck(home);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.startsWith('PASS')), `expected all PASS, got:\n${lines.join('\n')}`);
});

test('claims-check warns on a bare home for the deterministic checks', async () => {
  const home = await makeTempProject();
  const lines: string[] = runClaimsCheck(home);

  const npmrc = lines.find((l) => l.includes('npmrc'));
  const hook = lines.find((l) => l.includes('session-hook'));
  assert.match(npmrc ?? '', /^WARN/, 'no ~/.npmrc must warn');
  assert.match(hook ?? '', /^WARN/, 'no installed session hook must warn');
});

test('claims-check accepts pnpm-style minimum-release-age too', async () => {
  const home = await makeTempProject();
  await writeFile(join(home, '.npmrc'), 'minimum-release-age=43200\n');
  const [npmrc] = runClaimsCheck(home);
  assert.match(npmrc, /^PASS npmrc/);
});

test('claims-check script exits 0 and prints PASS/WARN lines (never fails the boot)', async () => {
  const home = await makeTempProject();
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT], {
    env: { ...process.env, HOME: home },
  });
  assert.match(stdout, /memspec claims-check:/);
  assert.match(stdout, /^(PASS|WARN) /m);
});
