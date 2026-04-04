import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');

export async function makeTempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'memspec-'));
}

export async function runCli(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ['--import', 'tsx', join(REPO_ROOT, 'src/cli.ts'), ...args],
    {
      cwd: cwd ?? REPO_ROOT,
      env: {
        ...process.env,
        TZ: 'UTC',
      },
    },
  );
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}
