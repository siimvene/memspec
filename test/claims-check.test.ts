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
// The fixture home decides everything: never read the developer's own
// CLAUDE_CONFIG_DIR (sessions run under one, and it holds a real hook).
const NO_CONFIG_DIR: NodeJS.ProcessEnv = {};

test('claims-check passes when npmrc, bunfig, and the session hook are all in place', async () => {
  const home = await makeTempProject();
  await writeFile(join(home, '.npmrc'), 'min-release-age=30d\n');
  await writeFile(join(home, '.bunfig.toml'), 'minimumReleaseAge = "30d"\n');
  await mkdir(join(home, '.claude', 'hooks'), { recursive: true });
  await writeFile(join(home, '.claude', 'hooks', 'memspec-session-start.js'), '// installed\n');

  const lines: string[] = runClaimsCheck(home, NO_CONFIG_DIR);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.startsWith('PASS')), `expected all PASS, got:\n${lines.join('\n')}`);
});

test('claims-check warns on a bare home for the deterministic checks', async () => {
  const home = await makeTempProject();
  const lines: string[] = runClaimsCheck(home, NO_CONFIG_DIR);

  const npmrc = lines.find((l) => l.includes('npmrc'));
  const hook = lines.find((l) => l.includes('session-hook'));
  assert.match(npmrc ?? '', /^WARN/, 'no ~/.npmrc must warn');
  assert.match(hook ?? '', /^WARN/, 'no installed session hook must warn');
});

test('claims-check accepts pnpm-style minimum-release-age too', async () => {
  const home = await makeTempProject();
  await writeFile(join(home, '.npmrc'), 'minimum-release-age=43200\n');
  const [npmrc] = runClaimsCheck(home, NO_CONFIG_DIR);
  assert.match(npmrc, /^PASS npmrc/);
});

test('claims-check script exits 0 and prints PASS/WARN lines (never fails the boot)', async () => {
  const home = await makeTempProject();
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT], {
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '' },
  });
  assert.match(stdout, /memspec claims-check:/);
  assert.match(stdout, /^(PASS|WARN) /m);
});

test('claims-check looks for the session hook in CLAUDE_CONFIG_DIR when it is set', async () => {
  const home = await makeTempProject();
  const cfg = join(home, 'cfg dir');
  // A hook under ~/.claude does not count when sessions read another directory.
  await mkdir(join(home, '.claude', 'hooks'), { recursive: true });
  await writeFile(join(home, '.claude', 'hooks', 'memspec-session-start.js'), '// installed\n');
  await mkdir(cfg, { recursive: true });

  const missing = runClaimsCheck(home, { CLAUDE_CONFIG_DIR: cfg }).find((l) => l.includes('session-hook'));
  assert.match(missing ?? '', /^WARN .*not found under .*cfg dir/);

  await mkdir(join(cfg, 'hooks'), { recursive: true });
  await writeFile(join(cfg, 'hooks', 'memspec-session-start.js'), '// installed\n');
  const found = runClaimsCheck(home, { CLAUDE_CONFIG_DIR: cfg }).find((l) => l.includes('session-hook'));
  assert.match(found ?? '', /^PASS .*cfg dir\/hooks/);
});

test('claims-check warns on a CLAUDE_CONFIG_DIR that is not absolute', async () => {
  const home = await makeTempProject();
  await mkdir(join(home, '.claude-alt', 'hooks'), { recursive: true });
  await writeFile(join(home, '.claude-alt', 'hooks', 'memspec-session-start.js'), '// installed\n');
  const line = runClaimsCheck(home, { CLAUDE_CONFIG_DIR: '~/.claude-alt' }).find((l) => l.includes('session-hook'));
  assert.match(line ?? '', /^WARN .*not an absolute path/);
});
