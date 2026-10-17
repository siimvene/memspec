import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The Claude Code config directory: `$CLAUDE_CONFIG_DIR` when it is set and
 * non-empty, `~/.claude` otherwise. Claude Code reads settings and hooks from
 * this directory only, so anything memspec installs for it has to land here.
 * A leading `~` is expanded against `home`, which defaults to the OS home.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = env.CLAUDE_CONFIG_DIR?.trim();
  if (!raw) return join(home, '.claude');
  if (raw === '~') return resolve(home);
  if (raw.startsWith('~/')) return resolve(home, raw.slice(2));
  return resolve(raw);
}

/** True when `dir` is `~/.claude`, compared after resolving symlinks where both exist. */
export function isDefaultClaudeConfigDir(dir: string, home: string = homedir()): boolean {
  const fallback = join(home, '.claude');
  return canonical(dir) === canonical(fallback);
}

/** `realpath` when the path exists, else the resolved path. */
export function canonical(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) return resolved;
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** POSIX single-quote a string for a shell command line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
