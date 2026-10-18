import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');

// A path that does not exist, under a directory this process just created
// (mode 0700, unique name), so no other process or earlier run can plant a
// config there for init to write into.
const NO_CLAUDE_CONFIG_DIR = join(mkdtempSync(join(tmpdir(), 'memspec-test-')), 'no-claude-config');

export async function makeTempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'memspec-'));
}

export async function runCli(
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ['--import', 'tsx', join(REPO_ROOT, 'src/cli.ts'), ...args],
    {
      cwd: cwd ?? REPO_ROOT,
      env: {
        ...process.env,
        TZ: 'UTC',
        // init installs Claude Code hooks into CLAUDE_CONFIG_DIR. Point it at a
        // directory that does not exist so a test run never writes into the
        // developer's real config (hook install is skipped); a test that wants
        // the install passes its own CLAUDE_CONFIG_DIR and HOME.
        CLAUDE_CONFIG_DIR: NO_CLAUDE_CONFIG_DIR,
        // Overrides land last so a test can redirect HOME — and with it the
        // `--store global` target — away from the operator's real store.
        ...env,
      },
    },
  );
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}
