import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function makeTempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'memspec-'));
}

export async function runCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', ...args],
    {
      cwd,
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
