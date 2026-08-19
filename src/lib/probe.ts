import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { MemoryItem, ProbeWitness } from './types.js';

export interface ProbeRunResult {
  hash: string;   // sha256 of the command stdout
  stdout: string; // captured stdout (trailing whitespace trimmed)
}

export type ProbeCheckStatus = 'match' | 'drifted' | 'error';

export interface ProbeCheck extends Partial<ProbeRunResult> {
  status: ProbeCheckStatus;
  cmd: string;
  expected: string; // baselined hash
  error?: string;   // populated when status === 'error'
}

/**
 * sha256 (hex) of a command's stdout. Trailing whitespace is trimmed so a
 * probe is not marked drifted purely by a trailing-newline difference.
 */
export function hashProbeOutput(stdout: string): string {
  return createHash('sha256').update(stdout.replace(/\s+$/, '')).digest('hex');
}

/**
 * Execute a probe command and hash its stdout. This spawns a shell — callers
 * MUST only reach it from an explicit user/agent action (`memspec probe`,
 * `memspec verify`), never from a read path. Runs from `cwd` (the project
 * root) so relative paths in the command resolve as the author intended.
 */
export function runProbeCommand(cmd: string, cwd: string, timeoutMs = 30_000): ProbeRunResult {
  const raw = execSync(cmd, { cwd, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = raw.replace(/\s+$/, '');
  return { hash: hashProbeOutput(raw), stdout };
}

/**
 * Re-run a record's probe and compare against its stored hash. Non-mutating:
 * returns a status, never touches the record. A non-zero exit or spawn failure
 * is reported as `error` (not silently treated as a match).
 */
export function checkProbe(probe: ProbeWitness, cwd: string, timeoutMs = 30_000): ProbeCheck {
  try {
    const { hash, stdout } = runProbeCommand(probe.cmd, cwd, timeoutMs);
    return {
      status: hash === probe.hash ? 'match' : 'drifted',
      cmd: probe.cmd,
      expected: probe.hash,
      hash,
      stdout,
    };
  } catch (err) {
    return {
      status: 'error',
      cmd: probe.cmd,
      expected: probe.hash,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Read a record's probe leniently — undefined when absent or malformed. */
export function getProbe(item: MemoryItem): ProbeWitness | undefined {
  const probe = item.probe;
  if (probe && typeof probe.cmd === 'string' && typeof probe.hash === 'string') return probe;
  return undefined;
}
