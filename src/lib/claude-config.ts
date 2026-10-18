import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * The Claude Code config directory: `$CLAUDE_CONFIG_DIR` when it is set and
 * non-empty, `~/.claude` otherwise. Claude Code reads settings and hooks from
 * this directory only, so anything memspec installs for it has to land here.
 * Claude Code takes the value as written (no `~` or `$HOME` expansion in a
 * settings file) and needs it absolute, so a non-absolute value is reported
 * through `claudeConfigDirProblem` rather than resolved here.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = env.CLAUDE_CONFIG_DIR?.trim();
  if (!raw || !isAbsolute(raw)) return join(home, '.claude');
  return resolve(raw);
}

/** Why `CLAUDE_CONFIG_DIR` cannot be used, or undefined when it is unset or absolute. */
export function claudeConfigDirProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.CLAUDE_CONFIG_DIR?.trim();
  if (!raw || isAbsolute(raw)) return undefined;
  return `CLAUDE_CONFIG_DIR is "${raw}", which is not an absolute path; Claude Code does not expand ~ or resolve it, so set the full path`;
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
