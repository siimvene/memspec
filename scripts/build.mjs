#!/usr/bin/env node
// Atomic build: compile into a fresh `dist.new`, then swap it into place with
// renames, so `dist/` is never absent or half-written for the seconds `tsc`
// takes to run. The old `clean && tsc` deleted `dist/` up front and rebuilt in
// place — fatal when `dist/` is a live MCP-server deployment (`memspec-mcp`
// resolves to `dist/mcp.js`): a starting server during the compile window found
// an empty or partial directory. Here the running server keeps reading the
// intact old `dist/` until the final rename flips it atomically.
//
// The swap window (rename dist → dist.old, dist.new → dist) is two syscalls, not
// seconds; a process already running has its JS loaded in memory and is
// unaffected, and a new process only ever sees a complete tree on either side.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repoRoot, 'dist');
const distNew = join(repoRoot, 'dist.new');
const distOld = join(repoRoot, 'dist.old');
const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

// Start from a clean staging dir; leftovers from an aborted run must not leak in.
rmSync(distNew, { recursive: true, force: true });
rmSync(distOld, { recursive: true, force: true });

// Compile into the staging dir instead of the live one.
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--outDir', distNew], {
  cwd: repoRoot,
  stdio: 'inherit',
});

// Executable bits on the entrypoints, set before the swap so the published tree
// is complete the instant it becomes `dist/`.
for (const f of ['cli.js', 'mcp.js']) {
  const p = join(distNew, f);
  if (existsSync(p)) chmodSync(p, 0o755);
}

// Swap: move the current dist aside, promote the new one, drop the old.
if (existsSync(dist)) renameSync(dist, distOld);
renameSync(distNew, dist);
rmSync(distOld, { recursive: true, force: true });

console.log('build: dist/ swapped in atomically');
