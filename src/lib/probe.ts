import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
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
 *
 * Execution policy: probe commands run ONLY from the explicit `memspec probe`
 * CLI entry point, and a stored command must be trusted on this machine first
 * (see trustfile below). verify never executes probes; no read path does.
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

// ---------------------------------------------------------------------------
// Probe trust — machine-local consent for stored commands.
//
// Records travel (git sync, MCP writes), so a stored `probe.cmd` is untrusted
// content: executing it on the strength of the record alone would let a synced
// record run arbitrary shell on this machine. The trustfile records which exact
// command strings THIS machine has approved. It is machine-local by design:
// never synced (ensured via the store's .gitignore), keyed by sha256 of the
// exact command string, so any edit to a trusted command revokes its trust.
// Consent enters in exactly two ways: the user types the command (`--set`),
// or the user re-runs with `--trust` after seeing the command printed.
// ---------------------------------------------------------------------------

const TRUSTFILE = '.probe-trust.json';

export function hashProbeCommand(cmd: string): string {
  return createHash('sha256').update(cmd).digest('hex');
}

function readTrustfile(storeRoot: string): string[] {
  const path = join(storeRoot, TRUSTFILE);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed?.trusted) ? parsed.trusted.filter((h: unknown) => typeof h === 'string') : [];
  } catch {
    return []; // unreadable trustfile = nothing trusted; fail closed
  }
}

export function isProbeTrusted(storeRoot: string, cmd: string): boolean {
  return readTrustfile(storeRoot).includes(hashProbeCommand(cmd));
}

/**
 * Record this machine's consent to run `cmd`. Also ensures the trustfile is
 * gitignored in the store so consent never syncs to another machine.
 */
export function trustProbeCommand(storeRoot: string, cmd: string): void {
  const trusted = new Set(readTrustfile(storeRoot));
  trusted.add(hashProbeCommand(cmd));
  writeFileSync(join(storeRoot, TRUSTFILE), JSON.stringify({ trusted: [...trusted] }, null, 2) + '\n');
  const gitignore = join(storeRoot, '.gitignore');
  const line = TRUSTFILE;
  const existing = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  if (!existing.split('\n').some((l) => l.trim() === line)) {
    appendFileSync(gitignore, (existing.endsWith('\n') || existing === '' ? '' : '\n') + line + '\n');
  }
}
